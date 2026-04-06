# PSC — PARK Systems Corporation Open Source

## Gemma Theia IDE

AI-powered local coding IDE built on [Eclipse Theia](https://theia-ide.org/) with [Google Gemma 4](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) agent capabilities.

> **Status:** Beta — ready for testing and contributions.

### Quick Start

```bash
cd PSC
npm start
```

`npm start` bootstraps `IPE/.env`, mounts the full cloned repo into the IDE, and launches the Docker stack from the repo root.

If no model is present yet, `npm start` still launches the IDE and shows an in-app setup flow so users can configure and download a model from the UI.

Inside the IDE, the integrated terminal runs with admin-level access in the container and includes common dev tools like `git`, `docker`, `python`, `ripgrep`, and build tooling.

### Key Features

- **Gemma 4 AI Agent** — Chat, inline completion, refactoring, and autonomous terminal agent
- **Eclipse Theia Foundation** — Full VS Code-compatible IDE experience
- **iPad & Mobile Access** — Connect from any device via local WiFi or Railway cloud tunnel
- **Local-First** — All AI inference runs on your machine via llama.cpp or vLLM
- **Docker Compose** — One command to start everything

### License

[MIT](LICENSE)
