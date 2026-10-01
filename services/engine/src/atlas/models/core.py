"""Canonical ATLAS data model.

Every connector converts its upstream format into :class:`Observation`. The incident
engine fuses observations into :class:`Incident` records. Anything that is shown to a user
carries a :class:`Provenance` so the interface can always say whether a number is
measured, derived, modelled, simulated or unavailable.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from atlas.util.geo import valid_coordinate


class Hazard(StrEnum):
    EARTHQUAKE = "earthquake"
    TROPICAL_CYCLONE = "tropical_cyclone"
    WILDFIRE = "wildfire"
    FLOOD = "flood"
    VOLCANO = "volcano"
    DROUGHT = "drought"
    SEVERE_STORM = "severe_storm"
    TSUNAMI = "tsunami"
    LANDSLIDE = "landslide"
    EXTREME_HEAT = "extreme_heat"
    EXTREME_COLD = "extreme_cold"
    AIR_QUALITY = "air_quality"
    SEA_LAKE_ICE = "sea_lake_ice"
    DUST_HAZE = "dust_haze"
    OTHER = "other"


HAZARD_CODE: dict[Hazard, str] = {
    Hazard.EARTHQUAKE: "EQ",
    Hazard.TROPICAL_CYCLONE: "TC",
    Hazard.WILDFIRE: "WF",
    Hazard.FLOOD: "FL",
    Hazard.VOLCANO: "VO",
    Hazard.DROUGHT: "DR",
    Hazard.SEVERE_STORM: "ST",
    Hazard.TSUNAMI: "TS",
    Hazard.LANDSLIDE: "LS",
    Hazard.EXTREME_HEAT: "HT",
    Hazard.EXTREME_COLD: "CD",
    Hazard.AIR_QUALITY: "AQ",
    Hazard.SEA_LAKE_ICE: "IC",
    Hazard.DUST_HAZE: "DH",
    Hazard.OTHER: "OT",
}

HAZARD_LABEL: dict[Hazard, str] = {
    Hazard.EARTHQUAKE: "Earthquake",
    Hazard.TROPICAL_CYCLONE: "Tropical cyclone",
    Hazard.WILDFIRE: "Wildfire",
    Hazard.FLOOD: "Flood",
    Hazard.VOLCANO: "Volcanic activity",
    Hazard.DROUGHT: "Drought",
    Hazard.SEVERE_STORM: "Severe storm",
    Hazard.TSUNAMI: "Tsunami",
    Hazard.LANDSLIDE: "Landslide",
    Hazard.EXTREME_HEAT: "Extreme heat",
    Hazard.EXTREME_COLD: "Extreme cold",
    Hazard.AIR_QUALITY: "Air quality",
    Hazard.SEA_LAKE_ICE: "Sea & lake ice",
    Hazard.DUST_HAZE: "Dust & haze",
    Hazard.OTHER: "Other",
}


class Provenance(StrEnum):
    """How a value came to exist. Surfaced on every metric in the interface."""

    REAL = "real"  # reported by an authoritative source
    DERIVED = "derived"  # computed by ATLAS from real data, deterministic method
    MODEL = "model"  # produced by an explicitly identified statistical / ML model
    SIMULATION = "simulation"  # hypothetical scenario output, never an observation
    UNAVAILABLE = "unavailable"  # not enough reliable information


class IncidentStatus(StrEnum):
    ACTIVE = "active"
    MONITORING = "monitoring"
    CLOSED = "closed"


class ExternalRef(BaseModel):
    model_config = ConfigDict(frozen=True)
    scheme: str  # usgs | gdacs | nhc | glide | eonet | gvp | firms-cluster ...
    id: str


class TrackPoint(BaseModel):
    time: datetime
    lat: float
    lon: float
    wind_kt: float | None = None
    pressure_mb: float | None = None
    category: str | None = None
    kind: Literal["observed", "forecast"] = "observed"
    source: str | None = None


class Observation(BaseModel):
    """A single upstream record, normalised. One row per (source, external_id)."""

    source: str
    external_id: str
    hazard: Hazard
    title: str
    lat: float | None = None
    lon: float | None = None
    event_time: datetime
    end_time: datetime | None = None
    source_updated_at: datetime | None = None
    depth_km: float | None = None
    magnitude: float | None = None
    magnitude_unit: str | None = None
    alert_level: str | None = None  # green | yellow | orange | red (normalised)
    status: str | None = None  # source lifecycle state, e.g. automatic/reviewed, current/closed
    url: str | None = None
    country_iso3: str | None = None
    description: str | None = None
    metrics: dict[str, float | int | str | bool | None] = Field(default_factory=dict)
    geometry: dict[str, Any] | None = None
    track: list[TrackPoint] = Field(default_factory=list)
    external_refs: list[ExternalRef] = Field(default_factory=list)
    names: list[str] = Field(default_factory=list)
    incident_candidate: bool = True

    @property
    def id(self) -> str:
        return f"{self.source}:{self.external_id}"

    @field_validator("alert_level")
    @classmethod
    def _norm_alert(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip().lower()
        return v if v in {"green", "yellow", "orange", "red"} else None

    def has_location(self) -> bool:
        return valid_coordinate(self.lat, self.lon)


class Metric(BaseModel):
    key: str
    label: str
    value: float | int | str | bool | None
    unit: str | None = None
    provenance: Provenance
    source: str | None = None
    method: str | None = None
    observed_at: datetime | None = None
    note: str | None = None


class Severity(BaseModel):
    level: int = Field(ge=0, le=5)  # 0 = unknown
    label: str
    basis: str
    method: str = "atlas-severity-v1"
    provenance: Provenance = Provenance.DERIVED


class ConfidenceComponent(BaseModel):
    name: str
    score: float
    weight: float
    detail: str


class Confidence(BaseModel):
    score: float
    label: Literal["low", "moderate", "high", "very high"]
    components: list[ConfidenceComponent]
    method: str = "atlas-confidence-heuristic-v1"
    note: str = (
        "Heuristic summary of source count, agreement, review status and recency. "
        "It is not a calibrated probability."
    )


class PlaceRef(BaseModel):
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


class Change(BaseModel):
    id: int | None = None
    incident_id: str
    at: datetime
    kind: str
    field: str | None = None
    old_value: str | None = None
    new_value: str | None = None
    source: str | None = None
    observation_id: str | None = None
    summary: str
    significance: int = 1  # 1 info, 2 notable, 3 major
