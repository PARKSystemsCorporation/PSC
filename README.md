# PSC — PARK Systems Corporation Open Source

## Gemma Theia IDE

AI-powered local coding IDE built on [Eclipse Theia](https://theia-ide.org/) with [Google Gemma 4](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) agent capabilities.

> **Status:** Beta — ready for testing and contributions.

### Quick Start

```bash
cd PSC
npm start
```

`npm start` now bootstraps `IPE/.env`, mounts the full cloned repo into the IDE, and starts the Docker stack from the repo root.

If no model is present yet, `npm start` still launches the IDE and shows an in-app setup flow so users can configure and download a model from the UI.

PersonaPlex voice mode is available as an optional companion service. Set `PERSONAPLEX_ENABLED=true` in `IPE/.env`, add `HF_TOKEN` with access to `nvidia/personaplex-7b-v1`, and `npm start` will also launch the local voice UI on `https://localhost:8998`.

MemPalace memory is also supported for fully local recall. Set `MEMPALACE_ENABLED=true` in `IPE/.env`, rebuild the stack, then initialize and mine the repo with `docker compose -f IPE/docker-compose.yml exec llm-server mempalace init /workspace/project --yes` and `docker compose -f IPE/docker-compose.yml exec llm-server mempalace mine /workspace/project --wing psc`.

Inside the IDE, the integrated terminal runs with admin-level access in the container and includes common dev tools like `git`, `docker`, `python`, `ripgrep`, and build tooling.

See the project docs in [`IPE/README.md`](IPE/README.md).

### Key Features

- **Gemma 4 AI Agent** — Chat, inline completion, refactoring, and autonomous terminal agent
- **Eclipse Theia Foundation** — Full VS Code-compatible IDE experience
- **iPad & Mobile Access** — Connect from any device via local WiFi or Railway cloud tunnel
- **Local-First** — All AI inference runs on your machine via llama.cpp or vLLM
- **Optional PersonaPlex Voice UI** — Local speech-to-speech companion on a separate port
- **Optional MemPalace Memory** — Local wake-up context and search-backed recall
- **Docker Compose** — One command to start everything

### License

[MIT](LICENSE)
