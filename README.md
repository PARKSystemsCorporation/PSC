# PSC — PARK Systems Corporation Open Source

## Gemma Theia IDE (Native Local Edition)

AI-powered local coding IDE built on [Eclipse Theia](https://theia-ide.org/) with [Google Gemma](https://blog.google/technology/developers/gemma-open-models/) agent capabilities, plus a Telegram bridge so you can chat with the agent from your phone while away from the desk.

> **Status:** Beta — runs entirely locally on Windows. macOS and Linux supported for the IDE; LLM auto-launch is Windows-only today.

---

### Quick Start

```bash
git clone https://github.com/parksystemscorporation/psc
cd psc
npm run bootstrap   # one-time: yarn install (no scripts) → patch-package → rebuild native modules
npm start           # launches Theia + LLM server + Telegram bridge + reverse proxy + desktop window
```

`npm start` brings everything up in one command and pops a chromeless Edge/Chrome app window pointing at the IDE. The proxy stays in the foreground; press `Ctrl+C` to release it (background services keep running — `npm run stop` shuts them down).

---

### What `npm start` actually does

1. **Theia backend** boots on `IDE_PORT + 1` (default `3001`).
2. **LLM server** (FastAPI) boots on `LLM_SERVER_PORT` (default `8000`). On Windows the launcher uses [scripts/start-llm.ps1](scripts/start-llm.ps1) the first time (creates the venv, installs deps), then runs Python directly with `-u` for live unbuffered logs on subsequent runs.
3. **Telegram bridge** ([IPE/llm-server/telegram_bridge.py](IPE/llm-server/telegram_bridge.py)) starts only if `TELEGRAM_BOT_TOKEN` is set in [IPE/.env](IPE/.env.example).
4. **Reverse proxy** binds `IDE_PORT` (default `3000`) and routes:
   - `/api/chat`, `/api/complete`, `/api/terminal`, `/api/refactor`, `/api/explain`, `/api/setup/*`, `/health` → LLM server
   - everything else (including `/api/connection/*` for Theia's WebSocket) → Theia
   - explicit CORS headers + `OPTIONS` preflight handling at the proxy layer
   - returns structured `503 {error, detail, upstream}` JSON when an upstream is unreachable
5. **Desktop window** opens via `msedge --app=` (or Chrome, falling back to your default browser).

### Daily commands

| | |
|---|---|
| `npm start` | launch the full stack |
| `npm run stop` | terminate Theia + LLM server + Telegram bridge background processes |
| `npm run logs` | tail the Theia log |
| `npm run logs:llm` | tail the LLM server log |
| `npm run logs:telegram` | tail the Telegram bridge log |
| `npm run window` | open another desktop window pointing at the running proxy |
| `npm run bootstrap` | re-run the full install (yarn → patch-package → native rebuild) |

---

### LLM model setup

The LLM server proxies to a local llama.cpp instance on `127.0.0.1:8080`. To enable AI features:

1. Place a GGUF model in [IPE/models/](IPE/models/) and put its filename in `GEMMA_MODEL` in [IPE/.env](IPE/.env.example).
2. Drop `llama-server.exe` (from [llama.cpp releases](https://github.com/ggerganov/llama.cpp/releases)) into the same `IPE/models/` directory. `start-llm.ps1` auto-launches it on first run.
3. Restart with `npm run stop && npm start`.

You can also configure models in-app from Theia's setup panel once the IDE loads.

---

### Telegram bridge — chat with your agent from your phone

1. Talk to [@BotFather](https://t.me/botfather), `/newbot`, paste the token into `TELEGRAM_BOT_TOKEN` in [IPE/.env](IPE/.env.example).
2. `npm start`, message your bot anything. It rejects the message with your `chat_id` printed.
3. Paste that id into `TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated for multiple users), then `npm run stop && npm start`.
4. Slash commands inside the chat: `/start /help /reset /mode <chat|terminal> /status /whoami`.

---

### Native module patches (Windows + Node 24)

Theia ships several native addons (`drivelist`, `keytar`, `node-pty`, `nsfw`, `msgpackr-extract`) that don't have prebuilds for Node ABI 137. Two compatibility issues come up on a fresh Windows install:

1. **Node 24's bundled `common.gypi` forces the `ClangCL` MSBuild toolset** — but most VS Build Tools setups only have the `v143` MSVC toolset installed. We pin `clang=false` in [IPE/.npmrc](IPE/.npmrc) so node-gyp falls back to MSVC.
2. **node-pty 0.11 doesn't compile under MSVC C++20 strict mode + modern Win SDK.** Five small patches captured in [IPE/patches/node-pty+0.11.0-beta24.patch](IPE/patches/) fix:
   - `PFNCREATEPSEUDOCONSOLE` typedefs hidden behind a `#ifdef` the modern SDK trips
   - `goto cleanup;` past initialized variables (replaced with inline cleanup macro)
   - bat-script invocations that fail when cmd's CWD search is disabled (`NoDefaultCurrentDirectoryInExePath`)
   - `/Zc:gotoScope-` and `-std:c++17` flags

Patches reapply automatically via [patch-package](https://github.com/ds300/patch-package) on every install. If you reinstall, run `npm run bootstrap` rather than raw `yarn install` — bootstrap uses `--ignore-scripts` to defeat the chicken-and-egg between auto-rebuild and patch application.

---

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `bindings.js: Could not locate the bindings file` | Native module not rebuilt for your Node ABI | `npm run bootstrap` |
| `Bad gateway` / `503` from `/api/chat` | LLM server died or hasn't booted | `npm run logs:llm` to inspect; check that a GGUF model and `llama-server.exe` are in `IPE/models/` |
| Stale PID lockout (refuses to relaunch) | Should not happen — the launcher cross-checks PID + port and clears stale state. If it does, `rm IPE/.*.pid` then `npm start`. |
| Window doesn't pop up | Edge/Chrome not installed, or `OPEN_WINDOW=false` set in `.env` | Open `http://localhost:3000` in any browser; the IDE works equally well as a tab |
| WebSocket disconnects on Theia load | Proxy was killed but Theia is still running on port 3001 | `npm run stop` and re-run `npm start` |

### Configuration

All runtime configuration lives in [IPE/.env](IPE/.env.example). Key knobs:

```bash
IDE_PORT=3000               # public-facing port (proxy)
LLM_SERVER_PORT=8000        # FastAPI proxy port
START_LLM_SERVER=true       # set false if you run the LLM server yourself
OPEN_WINDOW=true            # set false on headless servers
TELEGRAM_BOT_TOKEN=         # blank disables the Telegram bridge
TELEGRAM_ALLOWED_CHAT_IDS=
```

### Key Features

- **Gemma AI Agent** — Chat, inline completion, refactoring, autonomous terminal agent
- **Eclipse Theia Foundation** — Full VS Code-compatible IDE experience
- **Pure Local Execution** — No Docker, runs natively on your host machine
- **iPad & Mobile Access** — Connect from any device on local Wi-Fi via `http://<your-ip>:3000`
- **Telegram Bridge** — Talk to the agent from anywhere
- **One-Command Bootstrap** — `npm run bootstrap` handles patches, native builds, and venv setup

### License

[MIT](LICENSE)
