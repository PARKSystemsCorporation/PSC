"""
Gemma Theia IDE - LLM Agent Server
====================================
FastAPI server that proxies requests to llama.cpp or vLLM backends,
providing a unified OpenAI-compatible API for the Theia IDE extensions.
"""

import asyncio
import json
import os
import subprocess
import time
from contextlib import asynccontextmanager
from enum import Enum
from pathlib import Path
from typing import Any, AsyncIterator, Optional

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
from model_manager import GEMMA4_MODELS, get_model_path, list_available_models, list_local_gguf_models, recommend_model, verify_gpu, download_model


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def load_config() -> dict:
    config_path = os.environ.get("CONFIG_PATH", "/app/config.yaml")
    if os.path.exists(config_path):
        with open(config_path) as f:
            return yaml.safe_load(f)
    # Fallback defaults
    return {
        "server": {"host": "0.0.0.0", "port": 8000, "cors_origins": ["*"]},
        "backend": "llamacpp",
        "llamacpp": {"server_url": "http://llama-server:8080"},
        "vllm": {"server_url": "http://vllm-server:8000", "model_name": "google/gemma-4-12b-it"},
        "agent": {
            "chat_system_prompt": "You are Gemma, an expert AI coding assistant.",
            "completion_system_prompt": "You are a code completion engine.",
            "terminal_system_prompt": "You are an autonomous terminal agent.",
            "max_tokens": {"chat": 4096, "completion": 256, "terminal": 2048},
        },
    }


CONFIG = load_config()
BACKEND = CONFIG.get("backend", "llamacpp")
PROJECT_DIR = Path(os.environ.get("PROJECT_DIR", "/workspace/project"))
ENV_FILE = Path(os.environ.get("ENV_FILE", PROJECT_DIR / ".env"))
COMPOSE_FILE = Path(os.environ.get("COMPOSE_FILE", PROJECT_DIR / "docker-compose.yml"))

# HTTP client for backend communication
http_client: Optional[httpx.AsyncClient] = None
download_state: dict[str, Any] = {
    "status": "idle",
    "model": None,
    "error": None,
    "started_at": None,
    "finished_at": None,
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))
    print(f"[LLM Server] Started with backend: {BACKEND}")
    yield
    await http_client.aclose()


app = FastAPI(
    title="Gemma Theia IDE - LLM Agent Server",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CONFIG["server"].get("cors_origins", ["*"]),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class AgentMode(str, Enum):
    CHAT = "chat"
    COMPLETION = "completion"
    TERMINAL = "terminal"
    REFACTOR = "refactor"


class Message(BaseModel):
    role: str = Field(..., description="Role: system, user, or assistant")
    content: str = Field(..., description="Message content")


class ChatRequest(BaseModel):
    messages: list[Message]
    mode: AgentMode = AgentMode.CHAT
    stream: bool = True
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    stop: Optional[list[str]] = None


class CompletionRequest(BaseModel):
    prefix: str = Field(..., description="Code before cursor")
    suffix: str = Field("", description="Code after cursor")
    language: str = Field("", description="Programming language")
    max_tokens: int = 256
    temperature: float = 0.2


class TerminalRequest(BaseModel):
    task: str = Field(..., description="Task description for the agent")
    context: str = Field("", description="Current working directory and environment context")
    history: list[Message] = Field(default_factory=list)
    stream: bool = True


class RefactorRequest(BaseModel):
    code: str = Field(..., description="Code to refactor")
    operation: str = Field(..., description="Refactor operation name")
    language: str = Field("", description="Programming language")
    selection: Optional[str] = Field(None, description="Selected text for targeted refactoring")
    instructions: str = Field("", description="Additional refactoring instructions")


class HealthResponse(BaseModel):
    status: str
    backend: str
    model: str
    uptime: float


class SetupRequest(BaseModel):
    model: str = Field(..., description="Model key from model manager")
    hf_token: Optional[str] = Field(None, description="Optional HuggingFace token")


class LocalModelSetupRequest(BaseModel):
    filename: str = Field(..., description="GGUF filename already present in the models directory")


class SetupStatusResponse(BaseModel):
    configured: bool
    backend: str
    desired_model: str
    recommended_model: str
    models_dir: str
    host_models_dir: str
    backend_ready: bool
    gpu: dict[str, Any]
    models: list[dict[str, Any]]
    local_models: list[dict[str, Any]]
    download: dict[str, Any]


# ---------------------------------------------------------------------------
# Backend communication
# ---------------------------------------------------------------------------

START_TIME = time.time()


def _get_backend_url() -> str:
    if _get_desired_backend() == "vllm":
        return CONFIG["vllm"]["server_url"]
    return CONFIG["llamacpp"]["server_url"]


def _read_env_file() -> dict[str, str]:
    if not ENV_FILE.exists():
        return {}

    entries: dict[str, str] = {}
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        entries[key.strip()] = value.strip()
    return entries


def _write_env_updates(updates: dict[str, str]) -> None:
    lines: list[str] = []
    existing = ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []
    remaining = dict(updates)

    for raw_line in existing:
        stripped = raw_line.strip()
        if stripped and not stripped.startswith("#") and "=" in raw_line:
            key = raw_line.split("=", 1)[0].strip()
            if key in remaining:
                lines.append(f"{key}={remaining.pop(key)}")
                continue
        lines.append(raw_line)

    for key, value in remaining.items():
        lines.append(f"{key}={value}")

    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _get_desired_backend() -> str:
    return _read_env_file().get("LLM_BACKEND", BACKEND)


def _get_hf_token(provided_token: Optional[str] = None) -> Optional[str]:
    if provided_token and provided_token.strip():
        return provided_token.strip()
    env_token = _read_env_file().get("HF_TOKEN") or os.environ.get("HF_TOKEN")
    return env_token.strip() if env_token else None


def _get_desired_model_key() -> str:
    env_values = _read_env_file()
    desired_filename = env_values.get("GEMMA_MODEL")
    if desired_filename:
        for name, info in GEMMA4_MODELS.items():
            if info.get("filename") == desired_filename:
                return name
    return recommend_model()


def _is_model_configured() -> bool:
    model_key = _get_desired_model_key()
    return get_model_path(model_key) is not None


def _is_local_model_configured() -> bool:
    desired_filename = _read_env_file().get("GEMMA_MODEL")
    if not desired_filename:
        return False
    return (Path(os.environ.get("MODELS_DIR", "/models")) / desired_filename).exists()


def _compose_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    commands = [
        ["docker", "compose", "-f", str(COMPOSE_FILE), *args],
        ["docker-compose", "-f", str(COMPOSE_FILE), *args],
    ]

    for command in commands:
        try:
            return subprocess.run(
                command,
                cwd=str(PROJECT_DIR),
                text=True,
                capture_output=True,
                check=True,
            )
        except FileNotFoundError:
            continue
        except subprocess.CalledProcessError as error:
            raise RuntimeError(error.stderr or error.stdout or str(error)) from error

    raise RuntimeError("Docker Compose is not available inside the LLM service container.")


def _restart_llama_service() -> None:
    _compose_command(["up", "-d", "--force-recreate", "llama-server"])


def _build_setup_status(backend_ready: bool) -> SetupStatusResponse:
    desired_model = _get_desired_model_key()
    return SetupStatusResponse(
        configured=_is_model_configured() or _is_local_model_configured(),
        backend=_get_desired_backend(),
        desired_model=desired_model,
        recommended_model=recommend_model(),
        models_dir=str(Path(os.environ.get("MODELS_DIR", "/models"))),
        host_models_dir=str(PROJECT_DIR / "models"),
        backend_ready=backend_ready,
        gpu=verify_gpu(),
        models=list_available_models(),
        local_models=list_local_gguf_models(),
        download=download_state,
    )


def _get_model_name() -> str:
    if _get_desired_backend() == "vllm":
        return CONFIG["vllm"].get("model_name", "google/gemma-4-12b-it")
    return _get_desired_model_key()


def _build_system_prompt(mode: AgentMode) -> str:
    agent_cfg = CONFIG.get("agent", {})
    prompts = {
        AgentMode.CHAT: agent_cfg.get("chat_system_prompt", "You are a coding assistant."),
        AgentMode.COMPLETION: agent_cfg.get("completion_system_prompt", "Complete the code."),
        AgentMode.TERMINAL: agent_cfg.get("terminal_system_prompt", "You are a terminal agent."),
        AgentMode.REFACTOR: "You are an expert code refactoring assistant. Return ONLY the refactored code.",
    }
    return prompts.get(mode, prompts[AgentMode.CHAT])


def _get_max_tokens(mode: AgentMode, override: Optional[int] = None) -> int:
    if override:
        return override
    defaults = CONFIG.get("agent", {}).get("max_tokens", {})
    return defaults.get(mode.value, 4096)


async def _stream_backend(payload: dict) -> AsyncIterator[str]:
    """Stream completions from the backend (llama.cpp or vLLM OpenAI-compat endpoint)."""
    url = f"{_get_backend_url()}/v1/chat/completions"
    payload["stream"] = True
    payload["model"] = _get_model_name()

    async with http_client.stream("POST", url, json=payload, timeout=120.0) as resp:
        if resp.status_code != 200:
            body = await resp.aread()
            raise HTTPException(status_code=resp.status_code, detail=body.decode())

        async for line in resp.aiter_lines():
            if line.startswith("data: "):
                data = line[6:]
                if data.strip() == "[DONE]":
                    yield "data: [DONE]\n\n"
                    return
                try:
                    chunk = json.loads(data)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield f"data: {json.dumps({'content': content})}\n\n"
                except json.JSONDecodeError:
                    continue


async def _complete_backend(payload: dict) -> str:
    """Non-streaming completion from backend."""
    url = f"{_get_backend_url()}/v1/chat/completions"
    payload["stream"] = False
    payload["model"] = _get_model_name()

    resp = await http_client.post(url, json=payload, timeout=120.0)
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    data = resp.json()
    return data["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Check server and backend health."""
    backend_ok = False
    try:
        resp = await http_client.get(f"{_get_backend_url()}/health", timeout=5.0)
        backend_ok = resp.status_code == 200
    except Exception:
        pass

    return HealthResponse(
        status="ok" if backend_ok else "degraded",
        backend=_get_desired_backend(),
        model=_get_model_name(),
        uptime=time.time() - START_TIME,
    )


@app.get("/api/setup/status", response_model=SetupStatusResponse)
async def setup_status():
    backend_ok = False
    try:
        resp = await http_client.get(f"{_get_backend_url()}/health", timeout=5.0)
        backend_ok = resp.status_code == 200
    except Exception:
        pass
    return _build_setup_status(backend_ok)


@app.post("/api/setup/download-and-configure")
async def download_and_configure(request: SetupRequest):
    if request.model not in GEMMA4_MODELS:
        raise HTTPException(status_code=404, detail="Unknown model")

    model_info = GEMMA4_MODELS[request.model]
    if model_info["format"] != "gguf":
        raise HTTPException(status_code=400, detail="Only GGUF llama.cpp models can be configured in-app right now.")

    if download_state["status"] == "running":
        raise HTTPException(status_code=409, detail="A model download is already in progress.")

    download_state.update({
        "status": "running",
        "model": request.model,
        "error": None,
        "started_at": time.time(),
        "finished_at": None,
    })

    async def run_setup_job() -> None:
        try:
            hf_token = _get_hf_token(request.hf_token)
            await asyncio.to_thread(download_model, request.model, hf_token)
            if hf_token:
                _write_env_updates({
                    "HF_TOKEN": hf_token,
                })
            _write_env_updates({
                "LLM_BACKEND": "llamacpp",
                "GEMMA_MODEL": model_info["filename"],
            })
            await asyncio.to_thread(_restart_llama_service)
            download_state.update({
                "status": "completed",
                "model": request.model,
                "error": None,
                "finished_at": time.time(),
            })
        except Exception as error:
            error_message = str(error)
            if "401" in error_message or "Repository Not Found" in error_message:
                error_message = (
                    "Download failed with 401 from Hugging Face. "
                    "This model likely requires a Hugging Face token with access to the repo. "
                    "Paste a token into the setup panel and try again."
                )
            download_state.update({
                "status": "error",
                "model": request.model,
                "error": error_message,
                "finished_at": time.time(),
            })

    asyncio.create_task(run_setup_job())
    return {"accepted": True, "model": request.model}


@app.post("/api/setup/configure-local-model")
async def configure_local_model(request: LocalModelSetupRequest):
    target_name = Path(request.filename).name
    target_path = Path(os.environ.get("MODELS_DIR", "/models")) / target_name
    if not target_path.exists() or target_path.suffix.lower() != ".gguf":
        raise HTTPException(status_code=404, detail="Local GGUF file not found")

    _write_env_updates({
        "LLM_BACKEND": "llamacpp",
        "GEMMA_MODEL": target_name,
    })
    await asyncio.to_thread(_restart_llama_service)
    return {"configured": True, "filename": target_name}


@app.post("/api/setup/upload-local-model")
async def upload_local_model(file: UploadFile = File(...)):
    filename = Path(file.filename or "").name
    if not filename or not filename.lower().endswith(".gguf"):
        raise HTTPException(status_code=400, detail="Please upload a .gguf model file")

    models_dir = Path(os.environ.get("MODELS_DIR", "/models"))
    models_dir.mkdir(parents=True, exist_ok=True)
    target_path = models_dir / filename

    try:
        with target_path.open("wb") as target:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                target.write(chunk)
    finally:
        await file.close()

    return {
        "uploaded": True,
        "filename": filename,
        "path": str(target_path),
    }


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """Multi-turn chat with the AI agent — supports streaming via SSE."""
    system_prompt = _build_system_prompt(request.mode)
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend([m.model_dump() for m in request.messages])

    payload = {
        "messages": messages,
        "max_tokens": _get_max_tokens(request.mode, request.max_tokens),
        "temperature": request.temperature or CONFIG["llamacpp"].get("temperature", 0.7),
        "top_p": request.top_p or CONFIG["llamacpp"].get("top_p", 0.9),
    }
    if request.stop:
        payload["stop"] = request.stop

    if request.stream:
        return EventSourceResponse(_stream_backend(payload))

    content = await _complete_backend(payload)
    return {"content": content, "mode": request.mode}


@app.post("/api/complete")
async def complete(request: CompletionRequest):
    """Code completion — returns a single best completion."""
    system_prompt = _build_system_prompt(AgentMode.COMPLETION)
    user_content = f"Language: {request.language}\n\n```\n{request.prefix}<CURSOR>{request.suffix}\n```\n\nComplete the code at <CURSOR>. Return ONLY the completion text."

    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": request.max_tokens,
        "temperature": request.temperature,
        "top_p": 0.95,
        "stop": ["\n\n", "```"],
    }

    content = await _complete_backend(payload)
    # Strip any markdown fencing the model may add
    content = content.strip().removeprefix("```").removesuffix("```").strip()
    return {"completion": content}


@app.post("/api/terminal")
async def terminal_agent(request: TerminalRequest):
    """Terminal agent — plans and streams multi-step shell task execution."""
    system_prompt = _build_system_prompt(AgentMode.TERMINAL)
    messages = [{"role": "system", "content": system_prompt}]

    if request.context:
        messages.append({"role": "user", "content": f"Environment context:\n{request.context}"})

    messages.extend([m.model_dump() for m in request.history])
    messages.append({"role": "user", "content": request.task})

    payload = {
        "messages": messages,
        "max_tokens": _get_max_tokens(AgentMode.TERMINAL),
        "temperature": 0.3,
        "top_p": 0.9,
    }

    if request.stream:
        return EventSourceResponse(_stream_backend(payload))

    content = await _complete_backend(payload)
    return {"content": content}


@app.post("/api/refactor")
async def refactor(request: RefactorRequest):
    """Refactor code using AI — returns the refactored code."""
    system_prompt = _build_system_prompt(AgentMode.REFACTOR)

    user_content = f"""Operation: {request.operation}
Language: {request.language}
{f'Selected: {request.selection}' if request.selection else ''}
{f'Instructions: {request.instructions}' if request.instructions else ''}

Code:
```{request.language}
{request.code}
```

Return ONLY the refactored code in a code block."""

    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": _get_max_tokens(AgentMode.REFACTOR, 4096),
        "temperature": 0.2,
    }

    content = await _complete_backend(payload)
    # Extract code from markdown fencing
    if "```" in content:
        parts = content.split("```")
        if len(parts) >= 3:
            code_block = parts[1]
            # Remove language identifier on first line
            lines = code_block.split("\n", 1)
            content = lines[1] if len(lines) > 1 else code_block
    return {"code": content.strip()}


@app.post("/api/explain")
async def explain_code(request: Request):
    """Explain code — returns a natural language explanation."""
    body = await request.json()
    code = body.get("code", "")
    language = body.get("language", "")

    payload = {
        "messages": [
            {"role": "system", "content": "You are an expert at explaining code clearly and concisely."},
            {"role": "user", "content": f"Explain this {language} code:\n\n```{language}\n{code}\n```"},
        ],
        "max_tokens": 2048,
        "temperature": 0.5,
    }

    content = await _complete_backend(payload)
    return {"explanation": content}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=CONFIG["server"]["host"],
        port=CONFIG["server"]["port"],
        workers=CONFIG["server"].get("workers", 1),
        reload=False,
    )
