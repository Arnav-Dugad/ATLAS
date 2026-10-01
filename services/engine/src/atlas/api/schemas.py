"""Public API response models. These generate the OpenAPI schema the web client is typed from."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, Field, PlainSerializer

from atlas.models import Change, Confidence, Metric, Severity
from atlas.util.timeutil import iso_z

UtcDatetime = Annotated[datetime, PlainSerializer(lambda d: iso_z(d), return_type=str)]


class PlaceOut(BaseModel):
    name: str
    country: str | None = None
    country_iso3: str | None = None
    lat: float
    lon: float
    population: int | None = None
    distance_km: float
    bearing_deg: float
    compass: str
    description: str
    offshore_km: float | None = None
    admin1: str | None = None


class ChangeOut(BaseModel):
    id: int | None
    incident_id: str
    at: UtcDatetime
    kind: str
    field: str | None = None
    old_value: str | None = None
    new_value: str | None = None
    source: str | None = None
    observation_id: str | None = None
    summary: str
    significance: int

    @classmethod
    def of(cls, c: Change) -> ChangeOut:
        return cls.model_validate(c.model_dump())


class IncidentSummary(BaseModel):
    id: str
    hazard: str
    hazard_label: str
    title: str
    status: str
    lat: float | None
    lon: float | None
    bbox: list[float] | None
    started_at: UtcDatetime
    updated_at: UtcDatetime
    last_observation_at: UtcDatetime
    ended_at: UtcDatetime | None = None
    severity: Severity
    confidence: Confidence
    headline: list[Metric]
    country_iso3: str | None
    country_name: str | None
    place: PlaceOut | None
    source_count: int
    sources: list[str]
    change_count: int = 0
    last_change: ChangeOut | None = None


class ObservationOut(BaseModel):
    id: str
    source: str
    source_name: str
    external_id: str
    hazard: str
    title: str
    lat: float | None
    lon: float | None
    depth_km: float | None
    magnitude: float | None
    magnitude_unit: str | None
    alert_level: str | None
    status: str | None
    event_time: UtcDatetime
    end_time: UtcDatetime | None
    source_updated_at: UtcDatetime | None
    first_seen_at: UtcDatetime
    last_seen_at: UtcDatetime
    url: str | None
    description: str | None
    metrics: dict[str, Any]
    version: int


class Citation(BaseModel):
    source_id: str
    name: str
    provider: str
    attribution: str
    license: str
    license_url: str
    contributed: str
    retrieved_at: UtcDatetime | None
    source_updated_at: UtcDatetime | None
    url: str | None
    reliability: str


class OfficialLink(BaseModel):
    label: str
    url: str
    authority: str


class RelatedIncident(BaseModel):
    id: str
    title: str
    hazard: str
    severity_level: int
    status: str
    distance_km: float
    started_at: UtcDatetime
    relation: str


class IncidentDetail(IncidentSummary):
    geometry: dict[str, Any] | None
    track: list[dict[str, Any]]
    observations: list[ObservationOut]
    changes: list[ChangeOut]
    citations: list[Citation]
    official_links: list[OfficialLink]
    nearby_places: list[PlaceOut]
    related: list[RelatedIncident]
    limitations: list[str]


class IncidentList(BaseModel):
    items: list[IncidentSummary]
    total: int
    generated_at: UtcDatetime


class HazardCount(BaseModel):
    hazard: str
    label: str
    active: int
    monitoring: int
    max_severity: int


class SourceHealth(BaseModel):
    id: str
    name: str
    status: str
    last_ok: UtcDatetime | None
    data_age_s: float | None


class Overview(BaseModel):
    generated_at: UtcDatetime
    incidents_active: int
    incidents_monitoring: int
    by_hazard: list[HazardCount]
    severity_histogram: dict[str, int]
    earthquakes_24h: int
    earthquakes_24h_max_mag: float | None
    fire_detections_24h: int
    fire_clusters: int
    active_cyclones: int
    recent_changes: list[ChangeOut]
    sources: list[SourceHealth]
    observations_total: int


class SyncRunOut(BaseModel):
    id: int
    started_at: UtcDatetime
    finished_at: UtcDatetime | None
    status: str
    records_received: int
    records_accepted: int
    records_rejected: int
    records_changed: int
    bytes: int
    latency_ms: float | None
    from_cache: bool
    stale: bool
    data_time: UtcDatetime | None
    message: str | None


class SourceStatus(BaseModel):
    id: str
    meta: dict[str, Any]
    enabled: bool
    disabled_reason: str | None
    status: str  # healthy | degraded | error | disabled | idle | reference
    last_attempt: UtcDatetime | None
    last_success: UtcDatetime | None
    last_error: str | None
    data_time: UtcDatetime | None
    data_age_s: float | None
    latency_ms_p50: float | None
    stored_records: int
    runs_24h: int
    errors_24h: int
    bytes_24h: int
    jobs: list[dict[str, Any]] = Field(default_factory=list)
    recent_runs: list[SyncRunOut] = Field(default_factory=list)


class Columnar(BaseModel):
    """Compact column-oriented payload for map layers (one array per field)."""

    count: int
    columns: dict[str, list[Any]]
    generated_at: UtcDatetime
    attribution: list[str]
    note: str | None = None
