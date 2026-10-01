"""Data Source Registry.

Static metadata (licence, attribution, cadence, limits...) lives in
``data/registry/sources.json`` and is version-controlled. Runtime status (last sync,
latency, record counts, errors) is computed from the ``sync_runs`` table and merged in
at read time, so the registry is always the single place to answer "where did this come from?".
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


class License(BaseModel):
    name: str
    url: str
    commercial_use: bool
    notes: str | None = None


class Auth(BaseModel):
    required: bool
    optional_env: str | None = None
    how_to_get: str | None = None


class Reliability(BaseModel):
    rating: str
    rationale: str


class SourceMeta(BaseModel):
    id: str
    name: str
    provider: str
    category: str
    hazards: list[str] = Field(default_factory=list)
    homepage: str
    docs_url: str
    hosts: list[str]
    license: License
    attribution: str
    update_interval: str
    expected_latency: str
    coverage: dict[str, str]
    resolution: str
    historical_depth: str
    rate_limits: str
    auth: Auth
    cache_strategy: str
    reliability: Reliability
    parser_version: str
    default_enabled: bool
    limitations: list[str] = Field(default_factory=list)

    @property
    def reliability_score(self) -> float:
        return {"A": 1.0, "B": 0.8, "C": 0.6}.get(self.reliability.rating, 0.5)


class Registry:
    def __init__(self, sources: list[SourceMeta], verified_at: str) -> None:
        self.sources = {s.id: s for s in sources}
        self.verified_at = verified_at

    def get(self, source_id: str) -> SourceMeta | None:
        return self.sources.get(source_id)

    def all_hosts(self) -> set[str]:
        return {h for s in self.sources.values() for h in s.hosts}

    def attribution(self, source_ids: list[str]) -> list[str]:
        return [self.sources[s].attribution for s in source_ids if s in self.sources]

    def to_list(self) -> list[dict[str, Any]]:
        return [s.model_dump() for s in self.sources.values()]


def load_registry(path: Path) -> Registry:
    data = json.loads(path.read_text("utf-8"))
    return Registry([SourceMeta.model_validate(s) for s in data["sources"]], data.get("verified_at", ""))


@lru_cache(maxsize=4)
def cached_registry(path: str) -> Registry:
    return load_registry(Path(path))
