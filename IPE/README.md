# PSC — PARK Systems Corporation Open Source

## Gemma Theia IDE

AI-powered local coding IDE built on [Eclipse Theia](https://theia-ide.org/) with [Google Gemma 4](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) agent capabilities.

> **Status:** Beta — ready for testing and contributions.

### Quick Start

```bash
cd PSC/gemma-theia-ide
./scripts/setup.sh        # Detects GPU, downloads Gemma 4 model
docker compose up -d      # Launches full stack
# Open http://localhost:3000
```

See the full documentation in [`PSC/gemma-theia-ide/README.md`](PSC/gemma-theia-ide/README.md).

### Key Features

- **Gemma 4 AI Agent** — Chat, inline completion, refactoring, and autonomous terminal agent
- **Eclipse Theia Foundation** — Full VS Code-compatible IDE experience
- **iPad & Mobile Access** — Connect from any device via local WiFi or Railway cloud tunnel
- **Local-First** — All AI inference runs on your machine via llama.cpp or vLLM
- **Docker Compose** — One command to start everything

### License

[MIT](LICENSE)
