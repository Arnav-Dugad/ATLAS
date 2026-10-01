"""In-process event bus feeding the Server-Sent Events stream.

Publishing is thread-safe (ingestion runs in worker threads); subscribers are bounded
queues that drop their oldest message rather than letting a slow browser tab grow memory.
"""

from __future__ import annotations

import asyncio
import itertools
from typing import Any

from atlas.util.timeutil import iso_z, utcnow


class EventBus:
    def __init__(self, maxsize: int = 512) -> None:
        self._subs: set[asyncio.Queue[dict[str, Any]]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._maxsize = maxsize
        self._seq = itertools.count(1)
        self.recent: list[dict[str, Any]] = []

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._maxsize)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subs.discard(q)

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)

    def publish(self, kind: str, data: dict[str, Any]) -> None:
        event = {"id": next(self._seq), "kind": kind, "at": iso_z(utcnow()), "data": data}
        self.recent = [*self.recent[-99:], event]
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._fanout(event)
        else:
            loop.call_soon_threadsafe(self._fanout, event)

    def _fanout(self, event: dict[str, Any]) -> None:
        for q in list(self._subs):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(event)
