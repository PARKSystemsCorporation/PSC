# PSC Gemma Theia IDE

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

The MCP server uses the same target workspace and model environment as the IDE.

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
