# PARK Systems Coder

This is the Theia application inside the PSC repo. It provides the browser IDE, chat UI, completion/refactor extensions, and the FastAPI bridge that connects the IDE to local models and agent tools.

The current agent stack is:

- Ollama for local model serving
- FastAPI in `llm-server/` for chat, completion, file tools, command tools, and agent delegation
- RA.Aid for autonomous research/planning/tool use
- aider for direct code edits
- `mcp/psc_agent_mcp.py` for MCP-compatible access to the same local tools

## Build

From the repo root:

```bash
npm run bootstrap
```

Or from this directory:

```bash
corepack yarn install
yarn build
```

## Run

From the repo root:

```bash
npm start
```

This starts:

- Theia on `IDE_PORT + 1` (default `3001`)
- FastAPI LLM/agent server on `LLM_SERVER_PORT` (default `8000`)
- Local reverse proxy on `IDE_PORT` (default `3000`)
- Optional desktop browser window when `OPEN_WINDOW=true`

## Agent Mode

The chat extension defaults Agent mode on. Normal coding tasks are delegated to RA.Aid with aider enabled. If the user asks to use aider directly, the IDE calls aider one-shot mode. If the user asks to pull/update/sync from GitHub, the IDE asks for approval and runs:

```bash
git pull --ff-only
```

The old local-model tool loop is still available for experimentation by prefixing a request with:

```text
/gemma your request here
```

## MCP

Start the PSC MCP server from the repo root:

```bash
npm run mcp:agent
```

It exposes:

- `git_pull`
- `ra_aid_task`
- `aider_task`
- `currency_sqlite_schema`
- `currency_sqlite_read`

The MCP server uses the same target workspace and model environment as the IDE.

The SQLite tools are read-only and use `WORLD_CURRENCY_SQLITE` as the database path.

## Canopy Dashboard

From the repo root:

```bash
npm run canopy
```

This launches WSL-backed Canopy dashboards for:

- `C:\vestra`
- `C:\lila`

Use this when you want both primary agents visible at once. Canopy manages the git worktrees and tmux sessions; PSC supplies the local agent commands.

To create default isolated worktrees before opening Canopy:

```bash
npm run canopy:setup
```

Canopy requires `tmux` and the `canopy` binary inside WSL. WSL is only the local terminal/session substrate here; PSC does not use Docker or Linux containers.

Check those prerequisites from the repo root without fetching anything:

```bash
npm run canopy:check
```

Use `npm run canopy:install-online` only during an approved online maintenance window, or install `tmux`, `git`, and `canopy` from an offline package cache.

Before WSL/Canopy is ready, you can still launch two native Windows Lila Agent-managed agents:

```bash
npm run agents:dual
```

This opens Lila Agent-managed RA.Aid/aider motor sessions for `C:\vestra` and `C:\lila` in separate terminal tabs.

## Local Model Defaults

Recommended fast local model:

```bash
ollama pull qwen2.5-coder:7b
```

Important `.env` settings:

```bash
LLM_MODEL=qwen2.5-coder:7b
CTX_SIZE=8192
MEMPALACE_ENABLED=false
PERSONAPLEX_ENABLED=false
PSC_TARGET_WORKSPACE=..
```

RA.Aid and aider are installed via `llm-server/requirements.txt` into `llm-server/.venv`.

## Logs

From the repo root:

```bash
npm run logs
npm run logs:llm
```

## License

[MIT](../LICENSE)
