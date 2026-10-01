"""ATLAS Confidence Heuristic v1.

Summarises *how well-supported* an incident's core facts are. Components are shown to the
user individually; the combined score is a weighted mean and is explicitly labelled as a
heuristic, not a calibrated probability.

Independence matters: GDACS earthquake parameters come from NEIC/USGS and EONET storm
positions come from NHC/JTWC, so those pairs count as *one* line of evidence plus an
echo, not two independent confirmations.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta

from atlas.models import Confidence, ConfidenceComponent, Hazard, Observation
from atlas.registry import Registry
from atlas.util.geo import haversine_km

# (hazard, derived_source) -> upstream it echoes
DEPENDENT: dict[tuple[Hazard, str], str] = {
    (Hazard.EARTHQUAKE, "gdacs"): "usgs",
    (Hazard.TROPICAL_CYCLONE, "eonet"): "nhc",
    (Hazard.TROPICAL_CYCLONE, "gdacs"): "nhc",
    (Hazard.SEVERE_STORM, "eonet"): "nhc",
}

EXPECTED_CADENCE: dict[str, timedelta] = {
    "usgs": timedelta(hours=6),
    "gdacs": timedelta(hours=12),
    "nhc": timedelta(hours=6),
    "eonet": timedelta(days=2),
    "gvp": timedelta(days=8),
    "firms": timedelta(hours=12),
    "reliefweb": timedelta(days=2),
}


def _label(score: float) -> str:
    if score >= 0.85:
        return "very high"
    if score >= 0.7:
        return "high"
    if score >= 0.5:
        return "moderate"
    return "low"


def assess(hazard: Hazard, observations: Sequence[Observation], registry: Registry, now: datetime,
           *, active: bool) -> Confidence:  # fmt: skip
    sources = sorted({o.source for o in observations})
    comps: list[ConfidenceComponent] = []

    # 1. Corroboration by independent lines of evidence
    independent = 0.0
    for s in sources:
        upstream = DEPENDENT.get((hazard, s))
        independent += 0.4 if upstream and upstream in sources else 1.0
    corroboration = 0.55 if independent < 1.4 else 0.75 if independent < 2.4 else 0.9
    deps = [f"{s}→{DEPENDENT[(hazard, s)]}" for s in sources if (hazard, s) in DEPENDENT and DEPENDENT[(hazard, s)] in sources]
    comps.append(
        ConfidenceComponent(
            name="Corroboration",
            score=corroboration,
            weight=0.3,
            detail=f"{len(sources)} source(s): {', '.join(sources)}" + (f" (dependent: {', '.join(deps)})" if deps else ""),
        )  # fmt: skip
    )

    # 2. Authority of the best source
    ratings = [(registry.get(s).reliability_score if registry.get(s) else 0.5, s) for s in sources]  # type: ignore[union-attr]
    best, best_src = max(ratings) if ratings else (0.5, "-")
    rating = registry.get(best_src).reliability.rating if registry.get(best_src) else "?"  # type: ignore[union-attr]
    comps.append(ConfidenceComponent(name="Source authority", score=best, weight=0.25,
                                     detail=f"Highest-rated source: {best_src} (rating {rating})"))  # fmt: skip

    # 3. Review status (earthquakes) — automatic solutions are routinely revised
    if hazard is Hazard.EARTHQUAKE:
        usgs = next((o for o in observations if o.source == "usgs"), None)
        if usgs is not None:
            reviewed = usgs.status == "reviewed"
            comps.append(ConfidenceComponent(
                name="Review status", score=1.0 if reviewed else 0.65, weight=0.2,
                detail="Reviewed by USGS analysts" if reviewed else "Automatic solution; may be revised",
            ))  # fmt: skip

    # 4. Agreement between sources on core parameters
    agreement = _agreement(hazard, observations)
    if agreement is not None:
        score, detail = agreement
        comps.append(ConfidenceComponent(name="Source agreement", score=score, weight=0.15, detail=detail))

    # 5. Freshness relative to each source's expected cadence (only meaningful while active)
    if active:
        latest = max(observations, key=lambda o: o.source_updated_at or o.event_time)
        ts = latest.source_updated_at or latest.event_time
        cadence = EXPECTED_CADENCE.get(latest.source, timedelta(days=1))
        age = now - ts
        fresh = 1.0 if age <= cadence * 2 else 0.7 if age <= cadence * 6 else 0.4
        hours = age.total_seconds() / 3600
        comps.append(ConfidenceComponent(name="Freshness", score=fresh, weight=0.1,
                                         detail=f"Latest update {hours:.1f} h ago from {latest.source}"))  # fmt: skip

    total_w = sum(c.weight for c in comps)
    score = sum(c.score * c.weight for c in comps) / total_w if total_w else 0.0
    return Confidence(score=round(score, 3), label=_label(score), components=comps)  # type: ignore[arg-type]


def _agreement(hazard: Hazard, observations: Sequence[Observation]) -> tuple[float, str] | None:
    located = [o for o in observations if o.lat is not None and o.lon is not None]
    if hazard is Hazard.EARTHQUAKE:
        mags = [o.magnitude for o in observations if o.magnitude is not None]
        if len(mags) < 2:
            return None
        spread = max(mags) - min(mags)
        dist = 0.0
        if len(located) >= 2:
            a, b = located[0], located[1]
            dist = haversine_km(a.lat, a.lon, b.lat, b.lon)  # type: ignore[arg-type]
        score = 1.0 if spread <= 0.2 and dist <= 20 else 0.8 if spread <= 0.5 and dist <= 50 else 0.5
        return score, f"Magnitude spread {spread:.1f}, location spread {dist:.0f} km"
    if hazard is Hazard.TROPICAL_CYCLONE:
        winds = [float(w) for o in observations if isinstance((w := o.metrics.get("max_wind_kt")), (int, float))]
        if len(winds) < 2:
            return None
        spread = max(winds) - min(winds)
        score = 1.0 if spread <= 10 else 0.8 if spread <= 25 else 0.5
        return score, f"Max-wind spread {spread:.0f} kt between sources (sources report at different times)"
    return None
