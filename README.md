# PSC - PARK Systems Corporation Open Source

## Gemma Theia IDE (Native Local Edition)

PSC is a local-first coding IDE built on [Eclipse Theia](https://theia-ide.org/). It runs natively on Windows, serves the IDE through a local proxy, and uses local Ollama models for chat/completion while delegating serious coding work to open-source agent tools:

- **RA.Aid** as the planning/tool brain
- **aider** as the code-editing hand
- **MCP wrapper** for tool access from compatible clients

> **Status:** Beta. The Windows native path is the primary supported path today. macOS/Linux can run the IDE, but the automatic LLM/server launcher is Windows-focused.

---

### Quick Start

```bash
git clone https://github.com/parksystemscorporation/psc
cd psc
npm run bootstrap
npm start
```

`npm start` launches Theia, the local FastAPI LLM/agent server, the reverse proxy, and a desktop browser window. The proxy stays in the foreground; press `Ctrl+C` to release it. Background services keep running until `npm run stop`.

---

### What `npm start` Does

1. **Theia backend** starts on `IDE_PORT + 1` (default `3001`).
2. **FastAPI LLM/agent server** starts on `LLM_SERVER_PORT` (default `8000`). On first run, it creates `IPE/llm-server/.venv` and installs Python dependencies.
3. **Reverse proxy** binds `IDE_PORT` (default `3000`) and routes IDE traffic to Theia and AI/tool traffic to FastAPI.
4. **Desktop window** opens via Edge or Chrome when `OPEN_WINDOW=true`.

Telegram has been removed from the default runtime path. PSC is now focused on fast local IDE use.

### Daily Commands

| Command | Purpose |
|---|---|
| `npm start` | Launch the local IDE stack |
| `npm run stop` | Stop Theia and the LLM/agent server |
| `npm run logs` | Tail the Theia log |
| `npm run logs:llm` | Tail the FastAPI LLM/agent server log |
| `npm run window` | Open another desktop window |
| `npm run bootstrap` | Reinstall/build Theia dependencies and native modules |
| `npm run canopy:check` | Verify WSL, tmux, git, and Canopy are already available |
| `npm run canopy` | Launch Canopy dashboards for Vestra and Lila |
| `npm run canopy:setup` | Create default Canopy git worktrees, then launch dashboards |
| `npm run canopy:install-online` | Optional online maintenance helper for WSL/tmux/Canopy setup |
| `npm run agents:dual` | Launch two native Windows Hermes-managed agent sessions for Vestra and Lila |
| `npm run mcp:agent` | Start the PSC MCP agent server over stdio |

---

### Local Agent Stack

PSC uses a split-brain local agent architecture:

- Simple chat/completion still goes through the local Ollama-backed LLM server.
- Normal Agent mode delegates coding tasks to **RA.Aid** with `--use-aider`.
- Requests that explicitly mention aider can run **aider** directly.
- Git update requests are handled as a direct approved `git pull --ff-only`.
- The MCP server at [IPE/mcp/psc_agent_mcp.py](IPE/mcp/psc_agent_mcp.py) exposes:
  - `git_pull`
  - `ra_aid_task`
  - `aider_task`

RA.Aid and aider are installed into `IPE/llm-server/.venv` from [IPE/llm-server/requirements.txt](IPE/llm-server/requirements.txt). The default local model is configured through `LLM_MODEL` in `IPE/.env`; the current fast default is `qwen2.5-coder:7b`.

To use the MCP server from an MCP client, run:

```bash
npm run mcp:agent
```

The MCP server reads `PSC_TARGET_WORKSPACE`, `LLM_MODEL`, `OLLAMA_BASE_URL`, and `CTX_SIZE` from the environment when provided.

---

### Canopy Multi-Agent Dashboard

PSC includes a Windows launcher for [isacssw/canopy](https://github.com/isacssw/canopy), a `tmux` TUI for supervising multiple coding agents across git worktrees.

Canopy itself runs best from WSL on Windows because it requires `tmux`. This is not Docker and not a Linux container runtime. PSC, Ollama, RA.Aid, aider, and the FastAPI bridge still run natively on Windows; WSL is only the local terminal/session substrate for Canopy.

Check prerequisites without fetching anything:

```bash
npm run canopy:check
```

Offline-primary means normal PSC commands do not run `apt`, `go install`, `pip install`, or `ollama pull`. Prepare WSL/tmux/Canopy once from your offline package cache or during an approved online maintenance window.

Manual online equivalent inside WSL, only when internet use is acceptable:

```bash
sudo apt update
sudo apt install -y tmux golang-go
go install github.com/isacssw/canopy/cmd/canopy@latest
```

PSC also includes an explicit helper for that online maintenance window:

```bash
npm run canopy:install-online
```

Need two autonomous agents before WSL/Canopy is ready? Use the native Windows fallback:

```bash
npm run agents:dual
```

That opens two terminal tabs and runs Hermes-managed RA.Aid/aider motor sessions in `C:\vestra` and `C:\lila` at the same time. It does not provide Canopy's supervision UI, but it gives you immediate parallel autonomous work without Docker, containers, or WSL.

Then launch both project dashboards from Windows:

```bash
npm run canopy
```

This opens two Canopy tabs:

- `C:\vestra`
- `C:\lila`

Canopy is the primary dashboard for the parallel agents. PSC writes the WSL Canopy config automatically with two local agent profiles:

- `psc-ra-aid` - RA.Aid planner/tool brain with aider enabled
- `psc-aider` - aider direct editing hand

To prepare separate git worktrees for the two primary agents before launching:

```bash
npm run canopy:setup
```

That creates `.canopy-worktrees\vestra-agent` and `.canopy-worktrees\lila-agent` where possible, so agents can work in isolated git worktrees and avoid file lock contention. Canopy can also create and manage additional worktrees from its own TUI with `n`.

---

### Currency SQLite MCP Bridge

The PSC MCP server includes read-only SQLite tools for the future in-world currency database:

- `currency_sqlite_schema`
- `currency_sqlite_read`

Set the database path before starting the MCP server:

```bash
set WORLD_CURRENCY_SQLITE=C:\path\to\currency.sqlite
npm run mcp:agent
```

Queries are opened with SQLite `mode=ro` and limited to read-only `SELECT`, `WITH`, and `PRAGMA` statements.

---

### Model Setup

PSC expects Ollama to be available at `http://127.0.0.1:11434`.

Recommended fast local setup:

```bash
ollama pull qwen2.5-coder:7b
```

Then confirm `IPE/.env` contains:

```bash
LLM_BACKEND=llamacpp
LLM_MODEL=qwen2.5-coder:7b
MEMPALACE_ENABLED=false
PERSONAPLEX_ENABLED=false
```

Larger models can work, but they will feel slow on CPU or limited VRAM. The old memory/persona sidecars are disabled by default to keep startup and first-token latency low.

---

### Configuration

Runtime configuration lives in `IPE/.env`. Key settings:

```bash
IDE_PORT=3000
LLM_SERVER_PORT=8000
START_LLM_SERVER=true
OPEN_WINDOW=true
HOST_WORKSPACE=..
PSC_TARGET_WORKSPACE=..
LLM_MODEL=qwen2.5-coder:7b
CTX_SIZE=8192
MEMPALACE_ENABLED=false
PERSONAPLEX_ENABLED=false
```

`PSC_TARGET_WORKSPACE` controls where RA.Aid, aider, git commands, and file tools operate.

---

### Native Module Patches

Theia ships several native addons that need Windows/Node compatibility patches. `npm run bootstrap` applies the patches in [IPE/patches](IPE/patches/) through `patch-package` and rebuilds the native pieces.

Use `npm run bootstrap` after dependency changes instead of raw `yarn install`.

---

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent says a tool is missing | Python venv is stale | `IPE\llm-server\.venv\Scripts\python.exe -m pip install -r IPE\llm-server\requirements.txt` |
| Slow responses | Model too large or memory/persona sidecars enabled | Use `qwen2.5-coder:7b`, keep `MEMPALACE_ENABLED=false` and `PERSONAPLEX_ENABLED=false` |
| `/api/chat` returns 503 | FastAPI server is down | `npm run logs:llm`, then `npm run stop && npm start` |
| Aider/RA.Aid fails to run | Ollama model missing | `ollama pull qwen2.5-coder:7b` |
| Native module error | Theia native modules not rebuilt | `npm run bootstrap` |

### Key Features

- **Theia IDE** - VS Code-style local development environment
- **Local Ollama Models** - Chat and completion without cloud dependency
- **RA.Aid + aider Agent Mode** - Open-source autonomous planning plus code edits
- **MCP Agent Server** - `git_pull`, `ra_aid_task`, and `aider_task` over stdio
- **Fast Local Defaults** - Smaller coder model, memory/persona sidecars off
- **One-Command Launcher** - `npm start` brings up the working local stack

### License

[MIT](LICENSE)
