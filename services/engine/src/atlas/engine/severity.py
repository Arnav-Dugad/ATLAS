"""ATLAS Severity Scale v1 — a transparent, hazard-specific 1–5 ordering.

This is NOT a risk or impact score. It is a documented mapping from physical intensity
measures reported by authoritative sources (and impact-model alert levels where they
exist) onto five ordinal levels, so incidents of different hazard types can be sorted and
coloured consistently. Every result carries a human-readable ``basis`` that names the
inputs that determined the level. See docs/METHODOLOGY.md.
"""

from __future__ import annotations

from collections.abc import Sequence

from atlas.models import Hazard, Observation, Severity

LABELS = {0: "Unknown", 1: "Minor", 2: "Moderate", 3: "Significant", 4: "Severe", 5: "Extreme"}

ALERT_FLOOR = {"yellow": 3, "orange": 4, "red": 5}
GDACS_FLOOR = {"orange": 4, "red": 5}


def _band(value: float, bands: Sequence[tuple[float, int]]) -> int:
    level = 1
    for threshold, lvl in bands:
        if value >= threshold:
            level = lvl
    return level


EQ_BANDS = [(5.0, 2), (6.0, 3), (7.0, 4), (8.0, 5)]
TC_BANDS = [(34, 2), (64, 3), (96, 4), (113, 5)]  # kt: TS, Cat1, Cat3, Cat4+
FRP_BANDS = [(2_500, 2), (10_000, 3), (25_000, 4), (75_000, 5)]  # MW summed over the 48 h window
AREA_HA_BANDS = [(1_000, 2), (10_000, 3), (50_000, 4), (200_000, 5)]


def assess(hazard: Hazard, observations: Sequence[Observation]) -> Severity:
    level = 0
    basis: list[str] = []

    def bump(new: int, why: str) -> None:
        nonlocal level
        level = max(level, new)
        basis.append(why)

    gdacs = [o for o in observations if o.source == "gdacs" and o.alert_level]
    for o in gdacs:
        floor = GDACS_FLOOR.get(o.alert_level or "")
        if floor:
            bump(floor, f"GDACS {o.alert_level} alert (impact model) → ≥{floor}")
        elif hazard in (Hazard.FLOOD, Hazard.DROUGHT):
            bump(2, "GDACS green alert → 2")

    if hazard is Hazard.EARTHQUAKE:
        mags = [o for o in observations if o.magnitude is not None]
        primary = next((o for o in mags if o.source == "usgs"), mags[0] if mags else None)
        if primary and primary.magnitude is not None:
            lvl = _band(primary.magnitude, EQ_BANDS)
            bump(lvl, f"M{primary.magnitude:.1f} ({primary.source.upper()}) → magnitude band {lvl}")
        for o in observations:
            if o.source == "usgs" and o.alert_level in ALERT_FLOOR:
                f = ALERT_FLOOR[o.alert_level]
                bump(f, f"USGS PAGER {o.alert_level} (loss model) → ≥{f}")
            if o.metrics.get("tsunami"):
                bump(3, "Tsunami flag set by USGS → ≥3")

    elif hazard is Hazard.TROPICAL_CYCLONE:
        winds = [(float(w), o.source) for o in observations if isinstance((w := o.metrics.get("max_wind_kt")), (int, float))]
        if winds:
            authority = {"nhc": 0, "gdacs": 1, "eonet": 2}
            wind, src = sorted(winds, key=lambda t: authority.get(t[1], 9))[0]
            lvl = _band(wind, TC_BANDS)
            bump(lvl, f"Max sustained wind {wind:.0f} kt ({src.upper()}) → {lvl}")

    elif hazard is Hazard.WILDFIRE:
        frp = sum(
            float(v)
            for o in observations
            if o.source == "firms" and isinstance((v := o.metrics.get("frp_total_mw")), (int, float))
        )
        if frp > 0:
            lvl = _band(frp, FRP_BANDS)
            bump(lvl, f"Σ fire radiative power {frp:,.0f} MW over 48 h (FIRMS-derived) → {lvl}")
        for o in observations:
            area = o.metrics.get("burned_area_ha")
            if isinstance(area, (int, float)) and area > 0:
                lvl = _band(float(area), AREA_HA_BANDS)
                bump(lvl, f"Reported burned area {area:,.0f} ha ({o.source.upper()}) → {lvl}")
        if level == 0:
            bump(1, "Active fire detected; no intensity measure available → 1")

    elif hazard is Hazard.VOLCANO:
        for o in observations:
            color = o.metrics.get("aviation_color_code")
            if color == "RED":
                bump(4, "Aviation colour code RED → 4")
            elif color == "ORANGE":
                bump(3, "Aviation colour code ORANGE → 3")
            if o.source == "gvp":
                bump(3 if o.status == "new" else 2, f"GVP weekly report: {o.metrics.get('report_kind') or 'activity'}")
        if level == 0:
            bump(2, "Volcanic activity reported → 2")

    elif hazard in (Hazard.FLOOD, Hazard.DROUGHT, Hazard.SEVERE_STORM, Hazard.LANDSLIDE, Hazard.TSUNAMI):
        if level == 0:
            bump(2, "Reported event without an intensity measure → 2")

    else:
        if level == 0:
            bump(1, "Reported event → 1")

    return Severity(level=level, label=LABELS[level], basis="; ".join(dict.fromkeys(basis)) or "No basis available")
