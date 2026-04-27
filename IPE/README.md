# PSC — PARK Systems Corporation Open Source

## Gemma Theia IDE (Native Local Edition)

AI-powered local coding IDE built on [Eclipse Theia](https://theia-ide.org/) with [Google Gemma 4](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) agent capabilities.

> **Status:** Beta — ready for testing and contributions.

This project has been completely overhauled to run **entirely locally and natively on Windows**, with Docker completely removed for a true offline local-first experience.

### Quick Start

1. **Install Node modules & Build native extensions**
   ```bash
   cd PSC/IPE
   corepack yarn install
   yarn build
   ```

2. **Start the IDE**
   ```bash
   cd PSC
   npm start
   ```

`npm start` now natively bootstraps `IPE/.env`, mounts the full cloned repo into the local IDE process, and serves the UI over `http://localhost:3000`.

### Starting the AI Server

To use the AI capabilities, you need to run the Python LLM server proxy alongside the IDE:

```powershell
.\scripts\start-llm.ps1
```

This script will automatically create a local Python virtual environment (`.venv`), install dependencies, and launch the server. Ensure you have Python installed on your system. 

*(Note: You will also need a local instance of `llama.cpp` or vLLM running to serve the GGUF model files).*

### Key Features

- **Gemma 4 AI Agent** — Chat, inline completion, refactoring, and autonomous terminal agent
- **Eclipse Theia Foundation** — Full VS Code-compatible IDE experience
- **Pure Local Execution** — No Docker, no container overhead, running natively on your host machine.
- **iPad & Mobile Access** — Connect from any device via local WiFi
- **Local-First** — All AI inference runs on your machine via llama.cpp or vLLM

### License

[MIT](LICENSE)
