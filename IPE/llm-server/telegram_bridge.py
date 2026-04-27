"""
Telegram bridge for the Gemma Theia LLM server.

Long-polls Telegram for messages from allow-listed chats and relays them to the
local /api/chat endpoint, sending the agent's reply back to the user. This lets
you talk to your local coding agent from your phone while away from the desk.

Configured via environment variables (read from IPE/.env via project-cli.js):

  TELEGRAM_BOT_TOKEN          Bot token from @BotFather (required)
  TELEGRAM_ALLOWED_CHAT_IDS   Comma-separated chat IDs allowed to talk to the
                              bot. Leave empty during first-time setup to learn
                              your chat id (the bot will reply with it and
                              refuse the message).
  TELEGRAM_DEFAULT_MODE       One of: chat, terminal, refactor (default: chat)
  LLM_SERVER_URL              http://127.0.0.1:8000 by default

Slash commands inside the chat:
  /start       Greeting
  /help        Show this help
  /reset       Clear conversation history
  /mode <m>    Switch agent mode (chat | terminal)
  /status      Probe local LLM server health
  /whoami      Print this chat's id
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any

import httpx


TELEGRAM_API = "https://api.telegram.org"
MAX_TELEGRAM_MESSAGE = 4000  # Telegram's hard cap is 4096; leave headroom.
MAX_HISTORY_MESSAGES = 20

LLM_SERVER_URL = os.environ.get("LLM_SERVER_URL", "http://127.0.0.1:8000").rstrip("/")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
DEFAULT_MODE = os.environ.get("TELEGRAM_DEFAULT_MODE", "chat").strip() or "chat"

_raw_allowed = os.environ.get("TELEGRAM_ALLOWED_CHAT_IDS", "").strip()
ALLOWED_CHAT_IDS: set[int] = set()
if _raw_allowed:
    for piece in _raw_allowed.replace(";", ",").split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            ALLOWED_CHAT_IDS.add(int(piece))
        except ValueError:
            print(f"[telegram] Ignoring invalid chat id: {piece!r}", flush=True)


def log(message: str) -> None:
    print(f"[telegram] {message}", flush=True)


def _telegram_url(method: str) -> str:
    return f"{TELEGRAM_API}/bot{BOT_TOKEN}/{method}"


# In-memory per-chat conversation state. Cleared on /reset and on process
# restart. Persisting this would be nice but is out of scope for v1.
chat_state: dict[int, dict[str, Any]] = {}


def _get_state(chat_id: int) -> dict[str, Any]:
    state = chat_state.get(chat_id)
    if state is None:
        state = {"messages": [], "mode": DEFAULT_MODE}
        chat_state[chat_id] = state
    return state


def _trim_history(state: dict[str, Any]) -> None:
    if len(state["messages"]) > MAX_HISTORY_MESSAGES:
        state["messages"] = state["messages"][-MAX_HISTORY_MESSAGES:]


async def _send_message(client: httpx.AsyncClient, chat_id: int, text: str) -> None:
    if not text:
        text = "(empty response)"
    for chunk_start in range(0, len(text), MAX_TELEGRAM_MESSAGE):
        chunk = text[chunk_start : chunk_start + MAX_TELEGRAM_MESSAGE]
        try:
            await client.post(
                _telegram_url("sendMessage"),
                json={"chat_id": chat_id, "text": chunk},
                timeout=30.0,
            )
        except httpx.HTTPError as exc:
            log(f"sendMessage failed for chat {chat_id}: {exc}")
            return


async def _send_typing(client: httpx.AsyncClient, chat_id: int) -> None:
    try:
        await client.post(
            _telegram_url("sendChatAction"),
            json={"chat_id": chat_id, "action": "typing"},
            timeout=10.0,
        )
    except httpx.HTTPError:
        pass


async def _call_chat_endpoint(
    client: httpx.AsyncClient, history: list[dict[str, str]], mode: str
) -> str:
    payload = {"messages": history, "mode": mode, "stream": False}
    response = await client.post(
        f"{LLM_SERVER_URL}/api/chat",
        json=payload,
        timeout=180.0,
    )
    response.raise_for_status()
    data = response.json()
    return str(data.get("content") or "").strip()


async def _handle_command(
    client: httpx.AsyncClient, chat_id: int, text: str
) -> bool:
    if not text.startswith("/"):
        return False

    parts = text.split(maxsplit=1)
    command = parts[0].split("@")[0].lower()
    argument = parts[1].strip() if len(parts) > 1 else ""

    if command == "/start":
        await _send_message(
            client,
            chat_id,
            "Hi — connected to your local coding agent.\n"
            "Send any message to chat. /help for commands.",
        )
        return True

    if command == "/help":
        await _send_message(
            client,
            chat_id,
            "Commands:\n"
            "/reset — clear conversation history\n"
            "/mode <chat|terminal> — switch agent mode\n"
            "/status — check if the local LLM is up\n"
            "/whoami — print this chat id",
        )
        return True

    if command == "/whoami":
        await _send_message(client, chat_id, f"chat_id = {chat_id}")
        return True

    if command == "/reset":
        chat_state.pop(chat_id, None)
        await _send_message(client, chat_id, "Conversation history cleared.")
        return True

    if command == "/mode":
        valid = {"chat", "terminal", "refactor"}
        choice = argument.lower()
        if choice not in valid:
            await _send_message(
                client,
                chat_id,
                f"Mode must be one of: {', '.join(sorted(valid))}",
            )
            return True
        state = _get_state(chat_id)
        state["mode"] = choice
        await _send_message(client, chat_id, f"Mode set to {choice}.")
        return True

    if command == "/status":
        try:
            response = await client.get(f"{LLM_SERVER_URL}/health", timeout=10.0)
            await _send_message(
                client, chat_id, f"LLM server: {response.status_code} {response.text[:200]}"
            )
        except httpx.HTTPError as exc:
            await _send_message(client, chat_id, f"LLM server unreachable: {exc}")
        return True

    await _send_message(client, chat_id, f"Unknown command: {command}")
    return True


async def _handle_message(
    client: httpx.AsyncClient, message: dict[str, Any]
) -> None:
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    text = (message.get("text") or "").strip()
    if chat_id is None or not text:
        return

    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        log(f"Rejected message from non-allowed chat_id={chat_id}")
        await _send_message(
            client,
            chat_id,
            f"This bot is locked down. Add {chat_id} to TELEGRAM_ALLOWED_CHAT_IDS to enable it.",
        )
        return

    if await _handle_command(client, chat_id, text):
        return

    state = _get_state(chat_id)
    state["messages"].append({"role": "user", "content": text})
    _trim_history(state)

    await _send_typing(client, chat_id)

    try:
        reply = await _call_chat_endpoint(client, state["messages"], state["mode"])
    except httpx.HTTPError as exc:
        log(f"chat call failed: {exc}")
        # Roll back the user message so the next try doesn't see a half-turn.
        state["messages"].pop()
        await _send_message(
            client,
            chat_id,
            "Local LLM is not responding. Run `npm run logs:llm` on the host to investigate.",
        )
        return
    except json.JSONDecodeError as exc:
        log(f"chat returned non-JSON: {exc}")
        state["messages"].pop()
        await _send_message(client, chat_id, "Local LLM returned an unexpected response.")
        return

    state["messages"].append({"role": "assistant", "content": reply})
    _trim_history(state)
    await _send_message(client, chat_id, reply or "(no content)")


async def _poll_loop() -> None:
    if not BOT_TOKEN:
        log("TELEGRAM_BOT_TOKEN is empty. Set it in IPE/.env and restart npm start.")
        return

    if not ALLOWED_CHAT_IDS:
        log(
            "TELEGRAM_ALLOWED_CHAT_IDS is empty — the bot will refuse every message and "
            "reply with the sender's chat id. Add it to IPE/.env and restart."
        )

    offset: int | None = None
    backoff = 1.0
    async with httpx.AsyncClient() as client:
        log(f"Connected. Forwarding to {LLM_SERVER_URL}.")
        while True:
            try:
                params = {"timeout": 30}
                if offset is not None:
                    params["offset"] = offset
                response = await client.get(
                    _telegram_url("getUpdates"),
                    params=params,
                    timeout=60.0,
                )
                response.raise_for_status()
                payload = response.json()
                if not payload.get("ok"):
                    log(f"getUpdates error: {payload}")
                    await asyncio.sleep(min(backoff, 30))
                    backoff = min(backoff * 2, 60)
                    continue

                backoff = 1.0
                for update in payload.get("result", []):
                    offset = max(offset or 0, int(update["update_id"]) + 1)
                    message = update.get("message") or update.get("edited_message")
                    if message:
                        try:
                            await _handle_message(client, message)
                        except Exception as exc:
                            log(f"handler crashed: {exc}")
            except httpx.HTTPError as exc:
                log(f"poll error: {exc}; retrying in {backoff:.0f}s")
                await asyncio.sleep(min(backoff, 30))
                backoff = min(backoff * 2, 60)


def main() -> int:
    if not BOT_TOKEN:
        log("Refusing to start with empty TELEGRAM_BOT_TOKEN.")
        return 1
    try:
        asyncio.run(_poll_loop())
    except KeyboardInterrupt:
        log("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
