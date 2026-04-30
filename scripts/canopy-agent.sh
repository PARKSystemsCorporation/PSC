#!/usr/bin/env bash
set -euo pipefail

# Canopy runs agents inside WSL/tmux. The PSC agent tools are installed in the
# Windows Python venv, so this wrapper translates the current WSL repo path into
# a Windows path and launches the matching local agent executable there.

agent="${1:-ra-aid}"
psc_win_root="${PSC_WIN_ROOT:-C:\\PSC}"
model="${LLM_MODEL:-deepseek-coder-v2:16b}"
ctx_size="${CTX_SIZE:-4096}"

if ! command -v wslpath >/dev/null 2>&1; then
  echo "canopy-agent.sh must run inside WSL so it can translate paths with wslpath." >&2
  exit 1
fi

workspace_win="$(wslpath -w "$PWD")"
venv_scripts="${psc_win_root}\\IPE\\llm-server\\.venv\\Scripts"

case "$agent" in
  ra-aid|ra_aid|raid)
    exe="${venv_scripts}\\ra-aid.exe"
    ps_command="Set-Location -LiteralPath '${workspace_win}'; \$env:PSC_TARGET_WORKSPACE='${workspace_win}'; \$env:LLM_MODEL='${model}'; \$env:OLLAMA_BASE_URL='http://127.0.0.1:11434'; \$env:OLLAMA_API_BASE='http://127.0.0.1:11434'; & '${exe}' --provider ollama --model '${model}' --num-ctx '${ctx_size}' --expert-provider ollama --expert-model '${model}' --expert-num-ctx '${ctx_size}' --use-aider --log-mode console"
    ;;
  aider)
    exe="${venv_scripts}\\aider.exe"
    ps_command="Set-Location -LiteralPath '${workspace_win}'; \$env:PSC_TARGET_WORKSPACE='${workspace_win}'; \$env:LLM_MODEL='${model}'; \$env:OLLAMA_BASE_URL='http://127.0.0.1:11434'; \$env:OLLAMA_API_BASE='http://127.0.0.1:11434'; & '${exe}' --model 'ollama_chat/${model}' --no-pretty --no-stream --no-fancy-input --no-notifications --no-show-model-warnings --no-check-update --encoding utf-8"
    ;;
  *)
    echo "Unknown canopy agent '${agent}'. Use 'ra-aid' or 'aider'." >&2
    exit 1
    ;;
esac

exec powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ps_command"
