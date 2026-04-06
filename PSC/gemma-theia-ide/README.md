# Gemma Theia IDE

AI-powered local coding IDE built on [Eclipse Theia](https://theia-ide.org/) with [Google Gemma 4](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) agent capabilities. Connect from desktop, iPad, or mobile.

## Features

- **Full Agentic AI Assistant** — Chat panel with streaming responses, context-aware code generation, debugging, and refactoring powered by Gemma 4
- **Inline Code Completion** — Ghost-text suggestions as you type, triggered by `Ctrl+Shift+Space`
- **Autonomous Terminal Agent** — Describe a task in natural language; the agent plans and executes multi-step shell commands
- **Dual Connection Modes** — Switch between Local Network (same WiFi) and Railway Tunnel (anywhere on internet) with a tab UI
- **iPad & Mobile Optimized** — Touch-friendly controls, responsive layout, PWA support with Add to Home Screen
- **Flexible Model Backend** — llama.cpp (GGUF) or vLLM (HuggingFace), auto-selects best model for your GPU

## Quick Start

```bash
# 1. Clone
git clone <your-repo-url> gemma-theia-ide
cd gemma-theia-ide

# 2. Run setup (checks GPU, downloads model)
chmod +x scripts/*.sh
./scripts/setup.sh

# 3. Start
docker compose up -d

# 4. Open
# Desktop: http://localhost:3000
# Mobile:  http://<your-local-ip>:3000
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    NGINX (port 3000)                     │
│            Reverse proxy + WebSocket + SSE               │
├──────────────────────┬──────────────────────────────────┤
│                      │                                   │
│  ┌────────────────┐  │  ┌─────────────────────────────┐ │
│  │  Eclipse Theia │  │  │     LLM Agent Server        │ │
│  │  Browser IDE   │  │  │     (FastAPI)               │ │
│  │                │  │  │                             │ │
│  │  Extensions:   │  │  │  /api/chat    → streaming   │ │
│  │  - AI Chat     │◄─┼──│  /api/complete → inline     │ │
│  │  - Completion  │  │  │  /api/terminal → agent      │ │
│  │  - Terminal    │  │  │  /api/refactor → transform  │ │
│  │  - Connection  │  │  │                             │ │
│  │  - Mobile UI   │  │  └──────────┬──────────────────┘ │
│  └────────────────┘  │             │                     │
│                      │  ┌──────────▼──────────────────┐ │
│                      │  │   llama.cpp / vLLM Server   │ │
│                      │  │   Gemma 4 (4B/12B/27B)      │ │
│                      │  └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Connection Modes

### Local Network
Your iPad/phone connects over WiFi. Open the **Connection Manager** panel (`Ctrl+Shift+P` > "Toggle Connection Manager") to see your local URL and QR code.

### Railway Tunnel
Access from anywhere over the internet:
```bash
# Install Railway CLI
npm i -g @railway/cli
railway login

# Start tunnel
./scripts/start-railway.sh
```

## Keybindings

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+G` | Toggle AI Chat panel |
| `Ctrl+Shift+E` | Explain selected code |
| `Ctrl+Shift+Space` | Trigger inline completion |
| `Tab` | Accept inline completion |
| `Escape` | Dismiss inline completion |

## Configuration

Copy `.env.example` to `.env` and customize:

| Variable | Default | Description |
|---|---|---|
| `LLM_BACKEND` | `llamacpp` | `llamacpp` or `vllm` |
| `GEMMA_MODEL` | `gemma-4-12b-it-Q4_K_M.gguf` | Model filename |
| `GPU_LAYERS` | `-1` | GPU layers (-1 = all, 0 = CPU) |
| `CTX_SIZE` | `8192` | Context window |
| `IDE_PORT` | `3000` | IDE access port |

### Using vLLM instead of llama.cpp

```bash
# Set in .env
LLM_BACKEND=vllm
HF_TOKEN=your_huggingface_token

# Start with vLLM profile
docker compose --profile vllm up -d
```

## Project Structure

```
gemma-theia-ide/
├── applications/browser/     # Theia browser application
├── extensions/
│   ├── ai-chat/              # AI chat sidebar (streaming)
│   ├── ai-completion/        # Inline code completion
│   ├── ai-terminal/          # Terminal agent (multi-step)
│   ├── connection-manager/   # Local/Railway switcher
│   └── mobile-ui/            # Mobile responsive styles
├── llm-server/               # FastAPI LLM proxy
├── nginx/                    # Reverse proxy config
├── scripts/                  # Setup and launch scripts
├── docker-compose.yml        # Full stack orchestration
├── Dockerfile.theia          # Theia build
└── Dockerfile.llm-server     # LLM server build
```

## Development

```bash
# Install dependencies
yarn install

# Build all extensions
yarn build

# Watch mode (rebuild on changes)
yarn watch

# Start dev server
yarn start
```

## License

MIT
