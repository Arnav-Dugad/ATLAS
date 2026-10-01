"""Earthquake shaking scenarios — SIMULATION, NOT A FORECAST (Phase 5).

A user places a hypothetical earthquake (or re-runs a real one with another magnitude) and
ATLAS estimates the *median* Modified Mercalli Intensity with distance using a published
intensity prediction equation, then counts residents (GHSL model) inside each band.

Model: Allen, Wald & Worden (2012), "Intensity attenuation for active crustal regions",
J. Seismology 16:409-433 — hypocentral-distance form. Coefficients as implemented in the
GEM OpenQuake engine (openquake/hazardlib/gsim/allen_2012_ipe.py, AllenEtAl2012Rhypo):

    MMI = c0 + c1·M + c2·ln(√(R² + Rm²)) + [R > 50 km] c4·ln(R/50),   Rm = m1 + m2·exp(M − 5)
    σ(R) = s1 + s2 / (1 + (R/s3)²)

No casualties, damage or losses are estimated, and nothing here predicts an earthquake.
"""

from __future__ import annotations

import math
from typing import Any

from atlas.engine.exposure import PopulationGrid

MODEL = "Allen, Wald & Worden (2012) intensity prediction equation, hypocentral-distance form (active crustal regions)"
CITATION = "Allen T.I., Wald D.J., Worden C.B. (2012). Intensity attenuation for active crustal regions. J. Seismology 16:409-433"
C0, C1, C2, C4, M1, M2 = 2.085, 1.428, -1.402, 0.078, -0.209, 2.042
S1, S2, S3 = 0.82, 0.37, 22.9
MAX_KM = 1500.0

# USGS ShakeMap intensity legend: (level, roman, perceived shaking, potential damage, colour)
LEVELS: list[tuple[int, str, str, str, str]] = [
    (10, "X+", "Extreme", "Very heavy", "#c80000"),
    (9, "IX", "Violent", "Heavy", "#ff0000"),
    (8, "VIII", "Severe", "Moderate/heavy", "#ff9100"),
    (7, "VII", "Very strong", "Moderate", "#ffc800"),
    (6, "VI", "Strong", "Light", "#ffff00"),
    (5, "V", "Moderate", "Very light", "#7aff93"),
    (4, "IV", "Light", "None", "#80ffff"),
]

CAVEATS = [
    "A simulation of a hypothetical event, not a forecast: it says nothing about whether or when an earthquake will happen.",
    "Median intensity only: real shaking at a site commonly differs by about ±1 intensity unit (σ shown).",
    "Point source: large earthquakes rupture faults tens to hundreds of km long and shake an elongated area more widely.",
    "No site effects: soft soils and sedimentary basins amplify shaking; hard rock reduces it.",
    "Calibrated for shallow earthquakes in active crustal regions (about M 5–7.9); stable continental regions attenuate more slowly.",
    "Residents are a GHSL model of where people live, not people affected; no damage, casualty or loss estimate is made.",
]


def mmi(magnitude: float, rhypo_km: float) -> float:
    """Median MMI at hypocentral distance R (km)."""
    r = max(rhypo_km, 0.1)
    rm = M1 + M2 * math.exp(magnitude - 5.0)
    f = C2 * math.log(math.sqrt(r * r + rm * rm))
    if r > 50.0:
        f += C4 * math.log(r / 50.0)
    return C0 + C1 * magnitude + f


def sigma(rhypo_km: float) -> float:
    return S1 + S2 / (1.0 + (rhypo_km / S3) ** 2)


def radius_km(level: float, magnitude: float, depth_km: float) -> float | None:
    """Epicentral distance (km) at which the median intensity falls to `level`; None if the
    epicentre itself does not reach it. MMI decreases monotonically with distance."""
    at = lambda d: mmi(magnitude, math.hypot(d, depth_km))  # noqa: E731
    if at(0.0) < level:
        return None
    if at(MAX_KM) >= level:
        return MAX_KM
    lo, hi = 0.0, MAX_KM
    for _ in range(60):
        mid = (lo + hi) / 2
        if at(mid) >= level:
            lo = mid
        else:
            hi = mid
    return round(lo, 2)


def validate(lat: float, lon: float, magnitude: float, depth_km: float) -> list[str]:
    notes: list[str] = []
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("lat/lon out of range")
    if not (4.0 <= magnitude <= 9.5):
        raise ValueError("magnitude must be between 4.0 and 9.5")
    if not (1.0 <= depth_km <= 300.0):
        raise ValueError("depth must be between 1 and 300 km")
    if magnitude < 5.0 or magnitude > 7.9:
        notes.append(
            f"M{magnitude:.1f} is outside the equation's calibration range (about M 5–7.9); treat the result as indicative only."
        )
    if depth_km > 40:
        notes.append(f"A {depth_km:.0f} km deep event is not a shallow crustal earthquake; the equation was not derived for it.")
    return notes


def scenario(lat: float, lon: float, magnitude: float, depth_km: float, population: PopulationGrid | None) -> dict[str, Any]:
    notes = validate(lat, lon, magnitude, depth_km)
    bands: list[dict[str, Any]] = []
    for level, roman, shaking, damage, colour in LEVELS:
        r = radius_km(level, magnitude, depth_km)
        if r is None:
            continue
        bands.append(
            {
                "level": level,
                "roman": roman,
                "shaking": shaking,
                "damage": damage,
                "color": colour,
                "radius_km": r,
                "sigma_at_edge": round(sigma(math.hypot(r, depth_km)), 2),
            }
        )
    pop_note = None
    if population is not None and bands:
        totals = population.rings(lat, lon, [b["radius_km"] for b in bands])
        prev = 0.0
        for b, cum in zip(bands, totals, strict=True):  # bands are ordered inner → outer
            b["residents_within"] = round(cum)
            b["residents_in_band"] = round(max(0.0, cum - prev))
            prev = cum
    else:
        pop_note = "Residents per band need the local engine with the optional Population Pack."
    return {
        "status": "ok",
        "kind": "earthquake_scenario",
        "provenance": "simulation",
        "label": "SIMULATION — NOT A FORECAST",
        "input": {"lat": lat, "lon": lon, "magnitude": magnitude, "depth_km": depth_km},
        "epicentre_mmi": round(mmi(magnitude, depth_km), 1),
        "bands": bands,
        "model": {"name": MODEL, "citation": CITATION, "uncertainty": "σ ≈ 0.8–1.2 MMI units (larger close to the source)"},
        "population_dataset": "GHSL GHS-POP R2023A, epoch 2025 (model)" if population is not None else None,
        "population_note": pop_note,
        "notes": notes,
        "caveats": CAVEATS,
    }
