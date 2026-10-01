"""Minimal client for a local Ollama server (https://ollama.com).

ATLAS only ever talks to an Ollama instance on this machine: the base URL must be a loopback
address, so questions, tool results and answers never leave the device.
"""

from __future__ import annotations

import ipaddress
import time
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit

import httpx
import orjson

# Preference order among models that support tool calling (first installed one wins).
PREFERRED_MODELS = (
    "qwen3:8b",
    "qwen2.5:7b",
    "llama3.1:8b",
    "qwen3:4b",
    "mistral-nemo",
    "llama3.2:3b",
    "qwen2.5:3b",
)
RECOMMENDED = "qwen2.5:7b"


class OllamaUnavailable(Exception):
    pass


def require_loopback(base_url: str) -> str:
    u = urlsplit(base_url)
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https") or not host:
        raise ValueError("Ollama URL must be http(s)://host:port")
    if host != "localhost":
        try:
            if not ipaddress.ip_address(host).is_loopback:
                raise ValueError("Ollama must run on this machine (loopback address)")
        except ValueError as exc:
            raise ValueError("Ollama must run on this machine (loopback address)") from exc
    return base_url.rstrip("/")


class OllamaClient:
    def __init__(self, base_url: str = "http://127.0.0.1:11434", *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.base_url = require_loopback(base_url)
        self._client = httpx.AsyncClient(
            base_url=self.base_url, timeout=httpx.Timeout(300.0, connect=3.0), transport=transport, trust_env=False
        )
        self._models_cache: tuple[float, list[dict[str, Any]]] | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def version(self) -> str | None:
        try:
            r = await self._client.get("/api/version", timeout=3.0)
            r.raise_for_status()
            return str(r.json().get("version"))
        except (httpx.HTTPError, ValueError):
            return None

    async def models(self) -> list[dict[str, Any]]:
        """Installed models with whether they support tool calling (cached 60 s)."""
        now = time.monotonic()
        if self._models_cache and now - self._models_cache[0] < 60:
            return self._models_cache[1]
        try:
            r = await self._client.get("/api/tags", timeout=5.0)
            r.raise_for_status()
            tags = r.json().get("models") or []
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaUnavailable(str(exc)) from exc
        out: list[dict[str, Any]] = []
        for m in tags:
            name = str(m.get("name") or m.get("model") or "")
            if not name:
                continue
            caps: list[str] = []
            try:
                s = await self._client.post("/api/show", json={"model": name}, timeout=10.0)
                if s.status_code == 200:
                    caps = list(s.json().get("capabilities") or [])
            except (httpx.HTTPError, ValueError):
                pass
            details = m.get("details") or {}
            out.append(
                {
                    "name": name,
                    "tools": "tools" in caps if caps else None,  # None = unknown (older Ollama)
                    "size_bytes": m.get("size"),
                    "family": details.get("family"),
                    "parameters": details.get("parameter_size"),
                    "quantization": details.get("quantization_level"),
                }
            )
        self._models_cache = (now, out)
        return out

    @staticmethod
    def choose(models: list[dict[str, Any]], wanted: str | None) -> str | None:
        names = [m["name"] for m in models if m.get("tools") is not False]
        if wanted and wanted in names:
            return wanted
        for pref in PREFERRED_MODELS:
            for n in names:
                if n == pref or n.startswith(pref + "-") or n == f"{pref}:latest":
                    return n
        return names[0] if names else None

    async def chat_stream(
        self, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield Ollama's streamed chat chunks (one JSON object per line)."""
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "think": False,
            "options": {"temperature": 0.2, "num_ctx": 8192},
        }
        if tools:
            body["tools"] = tools
        try:
            async with self._client.stream(
                "POST", "/api/chat", content=orjson.dumps(body), headers={"Content-Type": "application/json"}
            ) as r:
                if r.status_code != 200:
                    detail = (await r.aread()).decode("utf-8", "replace")[:300]
                    raise OllamaUnavailable(f"Ollama returned {r.status_code}: {detail}")
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        chunk = orjson.loads(line)
                    except orjson.JSONDecodeError:
                        continue
                    if isinstance(chunk, dict):
                        if chunk.get("error"):
                            raise OllamaUnavailable(str(chunk["error"]))
                        yield chunk
        except httpx.HTTPError as exc:
            raise OllamaUnavailable(f"Cannot reach Ollama at {self.base_url}: {exc}") from exc
