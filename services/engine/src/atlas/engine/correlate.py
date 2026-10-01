"""Correlation engine: decide which incident an observation belongs to.

Order of evidence:
  1. Shared external identifiers (USGS id embedded in GDACS geometry, GLIDE numbers, NHC
     storm ids, GDACS ids referenced by EONET). These win unless the pair is contradictory
     (different storm names, or thousands of km apart): upstream ids are occasionally reused.
  2. Spatio-temporal matching with hazard-specific tolerances, magnitude agreement and
     storm-name similarity. The best-scoring candidate above zero wins.

Tolerances are documented in docs/METHODOLOGY.md and unit-tested; they were chosen from
the positional/timing uncertainty of the feeds, not tuned to make demos look good.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from rapidfuzz import fuzz

from atlas.models import Hazard, Observation
from atlas.util.geo import bbox_contains, haversine_km
from atlas.util.text import normalize_storm_name

log = logging.getLogger("atlas.correlate")


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


_NUMBER_WORDS = frozenset((
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
    "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "unnamed", "unknown",
))  # fmt: skip


def is_storm_designation(name: str) -> bool:
    """True for placeholder designations ('fifteen e', '15e', '91l', 'twenty one') rather than a
    proper storm name. A numbered depression is legitimately renamed once it strengthens."""
    tokens = name.split()
    return bool(tokens) and all(t in _NUMBER_WORDS or any(c.isdigit() for c in t) or len(t) == 1 for t in tokens)


STORMS = (Hazard.TROPICAL_CYCLONE, Hazard.SEVERE_STORM)
# A shared external id is trusted unless the pair is this far apart (and outside the incident's extent).
EXTERNAL_ID_MAX_KM = 2500.0


def _designations(names: Iterable[str]) -> set[str]:
    return {n for n in names if n and is_storm_designation(n)}


def _designation_conflict(obs: Observation, inc: IncidentKey) -> bool:
    """'Nineteen-E' and 'Eighteen-E' are different depressions even when neither has a name yet."""
    mine = _designations(normalize_storm_name(x) for x in obs.names)
    theirs = _designations(inc.names)
    return bool(mine and theirs and not mine & theirs)


def ref_conflict(obs: Observation, inc: IncidentKey) -> str | None:
    """Evidence that a shared external id is wrong. Upstream ids are occasionally reused; GDACS has
    issued one GLIDE number to two different storms. Returns the reason, or None if consistent."""
    if obs.hazard in STORMS:
        similarity = _name_similarity(obs, inc)
        if similarity is not None and similarity < 0.88:
            return "storm names differ"
        if similarity is None and _designation_conflict(obs, inc):
            return "storm designations differ"
    if obs.has_location() and inc.lat is not None and inc.lon is not None:
        inside = inc.bbox is not None and bbox_contains(inc.bbox, obs.lat, obs.lon)  # type: ignore[arg-type]
        if not inside and haversine_km(obs.lat, obs.lon, inc.lat, inc.lon) > EXTERNAL_ID_MAX_KM:  # type: ignore[arg-type]
            return "locations too far apart"
    return None


def _name_similarity(obs: Observation, inc: IncidentKey) -> float | None:
    """Best similarity between proper names, or None when either side has no proper name."""
    names = {n for n in (normalize_storm_name(x) for x in obs.names) if n and not is_storm_designation(n)}
    theirs = {n for n in inc.names if not is_storm_designation(n)}
    if not names or not theirs:
        return None
    return max(fuzz.token_set_ratio(a, b) for a in names for b in theirs) / 100.0


TSUNAMI_WINDOW = timedelta(hours=3)
TSUNAMI_MAX_KM = 400.0


def _tsunami_score(obs: Observation, inc: IncidentKey) -> float | None:
    """A tsunami-centre message is issued minutes to hours after its earthquake, at (about) the
    same epicentre and preliminary magnitude."""
    if inc.hazard is not Hazard.EARTHQUAKE or not obs.has_location() or inc.lat is None or inc.lon is None:
        return None
    dt = obs.event_time - inc.started_at
    if dt < timedelta(minutes=-5) or dt > TSUNAMI_WINDOW:
        return None
    d = haversine_km(obs.lat, obs.lon, inc.lat, inc.lon)  # type: ignore[arg-type]
    if d > TSUNAMI_MAX_KM:
        return None
    if obs.magnitude is not None and inc.magnitude is not None and abs(obs.magnitude - inc.magnitude) > 1.0:
        return None
    return 1.0 - 0.5 * (d / TSUNAMI_MAX_KM) - 0.3 * (max(dt, timedelta(0)) / TSUNAMI_WINDOW)


def score(obs: Observation, inc: IncidentKey) -> float | None:
    """Match score in (0, 1.5], or None when the pair is incompatible."""
    if inc.hazard not in COMPATIBLE.get(obs.hazard, frozenset({obs.hazard})):
        return None
    if obs.source == "tsunami":
        return _tsunami_score(obs, inc)
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
    # A storm's extent spans its whole track, which can enclose a different, later storm.
    if inc.bbox and obs.hazard not in STORMS and bbox_contains(inc.bbox, obs.lat, obs.lon):  # type: ignore[arg-type]
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
        elif obs.hazard in STORMS:
            # Storm names are identifiers: 'Polo' and 'Nolo' are different storms however close.
            return None
    elif obs.hazard in STORMS and _designation_conflict(obs, inc):
        return None
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
        for iid, _ in Counter(ref_incidents).most_common():
            inc = self.incidents.get(iid)
            reason = ref_conflict(obs, inc) if inc is not None else None
            if reason is None:
                return iid, "external-id"
            log.warning("ignoring external-id link %s -> %s: %s", obs.id, iid, reason)
        best_id, best_score = None, 0.0
        for inc in self.incidents.values():
            if inc.closed and obs.hazard is not Hazard.EARTHQUAKE:
                continue
            s = score(obs, inc)
            if s is not None and s > best_score:
                best_id, best_score = inc.id, s
        return (best_id, "spatiotemporal") if best_id else (None, "none")
