"""
Gemma Theia IDE - LLM Agent Server
====================================
FastAPI server that proxies requests to llama.cpp or vLLM backends,
providing a unified OpenAI-compatible API for the Theia IDE extensions.
"""

import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
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
ollama_pull_state: dict[str, Any] = {
    "status": "idle",       # idle | running | success | error
    "model": None,
    "phase": None,          # "pulling manifest" | "downloading" | ...
    "total": 0,
    "completed": 0,
    "percent": 0.0,
    "error": None,
    "started_at": None,
    "finished_at": None,
}

# Curated quick-pick library shown in the model picker. These are common
# coder/instruct tags that pull cleanly via Ollama and work with the OpenAI-
# compat /v1/chat/completions endpoint we're already using. The frontend can
# also pull arbitrary tags via a free-form input.
OLLAMA_LIBRARY: list[dict[str, Any]] = [
    {"tag": "gemma3:27b",          "size_gb": 17.0,"label": "Gemma 3 27B",          "description": "Default coding mode. Largest public Gemma; needs ~24GB VRAM or 32GB RAM with CPU spill."},
    {"tag": "deepseek-r1:14b",     "size_gb": 9.0, "label": "DeepSeek R1 14B",      "description": "Default debugging mode. Reasoning-tuned, strong at root-causing failures and trace analysis."},
    {"tag": "qwen3-coder:30b",     "size_gb": 18.6,"label": "Qwen 3 Coder 30B (A3B)","description": "Latest Qwen MoE coder — 30B params, ~3B active. Needs ~24GB VRAM (or fast CPU + 32GB RAM)."},
    {"tag": "qwen2.5-coder:7b",    "size_gb": 4.7, "label": "Qwen 2.5 Coder 7B",    "description": "Strong open-source coder, fits on 8GB GPUs."},
    {"tag": "qwen2.5-coder:14b",   "size_gb": 9.0, "label": "Qwen 2.5 Coder 14B",   "description": "Bigger Qwen Coder, ~12GB VRAM."},
    {"tag": "qwen2.5-coder:32b",   "size_gb": 20.0,"label": "Qwen 2.5 Coder 32B",   "description": "Top-tier Qwen 2.5 Coder, needs 24GB+ VRAM."},
    {"tag": "deepseek-coder-v2:16b","size_gb": 9.0,"label": "DeepSeek Coder v2 16B","description": "MoE coder model, balanced speed/quality."},
    {"tag": "llama3.2:3b",         "size_gb": 2.0, "label": "Llama 3.2 3B",         "description": "Tiny, fast general-purpose chat."},
    {"tag": "llama3.1:8b",         "size_gb": 4.7, "label": "Llama 3.1 8B",         "description": "Solid general-purpose 8B."},
    {"tag": "gemma3:4b",           "size_gb": 3.3, "label": "Gemma 3 4B",           "description": "Lightweight Gemma."},
    {"tag": "gemma3:12b",          "size_gb": 8.1, "label": "Gemma 3 12B",          "description": "Bigger Gemma, ~12GB VRAM."},
    {"tag": "phi3:14b",            "size_gb": 7.9, "label": "Phi 3 Medium 14B",     "description": "Microsoft Phi 3 Medium."},
]


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
    agent_tools: bool = Field(False, description="Inject the tool-call protocol into the system prompt")


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


class ExecuteRequest(BaseModel):
    command: str = Field(..., description="Shell command to execute")
    cwd: Optional[str] = Field(None, description="Optional working directory inside the target workspace")
    timeout: int = Field(120, description="Timeout in seconds")


class ExecuteResponse(BaseModel):
    command: str
    cwd: str
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


class AgentTaskRequest(BaseModel):
    task: str = Field(..., description="Natural-language coding task")
    engine: str = Field("ra-aid", description="Agent engine: ra-aid or aider")
    cwd: Optional[str] = Field(None, description="Optional working directory inside the target workspace")
    timeout: int = Field(1800, description="Timeout in seconds")
    use_aider: bool = Field(True, description="For RA.Aid, delegate implementation edits to aider")


class AgentTaskResponse(BaseModel):
    engine: str
    command: str
    cwd: str
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


class RefactorRequest(BaseModel):
    code: str = Field(..., description="Code to refactor")
    operation: str = Field(..., description="Refactor operation name")
    language: str = Field("", description="Programming language")
    selection: Optional[str] = Field(None, description="Selected text for targeted refactoring")
    instructions: str = Field("", description="Additional refactoring instructions")


class ReadFileRequest(BaseModel):
    path: str = Field(..., description="Workspace-relative path to read")
    max_bytes: int = Field(1_000_000, description="Maximum bytes to return; longer files are truncated")


class WriteFileRequest(BaseModel):
    path: str = Field(..., description="Workspace-relative path to write")
    content: str = Field(..., description="Full new file contents (UTF-8)")
    create_parents: bool = Field(True, description="Create parent directories if missing")


class ListDirRequest(BaseModel):
    path: str = Field("", description="Workspace-relative directory; empty for workspace root")
    show_hidden: bool = Field(False, description="Include dotfiles")


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
    personaplex: dict[str, Any]
    memory: dict[str, Any]


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


def _is_truthy(value: Optional[str]) -> bool:
    return bool(value and value.strip().lower() in {"1", "true", "yes", "on"})


def _get_hf_token(provided_token: Optional[str] = None) -> Optional[str]:
    if provided_token and provided_token.strip():
        return provided_token.strip()
    env_token = _read_env_file().get("HF_TOKEN") or os.environ.get("HF_TOKEN")
    return env_token.strip() if env_token else None


def _resolve_project_path(value: str, default: str) -> Path:
    raw_value = value.strip() if value else default
    target = Path(raw_value)
    return target if target.is_absolute() else (PROJECT_DIR / target).resolve()


def _get_target_workspace() -> Path:
    env_values = _read_env_file()
    env_target = env_values.get("PSC_TARGET_WORKSPACE")
    if env_target:
        target = Path(env_target.strip())
        return (target if target.is_absolute() else (ENV_FILE.parent / target)).resolve()

    process_target = os.environ.get("PSC_TARGET_WORKSPACE") or os.environ.get("HOST_WORKSPACE")
    if process_target:
        target = Path(process_target.strip())
        return (target if target.is_absolute() else (PROJECT_DIR / target)).resolve()

    return PROJECT_DIR.resolve()


def _resolve_execution_cwd(cwd: Optional[str] = None) -> Path:
    target_workspace = _get_target_workspace()
    requested = Path(cwd.strip()) if cwd and cwd.strip() else target_workspace
    resolved = requested if requested.is_absolute() else (target_workspace / requested)
    resolved = resolved.resolve()

    try:
        resolved.relative_to(target_workspace)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Execution cwd must stay inside PSC_TARGET_WORKSPACE") from error

    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"Execution cwd does not exist: {resolved}")
    return resolved


def _resolve_workspace_path(path: str) -> Path:
    """Resolve a tool-supplied path against PSC_TARGET_WORKSPACE.

    Refuses absolute paths that escape the workspace, refuses traversal via
    `..`, and refuses empty input. Used by the agent file tools.
    """
    if not path or not str(path).strip():
        raise HTTPException(status_code=400, detail="path is required")

    target = _get_target_workspace()
    candidate = Path(str(path).strip())
    resolved = candidate if candidate.is_absolute() else (target / candidate)
    resolved = resolved.resolve()

    try:
        resolved.relative_to(target)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="path must stay inside PSC_TARGET_WORKSPACE") from error
    return resolved


def _is_mempalace_enabled() -> bool:
    return _is_truthy(_read_env_file().get("MEMPALACE_ENABLED", "false"))


def _get_mempalace_palace_path() -> Path:
    env_values = _read_env_file()
    return _resolve_project_path(env_values.get("MEMPALACE_PALACE_PATH", "./.mempalace/palace"), "./.mempalace/palace")


def _get_mempalace_wing() -> str:
    wing = _read_env_file().get("MEMPALACE_WING", "").strip()
    return wing or PROJECT_DIR.name.lower()


def _is_mempalace_auto_search_enabled() -> bool:
    return _is_truthy(_read_env_file().get("MEMPALACE_AUTO_SEARCH", "true"))


def _get_mempalace_command() -> Optional[list[str]]:
    executable = shutil.which("mempalace")
    if executable:
        return [executable]
    return None


def _run_mempalace_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    command = _get_mempalace_command()
    if not command:
        raise RuntimeError("MemPalace is not installed in the llm-server container yet. Rebuild with `npm start` or `docker compose build llm-server`.")

    env = {
        **os.environ,
        "HOME": str(PROJECT_DIR),
    }
    return subprocess.run(
        [*command, *args],
        cwd=str(PROJECT_DIR),
        text=True,
        capture_output=True,
        check=True,
        env=env,
    )


def _is_mempalace_configured() -> bool:
    palace_path = _get_mempalace_palace_path()
    return palace_path.exists() and any(palace_path.iterdir())


def _get_mempalace_status() -> dict[str, Any]:
    enabled = _is_mempalace_enabled()
    palace_path = _get_mempalace_palace_path()
    configured = _is_mempalace_configured()
    command = _get_mempalace_command()
    wing = _get_mempalace_wing()
    auto_search = _is_mempalace_auto_search_enabled()
    notes = (
        "Run `docker compose -f IPE/docker-compose.yml exec llm-server mempalace init /workspace/project --yes` "
        "then `docker compose -f IPE/docker-compose.yml exec llm-server mempalace mine /workspace/project --wing "
        f"{wing}` to build local memory."
    )
    if not enabled:
        notes = "Set MEMPALACE_ENABLED=true in IPE/.env, then restart npm start to enable local memory."
    elif configured:
        notes = "MemPalace wake-up context is injected automatically, and recent prompts can trigger local memory search."

    return {
        "enabled": enabled,
        "available": bool(command),
        "configured": configured,
        "palace_path": str(palace_path),
        "wing": wing,
        "auto_search": auto_search,
        "notes": notes,
    }


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


def _get_personaplex_status(healthy: bool) -> dict[str, Any]:
    env_values = _read_env_file()
    enabled = _is_truthy(env_values.get("PERSONAPLEX_ENABLED", "false"))
    port = int(env_values.get("PERSONAPLEX_PORT", "8998") or "8998")
    hf_token_present = bool(_get_hf_token())
    return {
        "enabled": enabled,
        "healthy": healthy if enabled else False,
        "port": port,
        "url": f"https://localhost:{port}",
        "profile": "voice",
        "hf_token_configured": hf_token_present,
        "notes": (
            "PersonaPlex requires an accepted Hugging Face license for nvidia/personaplex-7b-v1."
            if enabled
            else "Set PERSONAPLEX_ENABLED=true in IPE/.env, then restart npm start to launch PersonaPlex."
        ),
    }


def _build_setup_status(backend_ready: bool, personaplex_ready: bool) -> SetupStatusResponse:
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
        personaplex=_get_personaplex_status(personaplex_ready),
        memory=_get_mempalace_status(),
    )


def _get_model_name() -> str:
    # Explicit override (set in IPE/.env as LLM_MODEL) wins for any backend.
    # Use this for Ollama tags like "gemma3:4b" or "llama3.2:3b".
    override = (_read_env_file().get("LLM_MODEL") or os.environ.get("LLM_MODEL") or "").strip()
    if override:
        return override
    if _get_desired_backend() == "vllm":
        return CONFIG["vllm"].get("model_name", "google/gemma-4-12b-it")
    return _get_desired_model_key()


def _agent_subprocess_env() -> dict[str, str]:
    env_values = _read_env_file()
    model = _get_model_name()
    return {
        **os.environ,
        "OLLAMA_BASE_URL": env_values.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
        "AIDER_MODEL": env_values.get("AIDER_MODEL", f"ollama_chat/{model}"),
        "AIDER_YES_ALWAYS": "true",
        "PYTHONUNBUFFERED": "1",
    }


def _agent_shell_command(args: list[str]) -> list[str]:
    quoted = subprocess.list2cmdline(args) if os.name == "nt" else " ".join(shlex.quote(arg) for arg in args)
    if os.name == "nt":
        return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", quoted]
    return ["/bin/sh", "-lc", quoted]


def _agent_executable(name: str) -> str:
    suffix = ".exe" if os.name == "nt" else ""
    candidate = Path(sys.executable).parent / f"{name}{suffix}"
    if candidate.exists():
        return str(candidate)
    found = shutil.which(name)
    return found or name


def _build_agent_command(request: AgentTaskRequest) -> tuple[str, list[str]]:
    task = request.task.strip()
    if not task:
        raise HTTPException(status_code=400, detail="Task is required")

    model = _get_model_name()
    engine = request.engine.strip().lower()
    if engine in {"ra", "raid", "ra.aid", "ra-aid"}:
        args = [
            _agent_executable("ra-aid"),
            "--provider",
            "ollama",
            "--model",
            model,
            "--num-ctx",
            str(int(_read_env_file().get("CTX_SIZE", "8192") or "8192")),
            "--expert-provider",
            "ollama",
            "--expert-model",
            model,
            "--expert-num-ctx",
            str(int(_read_env_file().get("CTX_SIZE", "8192") or "8192")),
            "--cowboy-mode",
            "--log-mode",
            "console",
        ]
        if request.use_aider:
            args.append("--use-aider")
        args.extend(["-m", task])
        return "ra-aid", args

    if engine == "aider":
        return "aider", [
            _agent_executable("aider"),
            "--model",
            f"ollama_chat/{model}",
            "--message",
            task,
            "--yes-always",
        ]

    raise HTTPException(status_code=400, detail="engine must be 'ra-aid' or 'aider'")


def _latest_user_message(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return str(message.get("content", "")).strip()
    return ""


def _get_memory_context(query: Optional[str] = None) -> str:
    if not _is_mempalace_enabled():
        return ""

    sections: list[str] = []
    palace_path = _get_mempalace_palace_path()
    wing = _get_mempalace_wing()
    palace_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        wakeup = _run_mempalace_command([
            "--palace",
            str(palace_path),
            "wake-up",
            "--wing",
            wing,
        ]).stdout.strip()
        if wakeup:
            sections.append(f"Wake-up memory:\n{wakeup}")
    except Exception:
        return ""

    if query and _is_mempalace_auto_search_enabled() and len(query) >= 12:
        try:
            results = _run_mempalace_command([
                "--palace",
                str(palace_path),
                "search",
                query,
                "--wing",
                wing,
                "--results",
                "3",
            ]).stdout.strip()
            if results:
                sections.append(f"Relevant memory search:\n{results}")
        except Exception:
            pass

    return "\n\n".join(section for section in sections if section)


AGENT_TOOLS_PROTOCOL = """
You have access to tools that can read, write, list, and run code in the user's workspace.

To call a tool, emit EXACTLY this format and then STOP generating — wait for the result before continuing:

<<TOOL>>
{"name": "<tool_name>", "args": { ... }}
<<END>>

After the tool runs, the result will be appended to the conversation as:

<<TOOL_RESULT>>
{"name": "<tool_name>", "ok": true, "result": ...}
<<END>>

(Or `"ok": false, "error": "..."` if it failed or the user denied it.)

Available tools:

- read_file({"path": "src/foo.py"})
    Read a UTF-8 text file. Returns {content, size, truncated}. Path is relative to the workspace root.

- list_dir({"path": "src"})
    List entries in a directory. Returns {entries: [{name, type, size}]}. Use "" for the workspace root.

- write_file({"path": "src/foo.py", "content": "..."})
    Create or OVERWRITE a file with the full new contents. The user will see a diff and must approve.
    Always read_file first before write_file unless creating a brand-new file. Provide the COMPLETE new
    contents, not a partial diff or "// rest unchanged" placeholder.

- run_command({"command": "pytest -k foo"})
    Run a shell command in the workspace. The user will see the command and must approve. Returns
    {exit_code, stdout, stderr}.
    Use this for git operations such as `git status`, `git fetch`, and `git pull --ff-only`.

Rules:
1. Emit AT MOST ONE <<TOOL>> block per response, then stop. Do not narrate what you are about to do
   in the same response — call the tool and wait.
2. Use forward slashes in paths. Paths are workspace-relative.
3. Read before you edit. Never blindly overwrite a file.
4. When you are finished with the user's request, respond with normal markdown — no <<TOOL>> block.
5. If a tool returns an error, read it and adapt. Do not repeat the same failing call.
6. Do not claim to be text-only while this protocol is present. Use a tool call for workspace work.
7. If the user asks to pull from GitHub or update the repo, call run_command with `git pull --ff-only`.
"""


def _build_system_prompt(mode: AgentMode, memory_context: str = "", agent_tools: bool = False) -> str:
    agent_cfg = CONFIG.get("agent", {})
    target_workspace = _get_target_workspace()
    prompts = {
        AgentMode.CHAT: agent_cfg.get("chat_system_prompt", "You are a coding assistant."),
        AgentMode.COMPLETION: agent_cfg.get("completion_system_prompt", "Complete the code."),
        AgentMode.TERMINAL: agent_cfg.get("terminal_system_prompt", "You are a terminal agent."),
        AgentMode.REFACTOR: "You are an expert code refactoring assistant. Return ONLY the refactored code.",
    }
    prompt = (
        f"{prompts.get(mode, prompts[AgentMode.CHAT])}\n\n"
        f"PSC target workspace: {target_workspace}\n"
        "PSC is the coding-agent IDE. The target workspace is the software project being edited. "
        "Do not confuse PSC with target projects such as Vestra or Lila."
    )
    if agent_tools and mode == AgentMode.CHAT:
        prompt = f"{prompt}\n\n{AGENT_TOOLS_PROTOCOL.strip()}"
    if memory_context:
        prompt = (
            f"{prompt}\n\n"
            "Local memory context from MemPalace is included below. Use it when relevant, prefer it over guesses, and say when memory is incomplete.\n\n"
            f"{memory_context}"
        )
    return prompt


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
                    yield "[DONE]"
                    return
                try:
                    chunk = json.loads(data)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield json.dumps({"content": content})
                except json.JSONDecodeError:
                    continue

    yield "[DONE]"


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
        if not backend_ok and _get_backend_url().rstrip("/").endswith(":11434"):
            resp = await http_client.get(f"{_get_backend_url()}/api/tags", timeout=5.0)
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
    personaplex_ok = False
    try:
        resp = await http_client.get(f"{_get_backend_url()}/health", timeout=5.0)
        backend_ok = resp.status_code == 200
        if not backend_ok and _get_backend_url().rstrip("/").endswith(":11434"):
            resp = await http_client.get(f"{_get_backend_url()}/api/tags", timeout=5.0)
            backend_ok = resp.status_code == 200
    except Exception:
        pass
    if _is_truthy(_read_env_file().get("PERSONAPLEX_ENABLED", "false")):
        try:
            resp = await http_client.get("https://personaplex:8998", timeout=5.0, verify=False)
            personaplex_ok = resp.status_code == 200
        except Exception:
            pass
    return _build_setup_status(backend_ok, personaplex_ok)


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


# ---------------------------------------------------------------------------
# Ollama model management
# ---------------------------------------------------------------------------

class OllamaPullRequest(BaseModel):
    name: str = Field(..., description="Ollama tag, e.g. 'qwen2.5-coder:7b'")


class OllamaSelectRequest(BaseModel):
    name: str = Field(..., description="Ollama tag to mark as the active LLM")


def _ollama_base_url() -> str:
    """Base URL for the Ollama daemon. Reuses the configured llamacpp URL since
    Ollama serves the OpenAI-compat API at the same host:port."""
    return CONFIG["llamacpp"]["server_url"].rstrip("/")


@app.get("/api/ollama/library")
async def ollama_library():
    """Curated quick-pick list of Ollama tags shown in the model picker."""
    return {"models": OLLAMA_LIBRARY}


@app.get("/api/ollama/tags")
async def ollama_tags():
    """List models that are already pulled locally via Ollama."""
    url = f"{_ollama_base_url()}/api/tags"
    try:
        resp = await http_client.get(url, timeout=10.0)
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Ollama unreachable: {error}") from error

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    payload = resp.json()
    active = (_read_env_file().get("LLM_MODEL") or os.environ.get("LLM_MODEL") or "").strip()
    models = []
    for entry in payload.get("models", []):
        name = entry.get("name") or entry.get("model")
        if not name:
            continue
        size_bytes = entry.get("size") or 0
        models.append({
            "name": name,
            "size_gb": round(size_bytes / (1024 ** 3), 2) if size_bytes else 0.0,
            "modified_at": entry.get("modified_at"),
            "digest": entry.get("digest"),
            "active": name == active,
        })
    return {"models": models, "active": active}


@app.get("/api/ollama/pull/status")
async def ollama_pull_status():
    """Current state of an in-progress or completed Ollama pull."""
    return ollama_pull_state


@app.post("/api/ollama/pull")
async def ollama_pull(request: OllamaPullRequest):
    """Kick off a background `ollama pull <name>`. Progress is reported via
    /api/ollama/pull/status. Returns immediately — poll the status endpoint."""
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Model name is required")

    if ollama_pull_state["status"] == "running":
        raise HTTPException(
            status_code=409,
            detail=f"A pull for '{ollama_pull_state['model']}' is already running",
        )

    ollama_pull_state.update({
        "status": "running",
        "model": name,
        "phase": "starting",
        "total": 0,
        "completed": 0,
        "percent": 0.0,
        "error": None,
        "started_at": time.time(),
        "finished_at": None,
    })

    async def run_pull() -> None:
        url = f"{_ollama_base_url()}/api/pull"
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", url, json={"name": name, "stream": True}) as resp:
                    if resp.status_code != 200:
                        body = await resp.aread()
                        raise RuntimeError(f"Ollama returned {resp.status_code}: {body.decode(errors='ignore')}")

                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        if "error" in chunk:
                            raise RuntimeError(chunk["error"])

                        phase = chunk.get("status", "")
                        total = int(chunk.get("total") or 0)
                        completed = int(chunk.get("completed") or 0)
                        percent = round((completed / total) * 100, 1) if total else ollama_pull_state["percent"]

                        ollama_pull_state.update({
                            "phase": phase,
                            "total": total or ollama_pull_state["total"],
                            "completed": completed or ollama_pull_state["completed"],
                            "percent": percent,
                        })

                        if phase == "success":
                            break

            ollama_pull_state.update({
                "status": "success",
                "phase": "success",
                "percent": 100.0,
                "error": None,
                "finished_at": time.time(),
            })
        except Exception as error:
            ollama_pull_state.update({
                "status": "error",
                "error": str(error),
                "finished_at": time.time(),
            })

    asyncio.create_task(run_pull())
    return {"accepted": True, "model": name}


@app.post("/api/ollama/select")
async def ollama_select(request: OllamaSelectRequest):
    """Set the active model. Writes LLM_MODEL into IPE/.env. No restart needed:
    /api/chat re-reads the env file on every request."""
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Model name is required")

    # Verify the tag actually exists locally so we don't quietly point at a
    # missing model. Skip verification if Ollama is unreachable — let the next
    # /api/chat call surface that.
    try:
        resp = await http_client.get(f"{_ollama_base_url()}/api/tags", timeout=5.0)
        if resp.status_code == 200:
            installed = {(m.get("name") or m.get("model")) for m in resp.json().get("models", [])}
            if name not in installed:
                raise HTTPException(
                    status_code=404,
                    detail=f"'{name}' is not pulled. POST /api/ollama/pull first.",
                )
    except HTTPException:
        raise
    except Exception:
        pass

    _write_env_updates({
        "LLM_BACKEND": "llamacpp",
        "LLM_MODEL": name,
    })
    return {"selected": name}


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
    message_dicts = [m.model_dump() for m in request.messages]
    memory_context = _get_memory_context(_latest_user_message(message_dicts))
    system_prompt = _build_system_prompt(request.mode, memory_context, agent_tools=request.agent_tools)
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(message_dicts)

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
    memory_context = _get_memory_context(request.task)
    system_prompt = _build_system_prompt(AgentMode.TERMINAL, memory_context)
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


@app.get("/api/workspace")
async def workspace_status():
    """Return the PSC target workspace used for local coding tasks."""
    target_workspace = _get_target_workspace()
    return {
        "target_workspace": str(target_workspace),
        "exists": target_workspace.exists(),
        "is_directory": target_workspace.is_dir(),
    }


@app.post("/api/execute", response_model=ExecuteResponse)
async def execute_command(request: ExecuteRequest):
    """Execute a local shell command inside the PSC target workspace."""
    command = request.command.strip()
    if not command:
        raise HTTPException(status_code=400, detail="Command is required")

    cwd = _resolve_execution_cwd(request.cwd)
    timeout = max(1, min(request.timeout, 600))

    if os.name == "nt":
        shell_command = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ]
    else:
        shell_command = ["/bin/sh", "-lc", command]

    try:
        result = await asyncio.to_thread(
            subprocess.run,
            shell_command,
            cwd=str(cwd),
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        return ExecuteResponse(
            command=command,
            cwd=str(cwd),
            exit_code=result.returncode,
            stdout=result.stdout,
            stderr=result.stderr,
        )
    except subprocess.TimeoutExpired as error:
        return ExecuteResponse(
            command=command,
            cwd=str(cwd),
            exit_code=124,
            stdout=error.stdout or "",
            stderr=error.stderr or f"Command timed out after {timeout} seconds",
            timed_out=True,
        )


# ---------------------------------------------------------------------------
# Agent file tools — read_file / write_file / list_dir
# ---------------------------------------------------------------------------

@app.post("/api/agent/task", response_model=AgentTaskResponse)
async def run_agent_task(request: AgentTaskRequest):
    """Run a PSC MCP-style agent tool: RA.Aid for planning, aider for edits."""
    cwd = _resolve_execution_cwd(request.cwd)
    timeout = max(1, min(request.timeout, 3600))
    engine, args = _build_agent_command(request)
    display_command = subprocess.list2cmdline(args) if os.name == "nt" else " ".join(shlex.quote(arg) for arg in args)

    try:
        result = await asyncio.to_thread(
            subprocess.run,
            _agent_shell_command(args),
            cwd=str(cwd),
            text=True,
            capture_output=True,
            timeout=timeout,
            env=_agent_subprocess_env(),
        )
        return AgentTaskResponse(
            engine=engine,
            command=display_command,
            cwd=str(cwd),
            exit_code=result.returncode,
            stdout=result.stdout,
            stderr=result.stderr,
        )
    except subprocess.TimeoutExpired as error:
        return AgentTaskResponse(
            engine=engine,
            command=display_command,
            cwd=str(cwd),
            exit_code=124,
            stdout=error.stdout or "",
            stderr=error.stderr or f"Agent task timed out after {timeout} seconds",
            timed_out=True,
        )


@app.post("/api/fs/read")
async def fs_read(request: ReadFileRequest):
    """Read a UTF-8 text file inside PSC_TARGET_WORKSPACE for the agent loop."""
    resolved = _resolve_workspace_path(request.path)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {request.path}")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"Not a regular file: {request.path}")

    size = resolved.stat().st_size
    max_bytes = max(1, min(int(request.max_bytes or 1_000_000), 5_000_000))
    truncated = size > max_bytes

    try:
        with resolved.open("rb") as fh:
            data = fh.read(max_bytes)
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Read failed: {error}") from error

    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        content = data.decode("utf-8", errors="replace")

    target = _get_target_workspace()
    return {
        "path": str(resolved.relative_to(target)).replace("\\", "/"),
        "content": content,
        "size": size,
        "truncated": truncated,
    }


@app.post("/api/fs/write")
async def fs_write(request: WriteFileRequest):
    """Create or overwrite a UTF-8 text file inside PSC_TARGET_WORKSPACE."""
    resolved = _resolve_workspace_path(request.path)
    created = not resolved.exists()

    if request.create_parents:
        resolved.parent.mkdir(parents=True, exist_ok=True)
    elif not resolved.parent.exists():
        raise HTTPException(status_code=400, detail=f"Parent directory does not exist: {resolved.parent}")

    try:
        resolved.write_text(request.content, encoding="utf-8")
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Write failed: {error}") from error

    target = _get_target_workspace()
    return {
        "path": str(resolved.relative_to(target)).replace("\\", "/"),
        "bytes_written": len(request.content.encode("utf-8")),
        "created": created,
    }


@app.post("/api/fs/list")
async def fs_list(request: ListDirRequest):
    """List entries in a directory inside PSC_TARGET_WORKSPACE."""
    target = _get_target_workspace()
    if not request.path:
        resolved = target
    else:
        resolved = _resolve_workspace_path(request.path)

    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {request.path or '.'}")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {request.path or '.'}")

    entries = []
    for child in sorted(resolved.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if not request.show_hidden and child.name.startswith("."):
            continue
        try:
            stat = child.stat()
            size = stat.st_size if child.is_file() else None
        except OSError:
            size = None
        entries.append({
            "name": child.name,
            "type": "dir" if child.is_dir() else "file",
            "size": size,
        })

    return {
        "path": str(resolved.relative_to(target)).replace("\\", "/") or ".",
        "entries": entries,
    }


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
