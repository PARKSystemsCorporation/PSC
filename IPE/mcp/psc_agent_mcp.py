#!/usr/bin/env python
"""PSC local agent MCP server.

This is a small stdio MCP wrapper around the same local tools PSC exposes in
the IDE: git pull, RA.Aid as the planning/tool brain, and aider as the editing
hand. It intentionally uses only the Python standard library so it can run
inside the existing llm-server venv.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "2024-11-05"


def _workspace() -> Path:
    raw = os.environ.get("PSC_TARGET_WORKSPACE") or os.environ.get("HOST_WORKSPACE") or os.getcwd()
    return Path(raw).resolve()


def _model() -> str:
    return os.environ.get("LLM_MODEL", "qwen2.5-coder:7b")


def _agent_env() -> dict[str, str]:
    model = _model()
    return {
        **os.environ,
        "OLLAMA_BASE_URL": os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
        "AIDER_MODEL": os.environ.get("AIDER_MODEL", f"ollama_chat/{model}"),
        "AIDER_YES_ALWAYS": "true",
        "PYTHONUNBUFFERED": "1",
    }


def _shell_command(args: list[str]) -> list[str]:
    if os.name == "nt":
        return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", subprocess.list2cmdline(args)]
    return ["/bin/sh", "-lc", " ".join(shlex.quote(arg) for arg in args)]


def _exe(name: str) -> str:
    suffix = ".exe" if os.name == "nt" else ""
    candidate = Path(sys.executable).parent / f"{name}{suffix}"
    return str(candidate) if candidate.exists() else name


def _run(args: list[str], timeout: int = 1800) -> dict[str, Any]:
    result = subprocess.run(
        _shell_command(args),
        cwd=str(_workspace()),
        text=True,
        capture_output=True,
        timeout=timeout,
        env=_agent_env(),
    )
    return {
        "command": subprocess.list2cmdline(args) if os.name == "nt" else " ".join(shlex.quote(arg) for arg in args),
        "cwd": str(_workspace()),
        "exit_code": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def _tool_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}]}


def _tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "git_pull",
            "description": "Fast-forward pull the current workspace from its configured git remote.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "ra_aid_task",
            "description": "Use RA.Aid as the autonomous planning/tool brain, with aider enabled for edits.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": {"type": "string"},
                    "timeout": {"type": "integer", "default": 1800},
                },
                "required": ["task"],
            },
        },
        {
            "name": "aider_task",
            "description": "Use aider directly as the coding hand for a one-shot edit task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": {"type": "string"},
                    "timeout": {"type": "integer", "default": 1800},
                },
                "required": ["task"],
            },
        },
    ]


def _call_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    model = _model()
    timeout = int(args.get("timeout") or 1800)
    if name == "git_pull":
        return _tool_result(_run(["git", "pull", "--ff-only"], timeout=300))
    if name == "ra_aid_task":
        task = str(args.get("task") or "").strip()
        if not task:
            raise ValueError("task is required")
        return _tool_result(
            _run(
                [
                    _exe("ra-aid"),
                    "--provider",
                    "ollama",
                    "--model",
                    model,
                    "--num-ctx",
                    os.environ.get("CTX_SIZE", "8192"),
                    "--expert-provider",
                    "ollama",
                    "--expert-model",
                    model,
                    "--expert-num-ctx",
                    os.environ.get("CTX_SIZE", "8192"),
                    "--cowboy-mode",
                    "--log-mode",
                    "console",
                    "--use-aider",
                    "-m",
                    task,
                ],
                timeout=timeout,
            )
        )
    if name == "aider_task":
        task = str(args.get("task") or "").strip()
        if not task:
            raise ValueError("task is required")
        return _tool_result(_run([_exe("aider"), "--model", f"ollama_chat/{model}", "--message", task, "--yes-always"], timeout=timeout))
    raise ValueError(f"unknown tool: {name}")


def _handle(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    if method == "notifications/initialized":
        return None
    try:
        if method == "initialize":
            result = {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "psc-agent-mcp", "version": "0.1.0"},
            }
        elif method == "tools/list":
            result = {"tools": _tools()}
        elif method == "tools/call":
            params = request.get("params") or {}
            result = _call_tool(str(params.get("name")), params.get("arguments") or {})
        else:
            raise ValueError(f"unsupported method: {method}")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    except Exception as error:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(error)}}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        response = _handle(json.loads(line))
        if response is not None:
            print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
