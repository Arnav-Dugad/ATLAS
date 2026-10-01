"""Fire growth from satellite detections (DERIVED).

For a fire-cluster incident, the last 48 hours of FIRMS detections are binned into 6-hour
windows. Each ~0.1 km² H3 cell (resolution 9) counts once, in the window where it first had a
detection, so the series shows how much new ground burned in each window and the cumulative
active footprint. The spread direction is the bearing from the centroid of cells that burned
earlier to the centroid of cells that first burned in the last 12 hours.

Limits, stated in the output: detections are ~375 m (VIIRS) / 1 km (MODIS) pixels seen only at
satellite overpasses, clouds and smoke hide fire, and a footprint of detected cells is not a
mapped burn scar.
"""

from __future__ import annotations

import itertools
import math
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import orjson

from atlas.engine.fires import R9_AREA_KM2
from atlas.store.db import Database
from atlas.util.timeutil import iso_z, utcnow

BIN_HOURS = 6
RECENT_HOURS = 12
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


def compute(t: np.ndarray, lat: np.ndarray, lon: np.ndarray, r9: np.ndarray, now: datetime) -> dict[str, Any]:
    """Growth series and spread from detection arrays (t in epoch seconds)."""
    now_s = (now - datetime(1970, 1, 1)).total_seconds()
    order = np.argsort(t, kind="stable")
    t, lat, lon, r9 = t[order], lat[order], lon[order], r9[order]
    cells, first_idx = np.unique(r9, return_index=True)
    first_t = t[first_idx]
    c_lat = np.array([lat[r9 == c].mean() for c in cells]) if len(cells) < 20_000 else lat[first_idx]
    c_lon = np.array([lon[r9 == c].mean() for c in cells]) if len(cells) < 20_000 else lon[first_idx]

    start = math.floor((now_s - 48 * 3600) / (BIN_HOURS * 3600)) * BIN_HOURS * 3600
    edges = np.arange(start, now_s + BIN_HOURS * 3600, BIN_HOURS * 3600)
    series = []
    total = 0
    for a, b in itertools.pairwise(edges):
        new = int(((first_t >= a) & (first_t < b)).sum())
        total += new
        detections = int(((t >= a) & (t < b)).sum())
        series.append(
            {
                "start": iso_z(datetime(1970, 1, 1) + timedelta(seconds=float(a))),
                "new_km2": round(new * R9_AREA_KM2, 2),
                "cumulative_km2": round(total * R9_AREA_KM2, 2),
                "detections": detections,
            }
        )
    recent = first_t >= now_s - RECENT_HOURS * 3600
    last24 = first_t >= now_s - 24 * 3600
    spread: dict[str, Any] | None = None
    if recent.sum() >= 3 and (~recent).sum() >= 3:
        a_lat, a_lon = float(c_lat[~recent].mean()), float(c_lon[~recent].mean())
        b_lat, b_lon = float(c_lat[recent].mean()), float(c_lon[recent].mean())
        km = haversine_km(a_lat, a_lon, b_lat, b_lon)
        deg = bearing(a_lat, a_lon, b_lat, b_lon)
        spread = {
            "bearing_deg": round(deg),
            "compass": COMPASS[round(deg / 22.5) % 16],
            "shift_km": round(km, 1),
            "from": [round(a_lon, 4), round(a_lat, 4)],
            "to": [round(b_lon, 4), round(b_lat, 4)],
            # Under ~1 km the centroids are within a pixel or two: no meaningful direction.
            "meaningful": km >= 1.0,
        }
    return {
        "series": series,
        "footprint_km2": round(len(cells) * R9_AREA_KM2, 2),
        "new_last_24h_km2": round(float(last24.sum()) * R9_AREA_KM2, 2),
        "new_last_12h_km2": round(float(recent.sum()) * R9_AREA_KM2, 2),
        "spread": spread,
    }


def fire_growth(db: Database, incident_id: str, now: datetime | None = None) -> dict[str, Any]:
    now = now or utcnow()
    with db.read() as cur:
        clusters = [r[0] for r in cur.execute(
            "SELECT external_id FROM observations WHERE incident_id = ? AND source = 'firms' AND NOT retracted",
            [incident_id],
        ).fetchall()]  # fmt: skip
        if not clusters:
            return {"status": "unavailable", "provenance": "unavailable", "reason": "This incident has no FIRMS fire cluster."}
        marks = ",".join("?" * len(clusters))
        data = cur.execute(
            f"SELECT epoch(d.acq_time) AS t, d.lat, d.lon, d.h3_r9 FROM fire_detections d "
            f"WHERE d.h3_r7 IN (SELECT cell FROM fire_cluster_cells WHERE cluster_id IN ({marks})) AND d.acq_time >= ?",
            [*clusters, now - timedelta(hours=48)],
        ).fetchnumpy()
        history = cur.execute(
            "SELECT v.recorded_at, v.observation_id, v.metrics FROM observation_versions v JOIN observations o ON o.id = v.observation_id "
            "WHERE o.incident_id = ? AND o.source = 'firms' ORDER BY v.recorded_at",
            [incident_id],
        ).fetchall()
    if len(data["t"]) == 0:
        return {
            "status": "unavailable",
            "provenance": "unavailable",
            "reason": "No detections in the last 48 hours: the fire may be out, or hidden by cloud and smoke.",
        }
    out = compute(
        np.asarray(data["t"], dtype=float),
        np.asarray(data["lat"], dtype=float),
        np.asarray(data["lon"], dtype=float),
        np.asarray(data["h3_r9"], dtype=np.uint64),
        now,
    )
    # An incident can hold several clusters (merged fires): sum each one's latest footprint.
    latest: dict[str, tuple[float, int]] = {}
    footprints: list[dict[str, Any]] = []
    for recorded_at, obs_id, metrics in history:
        try:
            m = orjson.loads(metrics) if metrics else {}
        except orjson.JSONDecodeError:
            continue
        if not isinstance(m.get("footprint_km2"), (int, float)):
            continue
        latest[obs_id] = (float(m["footprint_km2"]), int(m.get("detections") or 0))
        point = {
            "at": iso_z(recorded_at),
            "footprint_km2": round(sum(v[0] for v in latest.values()), 2),
            "detections": sum(v[1] for v in latest.values()),
        }
        if footprints and footprints[-1]["at"] == point["at"]:
            footprints[-1] = point
        else:
            footprints.append(point)
    out.update(
        {
            "status": "ok",
            "provenance": "derived",
            "history": footprints[-60:],
            "computed_at": iso_z(now),
            "method": (
                f"FIRMS detections of the last 48 h in {BIN_HOURS}-hour windows. Each ~{R9_AREA_KM2:.2f} km² H3 cell counts once, "
                f"when it first burned. Spread is the bearing from cells that burned earlier to cells that first burned in the "
                f"last {RECENT_HOURS} h."
            ),
            "limitations": (
                "Detections are 375 m to 1 km pixels seen only at overpasses; cloud and smoke hide fire. "
                "A footprint of detected cells is an indicator, not a mapped burn scar."
            ),
        }
    )
    return out
