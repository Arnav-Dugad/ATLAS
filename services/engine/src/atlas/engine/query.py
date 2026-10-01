"""Deterministic natural-language → structured filter parser.

    "earthquakes above magnitude 6 in Japan during 2024"
        → hazards=[earthquake], min_magnitude=6, country=JPN, 2024-01-01..2025-01-01

No language model involved: the grammar is small, explainable and testable, and every
interpretation is echoed back to the user. Anything ATLAS cannot evaluate yet (e.g.
population thresholds without the Population Pack) is reported in ``unsupported`` instead
of being silently ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from atlas.engine.geocode import Geocoder
from atlas.models import HAZARD_LABEL, Hazard
from atlas.util.timeutil import utcnow

HAZARD_WORDS: list[tuple[re.Pattern[str], Hazard]] = [
    (re.compile(r"\b(earth ?quakes?|quakes?|seismic|tremors?|aftershocks?)\b"), Hazard.EARTHQUAKE),
    (re.compile(r"\b(wild ?fires?|bush ?fires?|forest fires?|fires?|burn(ing)?)\b"), Hazard.WILDFIRE),
    (re.compile(r"\b(hurricanes?|typhoons?|cyclones?|tropical storms?|tropical depressions?)\b"), Hazard.TROPICAL_CYCLONE),
    (re.compile(r"\b(floods?|flooding|inundation)\b"), Hazard.FLOOD),
    (re.compile(r"\b(volcano(es)?|volcanic|eruptions?|erupting)\b"), Hazard.VOLCANO),
    (re.compile(r"\b(droughts?)\b"), Hazard.DROUGHT),
    (re.compile(r"\b(storms?|severe weather)\b"), Hazard.SEVERE_STORM),
]

MAG_RE = re.compile(
    r"(?:\bm(?:agnitude)?\s*(?:>=|≥|>|of|above|over|greater than|at least)?\s*(\d(?:\.\d)?)\s*(?:\+|or (?:higher|greater|more|above))?"
    r"|(?:above|over|greater than|at least|>=|≥|>)\s*(?:magnitude|m)\s*(\d(?:\.\d)?))"
)
YEAR_RANGE_RE = re.compile(r"\b(?:between|from)\s+((?:19|20)\d{2})\s+(?:and|to|-)\s+((?:19|20)\d{2})\b")
YEAR_RE = re.compile(r"\b(?:in|during|of|for)?\s*((?:19|20)\d{2})\b")
SINCE_RE = re.compile(r"\bsince\s+((?:19|20)\d{2})\b")
LAST_RE = re.compile(r"\b(?:last|past|previous)\s+(\d+)?\s*(hour|hr|day|week|month|year)s?\b")
PLACE_RE = re.compile(
    r"\b(?:in|near|around|off|across|over)\s+([a-z][a-z .'-]{1,40}?)(?=\s+(?:during|in|since|from|between|above|over|with|affecting|last|past|for)\b|$|[,?.!])"
)
POP_RE = re.compile(r"affect(?:ing|ed)?\s+(?:more than|over|at least)?\s*([\d,.]+)\s*(k|thousand|m|million)?\s*people")
INFRA_RE = re.compile(r"\bnear (?:major )?(ports?|airports?|hospitals?|power plants?|dams?)\b")


@dataclass
class ParsedQuery:
    text: str
    hazards: list[str] = field(default_factory=list)
    min_magnitude: float | None = None
    start: datetime | None = None
    end: datetime | None = None
    country_iso3: str | None = None
    country_name: str | None = None
    place: dict[str, Any] | None = None
    status: list[str] | None = None
    sort: str = "severity"
    unsupported: list[str] = field(default_factory=list)
    chips: list[str] = field(default_factory=list)

    @property
    def is_structured(self) -> bool:
        return bool(self.hazards or self.min_magnitude or self.start or self.country_iso3 or self.place)

    @property
    def needs_archive(self) -> bool:
        """True when the time window predates ATLAS's local store and an archive query is needed."""
        return self.start is not None and self.start < utcnow() - timedelta(days=30)

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text, "hazards": self.hazards, "min_magnitude": self.min_magnitude,
            "start": self.start.isoformat() + "Z" if self.start else None, "end": self.end.isoformat() + "Z" if self.end else None,
            "country_iso3": self.country_iso3, "country_name": self.country_name, "place": self.place,
            "status": self.status, "sort": self.sort, "unsupported": self.unsupported, "chips": self.chips,
            "structured": self.is_structured, "needs_archive": self.needs_archive,
        }  # fmt: skip


def parse(text: str, geocoder: Geocoder, now: datetime) -> ParsedQuery:
    raw = text.strip()
    t = " " + raw.lower() + " "
    pq = ParsedQuery(text=raw)

    for pattern, hazard in HAZARD_WORDS:
        if pattern.search(t) and hazard.value not in pq.hazards:
            # "storm" inside "tropical storm" must not add severe_storm as well
            if hazard is Hazard.SEVERE_STORM and Hazard.TROPICAL_CYCLONE.value in pq.hazards:
                continue
            pq.hazards.append(hazard.value)
    for h in pq.hazards:
        pq.chips.append(HAZARD_LABEL[Hazard(h)])

    if m := MAG_RE.search(t):
        val = m.group(1) or m.group(2)
        if val:
            pq.min_magnitude = float(val)
            pq.chips.append(f"M ≥ {pq.min_magnitude:.1f}")
            if not pq.hazards:
                pq.hazards = [Hazard.EARTHQUAKE.value]
                pq.chips.insert(0, "Earthquake")

    if m := YEAR_RANGE_RE.search(t):
        a, b = sorted((int(m.group(1)), int(m.group(2))))
        pq.start, pq.end = datetime(a, 1, 1), datetime(b + 1, 1, 1)
        pq.chips.append(f"{a}–{b}")
    elif m := SINCE_RE.search(t):
        y = int(m.group(1))
        pq.start, pq.end = datetime(y, 1, 1), now
        pq.chips.append(f"Since {y}")
    elif m := LAST_RE.search(t):
        n = int(m.group(1) or 1)
        unit = m.group(2)
        delta = {"hour": timedelta(hours=n), "hr": timedelta(hours=n), "day": timedelta(days=n), "week": timedelta(weeks=n),
                 "month": timedelta(days=30 * n), "year": timedelta(days=365 * n)}[unit]  # fmt: skip
        pq.start, pq.end = now - delta, now
        pq.chips.append(f"Last {n} {unit}{'s' if n > 1 else ''}")
    elif m := YEAR_RE.search(t):
        y = int(m.group(1))
        if 1900 <= y <= now.year:
            pq.start, pq.end = datetime(y, 1, 1), min(datetime(y + 1, 1, 1), now)
            pq.chips.append(str(y))
    elif re.search(r"\btoday\b", t):
        pq.start, pq.end = now - timedelta(hours=24), now
        pq.chips.append("Last 24 hours")
    elif re.search(r"\b(recent|latest|current|now|active|ongoing)\b", t):
        pq.status = ["active"]
        pq.chips.append("Active")

    if re.search(r"\b(largest|biggest|strongest|most severe|worst|major|significant)\b", t):
        pq.sort = "severity"
        pq.chips.append("By severity")
    elif re.search(r"\b(newest|latest|most recent)\b", t):
        pq.sort = "recent"

    if m := POP_RE.search(t):
        pq.unsupported.append(
            "Population-exposure filters need the Population Pack (GHSL). Install it from Storage to enable this filter."
        )
    if m := INFRA_RE.search(t):
        pq.unsupported.append(f"Infrastructure proximity ('{m.group(1)}') is not yet indexed in this version.")

    for m in PLACE_RE.finditer(t):
        name = m.group(1).strip(" .'-")
        if not name or re.fullmatch(r"(?:19|20)\d{2}", name) or name in ("the", "a", "an"):
            continue
        countries = geocoder.search_countries(name, limit=1)
        if countries and countries[0]["name"].lower().startswith(name[:4]):
            c = countries[0]
            pq.country_iso3, pq.country_name = c["iso3"], c["name"]
            pq.place = {"kind": "country", "name": c["name"], "lat": c["lat"], "lon": c["lon"], "bbox": c["bbox"]}
            pq.chips.append(c["name"])
            break
        places = geocoder.search(name, limit=1)
        if places:
            p = places[0]
            pq.place = {"kind": "place", "name": p["name"], "country": p.get("country"), "lat": p["lat"], "lon": p["lon"],
                        "radius_km": 300}  # fmt: skip
            pq.chips.append(f"Within 300 km of {p['name']}")
            break
    return pq
