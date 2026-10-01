"""On-disk HTTP response cache with validator support.

Bodies are stored as ``<sha256>.bin`` with a ``<sha256>.json`` sidecar holding validators
(ETag / Last-Modified), freshness and provenance. The sidecar format is intentionally plain
so the Storage view and the CLI can inspect it without touching the database.
"""

from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from atlas.util.timeutil import iso_z, parse_iso


@dataclass
class CacheEntry:
    key: str
    url: str
    fetched_at: datetime
    expires_at: datetime
    status: int
    size: int
    content_type: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    source_id: str | None = None

    def to_json(self) -> str:
        data = asdict(self)
        data["fetched_at"] = iso_z(self.fetched_at)
        data["expires_at"] = iso_z(self.expires_at)
        return json.dumps(data)

    @classmethod
    def from_json(cls, text: str) -> CacheEntry:
        data = json.loads(text)
        data["fetched_at"] = parse_iso(data["fetched_at"])
        data["expires_at"] = parse_iso(data["expires_at"])
        return cls(**data)


class HttpCache:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    @staticmethod
    def key_for(url: str) -> str:
        return hashlib.sha256(url.encode("utf-8")).hexdigest()

    def _paths(self, key: str) -> tuple[Path, Path]:
        return self.root / f"{key}.bin", self.root / f"{key}.json"

    def get(self, url: str) -> tuple[CacheEntry, Path] | None:
        key = self.key_for(url)
        body, meta = self._paths(key)
        if not (body.exists() and meta.exists()):
            return None
        try:
            entry = CacheEntry.from_json(meta.read_text("utf-8"))
        except (ValueError, KeyError, TypeError):
            return None
        return entry, body

    def read_body(self, path: Path) -> bytes:
        return path.read_bytes()

    def put(self, entry: CacheEntry, content: bytes) -> Path:
        body, meta = self._paths(entry.key)
        with self._lock:
            tmp = body.with_suffix(".tmp")
            tmp.write_bytes(content)
            tmp.replace(body)  # atomic on the same volume
            meta.write_text(entry.to_json(), "utf-8")
        return body

    def touch(self, entry: CacheEntry) -> None:
        _, meta = self._paths(entry.key)
        with self._lock:
            meta.write_text(entry.to_json(), "utf-8")

    def entries(self) -> list[CacheEntry]:
        out: list[CacheEntry] = []
        for meta in self.root.glob("*.json"):
            try:
                out.append(CacheEntry.from_json(meta.read_text("utf-8")))
            except (ValueError, KeyError, TypeError):
                continue
        return out

    def total_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.root.glob("*.bin"))

    def clear(self, source_id: str | None = None) -> int:
        removed = 0
        with self._lock:
            for meta in list(self.root.glob("*.json")):
                try:
                    entry = CacheEntry.from_json(meta.read_text("utf-8"))
                except (ValueError, KeyError, TypeError):
                    entry = None
                if source_id and (entry is None or entry.source_id != source_id):
                    continue
                body = meta.with_suffix(".bin")
                for p in (meta, body):
                    if p.exists():
                        p.unlink()
                removed += 1
        return removed
