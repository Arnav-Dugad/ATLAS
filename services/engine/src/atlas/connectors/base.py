"""Plug-in connector interface.

A connector owns everything provider-specific: endpoints, cadence, parsing and mapping
into the canonical :class:`~atlas.models.Observation`. It knows nothing about storage or
correlation, so any source can be replaced or disabled without touching the engine.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from atlas.models import Observation
from atlas.util.geo import valid_coordinate
from atlas.util.timeutil import utcnow

if TYPE_CHECKING:
    from atlas.config import Settings
    from atlas.http.client import FetchResult, HttpClient
    from atlas.registry import Registry


class Capability(StrEnum):
    LATEST = "latest"
    HISTORICAL = "historical"
    GEOMETRY = "geometry"
    DETECTIONS = "detections"
    CONTEXT = "context"


@dataclass
class ConnectorContext:
    http: HttpClient
    settings: Settings
    registry: Registry


@dataclass
class DetectionFile:
    """A raw detection file to be bulk-loaded by the engine (e.g. FIRMS CSV)."""

    path: Path
    instrument: str
    satellite_hint: str
    product: str


@dataclass
class FetchOutcome:
    observations: list[Observation] = field(default_factory=list)
    detection_files: list[DetectionFile] = field(default_factory=list)
    received: int = 0
    rejected: int = 0
    filtered: int = 0
    bytes: int = 0
    latency_ms: float = 0.0
    from_cache: bool = False
    stale: bool = False
    data_time: datetime | None = None
    notes: list[str] = field(default_factory=list)
    # When true, observations of this source absent from this batch should be considered
    # closed (the feed is a complete snapshot of current events).
    complete_snapshot: bool = False

    def absorb(self, result: FetchResult) -> None:
        self.bytes += result.size
        self.latency_ms += result.latency_ms
        self.from_cache = self.from_cache or result.from_cache
        self.stale = self.stale or result.stale

    def merge(self, other: FetchOutcome) -> None:
        self.observations.extend(other.observations)
        self.detection_files.extend(other.detection_files)
        self.received += other.received
        self.rejected += other.rejected
        self.filtered += other.filtered
        self.bytes += other.bytes
        self.latency_ms += other.latency_ms
        self.from_cache = self.from_cache or other.from_cache
        self.stale = self.stale or other.stale
        if other.data_time and (self.data_time is None or other.data_time > self.data_time):
            self.data_time = other.data_time
        self.notes.extend(other.notes)


@dataclass
class Job:
    """A periodic unit of work a connector asks the scheduler to run."""

    name: str
    interval: timedelta
    run: Callable[[], Awaitable[FetchOutcome]]
    run_on_start: bool = True


class DataConnector(ABC):
    id: ClassVar[str]
    name: ClassVar[str]
    capabilities: ClassVar[frozenset[Capability]] = frozenset({Capability.LATEST})

    def __init__(self, ctx: ConnectorContext) -> None:
        self.ctx = ctx
        self.log = logging.getLogger(f"atlas.connector.{self.id}")

    # -- lifecycle -------------------------------------------------------------------
    def availability(self) -> tuple[bool, str | None]:
        """Whether the connector can run, and if not, a human-readable reason."""
        return True, None

    async def initialize(self) -> None:
        """Optional one-off setup (e.g. warm caches)."""

    @abstractmethod
    def jobs(self) -> list[Job]:
        """Periodic jobs this connector contributes to the scheduler."""

    async def fetch_historical(self, start: datetime, end: datetime, **filters: object) -> FetchOutcome:
        raise NotImplementedError(f"{self.id} does not support historical queries")

    # -- validation shared by all connectors ----------------------------------------
    def validate(self, obs: Observation) -> str | None:
        """Return a rejection reason, or None if the observation is acceptable."""
        if not obs.title.strip():
            return "empty title"
        if (obs.lat is not None or obs.lon is not None) and not valid_coordinate(obs.lat, obs.lon):
            return f"invalid coordinate ({obs.lat}, {obs.lon})"
        if obs.event_time.year < 1800:
            return "event time before 1800"
        if obs.event_time > utcnow() + timedelta(days=1) and obs.end_time is None:
            return "event time in the future"
        if obs.depth_km is not None and not (-10.0 <= obs.depth_km <= 800.0):
            return f"implausible depth {obs.depth_km}"
        if obs.magnitude is not None and obs.magnitude != obs.magnitude:  # NaN
            return "NaN magnitude"
        return None

    def accept(self, outcome: FetchOutcome, obs: Observation) -> None:
        reason = self.validate(obs)
        if reason:
            outcome.rejected += 1
            self.log.debug("rejected %s: %s", obs.id, reason)
            return
        outcome.observations.append(obs)
        ts = obs.source_updated_at or obs.event_time
        if outcome.data_time is None or ts > outcome.data_time:
            outcome.data_time = ts
