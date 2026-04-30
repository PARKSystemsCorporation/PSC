#!/usr/bin/env python
"""PSC local agent MCP server.

This is a small stdio MCP wrapper around the same local tools PSC exposes in
the IDE: git pull, local aider editing, and read-only SQLite helpers.
It intentionally uses only the Python standard library so it can run
inside the existing llm-server venv.
"""

from __future__ import annotations

import json
import os
import shlex
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = "2024-11-05"
DEFAULT_ENV_FILE = Path(__file__).resolve().parents[1] / ".env"


def _read_env_file() -> dict[str, str]:
    env_file = Path(os.environ.get("ENV_FILE", str(DEFAULT_ENV_FILE)))
    if not env_file.exists():
        return {}

    entries: dict[str, str] = {}
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        entries[key.strip()] = value.strip()
    return entries


def _workspace() -> Path:
    env_values = _read_env_file()
    raw = (
        os.environ.get("PSC_TARGET_WORKSPACE")
        or os.environ.get("HOST_WORKSPACE")
        or env_values.get("PSC_TARGET_WORKSPACE")
        or env_values.get("HOST_WORKSPACE")
        or os.getcwd()
    )
    return Path(raw).resolve()


def _model() -> str:
    env_values = _read_env_file()
    return os.environ.get("LLM_MODEL") or env_values.get("LLM_MODEL") or "deepseek-coder-v2:16b"


def _agent_env() -> dict[str, str]:
    model = _model()
    env_values = _read_env_file()
    ollama_base_url = (
        os.environ.get("OLLAMA_API_BASE")
        or os.environ.get("OLLAMA_BASE_URL")
        or env_values.get("OLLAMA_API_BASE")
        or env_values.get("OLLAMA_BASE_URL")
        or "http://127.0.0.1:11434"
    )
    return {
        **os.environ,
        "OLLAMA_BASE_URL": ollama_base_url,
        "OLLAMA_API_BASE": ollama_base_url,
        "OLLAMA_NO_CLOUD": env_values.get("OLLAMA_NO_CLOUD") or os.environ.get("OLLAMA_NO_CLOUD") or "true",
        "AIDER_MODEL": os.environ.get("AIDER_MODEL", f"ollama_chat/{model}"),
        "AIDER_PRETTY": "false",
        "AIDER_STREAM": "false",
        "AIDER_FANCY_INPUT": "false",
        "AIDER_NOTIFICATIONS": "false",
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


def _aider_seed_files(task: str) -> list[str]:
    cwd = _workspace()
    text = task.lower()
    seed_names = [
        "package.json",
        "index.html",
        "vite.config.ts",
        "vite.config.js",
        "tsconfig.json",
        "src/main.tsx",
        "src/main.jsx",
        "src/main.ts",
        "src/main.js",
        "src/App.tsx",
        "src/App.jsx",
        "src/App.ts",
        "src/App.js",
        "src/styles/globals.css",
        "src/index.css",
        "src/App.css",
    ]
    if any(term in text for term in ["pwa", "progressive web app", "service worker", "manifest", "offline", "installable"]):
        seed_names.extend([
            "manifest.json",
            "public/manifest.json",
            "src/manifest.json",
            "sw.js",
            "public/sw.js",
            "src/sw.js",
            "src/vite-env.d.ts",
        ])

    files: list[str] = []
    seen: set[str] = set()
    for name in seed_names:
        path = cwd / name
        if not path.is_file():
            continue
        rel = str(path.relative_to(cwd))
        key = rel.lower()
        if key in seen:
            continue
        seen.add(key)
        files.append(rel)
    return files


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


def _currency_db_path() -> Path:
    raw = os.environ.get("WORLD_CURRENCY_SQLITE") or os.environ.get("PSC_CURRENCY_SQLITE")
    if not raw:
        raise ValueError("Set WORLD_CURRENCY_SQLITE to the SQLite database path first.")
    path = Path(raw).expanduser().resolve()
    if not path.exists():
        raise ValueError(f"SQLite database does not exist: {path}")
    return path


def _connect_currency_db() -> sqlite3.Connection:
    path = _currency_db_path()
    uri = f"file:{path.as_posix()}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def _sqlite_schema() -> dict[str, Any]:
    with _connect_currency_db() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT type, name, tbl_name, sql
            FROM sqlite_master
            WHERE type IN ('table', 'view', 'index', 'trigger')
            ORDER BY type, name
            """
        ).fetchall()
    return {"database": str(_currency_db_path()), "schema": [dict(row) for row in rows]}


def _sqlite_read(query: str, params: list[Any] | None = None, limit: int = 100) -> dict[str, Any]:
    normalized = query.strip().lower()
    if not (normalized.startswith("select") or normalized.startswith("with") or normalized.startswith("pragma")):
        raise ValueError("Only read-only SELECT, WITH, and PRAGMA queries are allowed.")
    if ";" in query.rstrip(";"):
        raise ValueError("Only one SQLite statement is allowed.")

    bounded_limit = max(1, min(int(limit or 100), 500))
    with _connect_currency_db() as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(query, params or [])
        rows = cursor.fetchmany(bounded_limit)
        columns = [description[0] for description in cursor.description or []]
    return {
        "database": str(_currency_db_path()),
        "columns": columns,
        "rows": [dict(row) for row in rows],
        "limit": bounded_limit,
    }


def _tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "git_pull",
            "description": "Fast-forward pull the current workspace from its configured git remote.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
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
        {
            "name": "currency_sqlite_schema",
            "description": "Inspect the configured in-world currency SQLite database schema in read-only mode.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "currency_sqlite_read",
            "description": "Run a read-only query against the configured in-world currency SQLite database.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "params": {"type": "array", "items": {}},
                    "limit": {"type": "integer", "default": 100},
                },
                "required": ["query"],
            },
        },
    ]


def _call_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    model = _model()
    timeout = int(args.get("timeout") or 1800)
    if name == "git_pull":
        return _tool_result(_run(["git", "pull", "--ff-only"], timeout=300))
    if name == "aider_task":
        task = str(args.get("task") or "").strip()
        if not task:
            raise ValueError("task is required")
        aider_args = [
            _exe("aider"),
            "--model",
            f"ollama_chat/{model}",
            "--yes-always",
            "--no-pretty",
            "--no-stream",
            "--no-fancy-input",
            "--no-notifications",
            "--no-show-model-warnings",
            "--no-check-update",
            "--encoding",
            "utf-8",
        ]
        for file in _aider_seed_files(task):
            aider_args.extend(["--file", file])
        aider_args.extend(["--message", task])
        return _tool_result(
            _run(
                aider_args,
                timeout=timeout,
            )
        )
    if name == "currency_sqlite_schema":
        return _tool_result(_sqlite_schema())
    if name == "currency_sqlite_read":
        return _tool_result(
            _sqlite_read(
                str(args.get("query") or ""),
                args.get("params") or [],
                int(args.get("limit") or 100),
            )
        )
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
