"""
Gemma Theia IDE - LLM Agent Server
====================================
FastAPI server that proxies requests to llama.cpp or vLLM backends,
providing a unified OpenAI-compatible API for the Theia IDE extensions.
"""

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from enum import Enum
from typing import AsyncIterator, Optional

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse


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

# HTTP client for backend communication
http_client: Optional[httpx.AsyncClient] = None


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


# ---------------------------------------------------------------------------
# Backend communication
# ---------------------------------------------------------------------------

START_TIME = time.time()


def _get_backend_url() -> str:
    if BACKEND == "vllm":
        return CONFIG["vllm"]["server_url"]
    return CONFIG["llamacpp"]["server_url"]


def _get_model_name() -> str:
    if BACKEND == "vllm":
        return CONFIG["vllm"].get("model_name", "google/gemma-4-12b-it")
    return "gemma-4"


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
        backend=BACKEND,
        model=_get_model_name(),
        uptime=time.time() - START_TIME,
    )


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
