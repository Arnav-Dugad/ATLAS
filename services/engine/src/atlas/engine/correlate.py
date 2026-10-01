"""Correlation engine: decide which incident an observation belongs to.

Order of evidence:
  1. Shared external identifiers (USGS id embedded in GDACS geometry, GLIDE numbers, NHC
     storm ids, GDACS ids referenced by EONET). These are exact and win outright.
  2. Spatio-temporal matching with hazard-specific tolerances, magnitude agreement and
     storm-name similarity. The best-scoring candidate above zero wins.

Tolerances are documented in docs/METHODOLOGY.md and unit-tested; they were chosen from
the positional/timing uncertainty of the feeds, not tuned to make demos look good.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from rapidfuzz import fuzz

from atlas.models import Hazard, Observation
from atlas.util.geo import bbox_contains, haversine_km
from atlas.util.text import normalize_storm_name


@dataclass(frozen=True)
class Rule:
    max_km: float
    max_gap: timedelta
    magnitude_tol: float | None = None
    named: bool = False  # names are a strong signal (storms, volcanoes)
    named_max_km: float = 0.0


RULES: dict[Hazard, Rule] = {
    Hazard.EARTHQUAKE: Rule(max_km=120, max_gap=timedelta(seconds=150), magnitude_tol=1.0),
    Hazard.TROPICAL_CYCLONE: Rule(max_km=350, max_gap=timedelta(days=3), named=True, named_max_km=2500),
    Hazard.SEVERE_STORM: Rule(max_km=350, max_gap=timedelta(days=2), named=True, named_max_km=1500),
    Hazard.WILDFIRE: Rule(max_km=25, max_gap=timedelta(days=10)),
    Hazard.VOLCANO: Rule(max_km=30, max_gap=timedelta(days=45), named=True, named_max_km=60),
    Hazard.FLOOD: Rule(max_km=300, max_gap=timedelta(days=14)),
    Hazard.DROUGHT: Rule(max_km=1500, max_gap=timedelta(days=120)),
    Hazard.TSUNAMI: Rule(max_km=500, max_gap=timedelta(hours=6)),
    Hazard.LANDSLIDE: Rule(max_km=50, max_gap=timedelta(days=5)),
}
DEFAULT_RULE = Rule(max_km=100, max_gap=timedelta(days=3))

COMPATIBLE: dict[Hazard, frozenset[Hazard]] = {
    Hazard.TROPICAL_CYCLONE: frozenset({Hazard.TROPICAL_CYCLONE, Hazard.SEVERE_STORM}),
    Hazard.SEVERE_STORM: frozenset({Hazard.SEVERE_STORM, Hazard.TROPICAL_CYCLONE}),
}


@dataclass
class IncidentKey:
    """Lightweight in-memory view of an incident used for matching."""

    id: str
    hazard: Hazard
    lat: float | None
    lon: float | None
    started_at: datetime
    last_observation_at: datetime
    bbox: tuple[float, float, float, float] | None = None
    names: set[str] = field(default_factory=set)
    magnitude: float | None = None
    country_iso3: str | None = None
    closed: bool = False

    def absorb(self, obs: Observation) -> None:
        """Widen the key with a newly linked observation so later observations in the
        same batch can match against it."""
        self.started_at = min(self.started_at, obs.event_time)
        ts = obs.source_updated_at or obs.end_time or obs.event_time
        self.last_observation_at = max(self.last_observation_at, ts)
        for n in obs.names:
            norm = normalize_storm_name(n)
            if norm:
                self.names.add(norm)
        if self.magnitude is None and obs.magnitude is not None:
            self.magnitude = obs.magnitude
        if self.lat is None and obs.has_location():
            self.lat, self.lon = obs.lat, obs.lon


def _interval_gap(a0: datetime, a1: datetime, b0: datetime, b1: datetime) -> timedelta:
    if a1 < a0:
        a0, a1 = a1, a0
    if b1 < b0:
        b0, b1 = b1, b0
    if a1 < b0:
        return b0 - a1
    if b1 < a0:
        return a0 - b1
    return timedelta(0)


def _name_similarity(obs: Observation, inc: IncidentKey) -> float | None:
    names = {n for n in (normalize_storm_name(x) for x in obs.names) if n}
    if not names or not inc.names:
        return None
    return max(fuzz.token_set_ratio(a, b) for a in names for b in inc.names) / 100.0


def score(obs: Observation, inc: IncidentKey) -> float | None:
    """Match score in (0, 1.5], or None when the pair is incompatible."""
    if inc.hazard not in COMPATIBLE.get(obs.hazard, frozenset({obs.hazard})):
        return None
    rule = RULES.get(obs.hazard, DEFAULT_RULE)
    obs_end = obs.end_time or obs.source_updated_at or obs.event_time
    if obs.hazard is Hazard.EARTHQUAKE:
        # origin times must agree; never match a mainshock to its aftershocks
        gap = abs(obs.event_time - inc.started_at)
    else:
        gap = _interval_gap(obs.event_time, obs_end, inc.started_at, inc.last_observation_at)
    if gap > rule.max_gap:
        return None

    if not obs.has_location() or inc.lat is None or inc.lon is None:
        return None
    if inc.bbox and bbox_contains(inc.bbox, obs.lat, obs.lon):  # type: ignore[arg-type]
        dist = 0.0
    else:
        dist = haversine_km(obs.lat, obs.lon, inc.lat, inc.lon)  # type: ignore[arg-type]

    similarity = _name_similarity(obs, inc) if rule.named else None
    allowed = rule.max_km
    bonus = 0.0
    if similarity is not None:
        if similarity >= 0.88:
            allowed = max(rule.max_km, rule.named_max_km)
            bonus = 0.4
        elif similarity < 0.6 and obs.hazard in (Hazard.TROPICAL_CYCLONE, Hazard.SEVERE_STORM):
            return None  # two differently-named storms are never the same storm
    if dist > allowed:
        return None

    if rule.magnitude_tol is not None and obs.magnitude is not None and inc.magnitude is not None:
        if abs(obs.magnitude - inc.magnitude) > rule.magnitude_tol:
            return None

    if obs.hazard in (Hazard.FLOOD, Hazard.DROUGHT) and obs.country_iso3 and inc.country_iso3:
        if obs.country_iso3 != inc.country_iso3 and dist > rule.max_km / 3:
            return None

    gap_frac = gap / rule.max_gap if rule.max_gap else 0.0
    return 1.0 - 0.5 * (dist / allowed) - 0.3 * gap_frac + bonus


class Correlator:
    def __init__(self, incidents: Iterable[IncidentKey]) -> None:
        self.incidents: dict[str, IncidentKey] = {i.id: i for i in incidents}

    def add(self, key: IncidentKey) -> None:
        self.incidents[key.id] = key

    def match(self, obs: Observation, ref_incidents: list[str]) -> tuple[str | None, str]:
        """Return (incident_id, method)."""
        if ref_incidents:
            best = Counter(ref_incidents).most_common(1)[0][0]
            if best in self.incidents or best:
                return best, "external-id"
        best_id, best_score = None, 0.0
        for inc in self.incidents.values():
            if inc.closed and obs.hazard is not Hazard.EARTHQUAKE:
                continue
            s = score(obs, inc)
            if s is not None and s > best_score:
                best_id, best_score = inc.id, s
        return (best_id, "spatiotemporal") if best_id else (None, "none")
