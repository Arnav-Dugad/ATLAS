"""Active-fire processing: bulk load, rolling window, clustering and cluster tracking.

Method (documented in docs/METHODOLOGY.md):
  * Detections from VIIRS (375 m) and MODIS (1 km) are indexed to H3 resolution 7
    (~5.2 km², edge ~1.4 km) and resolution 9 (~0.105 km²).
  * Clusters are connected components of occupied r7 cells under 1-ring adjacency, i.e.
    detections chain together when within roughly 1.5–3 km of each other.
  * A cluster's *active footprint* is (#distinct r9 cells) × mean r9 area — an
    approximation of the area of burning pixels, never presented as a burn perimeter.
  * Clusters keep their identity between runs by maximum r7-cell overlap.
  * Possible static heat sources (gas flares, industry, volcanoes): ≥8 detections whose
    maximum distance from the cluster centroid is ≤0.8 km (about two VIIRS pixels) and that
    recur across ≥3 separate acquisitions. Vegetation fires move; flares do not. These are
    tracked but never open incidents on their own.
"""

from __future__ import annotations

import hashlib
import logging
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import h3
import h3.api.basic_int as h3i
import numpy as np
import pyarrow as pa
from shapely.geometry import MultiPoint, mapping

from atlas.connectors.base import DetectionFile
from atlas.models import ExternalRef, Hazard, Observation
from atlas.store.db import Database
from atlas.store.repo import dumps
from atlas.util.ids import crockford32
from atlas.util.timeutil import utcnow

log = logging.getLogger("atlas.fires")

R9_AREA_KM2 = h3.average_hexagon_area(9, unit="km^2")
TRACK_MIN_DETECTIONS = 10
# Calibrated on 2026-10-01 global data (peak SH burning season): ~5,300 tracked clusters,
# ~100 above this bar. Agricultural and savanna burning stays visible as a layer.
INCIDENT_MIN_DETECTIONS = 120
INCIDENT_MIN_FRP_MW = 2500.0
STATIC_MAX_RADIUS_KM = 0.8
STATIC_MIN_DETECTIONS = 8
STATIC_MIN_ACQUISITIONS = 3

SATELLITES = (
    "CASE satellite WHEN 'N' THEN 'Suomi NPP' WHEN 'N20' THEN 'NOAA-20' WHEN '1' THEN 'NOAA-20' "
    "WHEN 'N21' THEN 'NOAA-21' WHEN 'T' THEN 'Terra' WHEN 'A' THEN 'Aqua' ELSE satellite END"
)
CONF_VIIRS = (
    "CASE lower(confidence) WHEN 'h' THEN 'high' WHEN 'high' THEN 'high' WHEN 'l' THEN 'low' WHEN 'low' THEN 'low' "
    "ELSE 'nominal' END"
)
CONF_MODIS = (
    "CASE WHEN TRY_CAST(confidence AS INTEGER) >= 80 THEN 'high' WHEN TRY_CAST(confidence AS INTEGER) < 30 THEN 'low' "
    "ELSE 'nominal' END"
)


@dataclass
class ClusterResult:
    observations: list[Observation]
    tracked: int
    detections: int
    elapsed_ms: float


class FireEngine:
    def __init__(self, db: Database, window_hours: int = 48) -> None:
        self.db = db
        self.window = timedelta(hours=window_hours)

    # -- loading ---------------------------------------------------------------------
    def load(self, files: list[DetectionFile], now: datetime | None = None) -> dict[str, int]:
        now = now or utcnow()
        inserted: dict[str, int] = {}
        if not self.db.extensions.get("h3"):
            raise RuntimeError("DuckDB h3 extension is required for fire indexing (run `atlas setup`)")
        with self.db.write() as cur:
            for f in files:
                viirs = f.instrument == "VIIRS"
                b1, b2 = ("bright_ti4", "bright_ti5") if viirs else ("brightness", "bright_t31")
                conf = CONF_VIIRS if viirs else CONF_MODIS
                before = cur.execute("SELECT count(*) FROM fire_detections").fetchone()[0]  # type: ignore[index]
                cur.execute(
                    f"""
                    INSERT INTO fire_detections
                    SELECT DISTINCT ON (key) * FROM (
                      SELECT
                        ? || '|' || satellite || '|' || printf('%.4f', lat) || '|' || printf('%.4f', lon) || '|' || acq_date || acq_hhmm AS key,
                        lat, lon,
                        strptime(acq_date || ' ' || acq_hhmm, '%Y-%m-%d %H%M') AS acq_time,
                        {SATELLITES} AS satellite,
                        ? AS instrument,
                        {conf} AS confidence,
                        confidence AS confidence_raw,
                        TRY_CAST({b1} AS DOUBLE), TRY_CAST({b2} AS DOUBLE), TRY_CAST(frp AS DOUBLE), daynight,
                        TRY_CAST(scan AS DOUBLE), TRY_CAST(track AS DOUBLE),
                        h3_latlng_to_cell(lat, lon, 7)::UBIGINT, h3_latlng_to_cell(lat, lon, 9)::UBIGINT,
                        ? AS product, ? AS ingested_at
                      FROM (
                        SELECT *, TRY_CAST(latitude AS DOUBLE) AS lat, TRY_CAST(longitude AS DOUBLE) AS lon,
                               lpad(acq_time, 4, '0') AS acq_hhmm
                        FROM read_csv(?, header = true, all_varchar = true)
                      )
                      WHERE lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180 AND acq_date IS NOT NULL
                    )
                    WHERE acq_time >= ? AND key NOT IN (SELECT key FROM fire_detections)
                    """,
                    [f.instrument, f.instrument, f.product, now, str(f.path), now - self.window],
                )
                after = cur.execute("SELECT count(*) FROM fire_detections").fetchone()[0]  # type: ignore[index]
                inserted[f.product] = int(after - before)
            cur.execute("DELETE FROM fire_detections WHERE acq_time < ?", [now - self.window])
        return inserted

    # -- clustering ------------------------------------------------------------------
    def cluster(self, now: datetime | None = None) -> ClusterResult:
        import time

        t0 = time.perf_counter()
        now = now or utcnow()
        with self.db.read() as cur:
            data = cur.execute(
                "SELECT h3_r7, h3_r9, lat, lon, coalesce(frp, 0) AS frp, epoch(acq_time) AS t, "
                "confidence = 'high' AS high, daynight = 'D' AS day, instrument, satellite "
                "FROM fire_detections WHERE acq_time >= ?",
                [now - self.window],
            ).fetchnumpy()
            prev_cells = cur.execute("SELECT cell, cluster_id FROM fire_cluster_cells").fetchall()
        n = len(data["lat"])
        if n == 0:
            self._store([])
            return ClusterResult([], 0, 0, (time.perf_counter() - t0) * 1000)

        r7 = np.asarray(data["h3_r7"], dtype=np.uint64)
        cells, inv = np.unique(r7, return_inverse=True)
        labels_by_cell = _components(cells)
        _, lbl = np.unique(labels_by_cell[inv], return_inverse=True)
        k = int(lbl.max()) + 1

        lat = np.asarray(data["lat"], dtype=float)
        lon = np.asarray(data["lon"], dtype=float)
        frp = np.nan_to_num(np.asarray(data["frp"], dtype=float))
        t = np.asarray(data["t"], dtype=float)
        high = np.asarray(data["high"], dtype=float)
        day = np.asarray(data["day"], dtype=float)

        count = np.bincount(lbl, minlength=k)
        tracked = np.nonzero(count >= TRACK_MIN_DETECTIONS)[0]
        frp_sum = np.bincount(lbl, weights=frp, minlength=k)
        now_s = now.timestamp() if now.tzinfo else (now - datetime(1970, 1, 1)).total_seconds()
        recent = np.bincount(lbl, weights=(t >= now_s - 12 * 3600).astype(float), minlength=k)
        prior = np.bincount(lbl, weights=((t < now_s - 12 * 3600) & (t >= now_s - 24 * 3600)).astype(float), minlength=k)

        order = np.argsort(lbl, kind="stable")
        bounds = np.searchsorted(lbl[order], np.arange(k + 1))
        prev_map = {int(c): cid for c, cid in prev_cells}
        r9 = np.asarray(data["h3_r9"], dtype=np.uint64)
        instruments = np.asarray(data["instrument"])
        satellites = np.asarray(data["satellite"])

        clusters: list[dict[str, Any]] = []
        for c in sorted(tracked, key=lambda i: -count[i]):
            sl = order[bounds[c] : bounds[c + 1]]
            w = frp[sl] if frp[sl].sum() > 0 else np.ones(len(sl))
            c_r7 = np.unique(r7[sl])
            n_r9 = len(np.unique(r9[sl]))
            clat = float(lat[sl].mean())
            dy = (lat[sl] - clat) * 111.32
            dx = (lon[sl] - float(lon[sl].mean())) * 111.32 * np.cos(np.radians(clat))
            radius_km = float(np.sqrt(dx * dx + dy * dy).max())
            static = (
                len(sl) >= STATIC_MIN_DETECTIONS
                and radius_km <= STATIC_MAX_RADIUS_KM
                and len(np.unique(t[sl])) >= STATIC_MIN_ACQUISITIONS
            )
            pts = np.column_stack([lon[sl], lat[sl]])
            hull = MultiPoint(pts).convex_hull.buffer(0.004).simplify(0.002)
            west, south, east, north = hull.bounds
            clusters.append(
                {
                    "cells": [int(x) for x in c_r7],
                    "lat": float(np.average(lat[sl], weights=w)),
                    "lon": float(np.average(lon[sl], weights=w)),
                    "bbox": [west, south, east, north],
                    "hull": mapping(hull),
                    "detections": int(count[c]),
                    "footprint_km2": round(n_r9 * R9_AREA_KM2, 2),
                    "frp_total": round(float(frp_sum[c]), 1),
                    "frp_max": round(float(frp[sl].max()), 1),
                    "high": int(high[sl].sum()),
                    "day": int(day[sl].sum()),
                    "first": datetime(1970, 1, 1) + timedelta(seconds=float(t[sl].min())),
                    "last": datetime(1970, 1, 1) + timedelta(seconds=float(t[sl].max())),
                    "recent": int(recent[c]),
                    "prior": int(prior[c]),
                    "instruments": sorted(set(instruments[sl].tolist())),
                    "satellites": sorted(set(satellites[sl].tolist())),
                    "static": bool(static),
                }
            )

        claimed: set[str] = set()
        for cl in clusters:
            votes = Counter(prev_map[c] for c in cl["cells"] if c in prev_map)
            cid = next((cid for cid, _ in votes.most_common() if cid not in claimed), None)
            salt = 0
            while cid is None or cid in claimed:
                # A split cluster can regenerate its parent's seed; salt until unique.
                seed = f"{min(cl['cells'])}:{cl['first']:%Y%m%d}:{salt}".encode()
                cid = "FC" + crockford32(hashlib.sha256(seed).digest(), 10)
                salt += 1
            claimed.add(cid)
            cl["id"] = cid

        self._store(clusters)
        # Only incident-grade clusters (or clusters already linked to an incident, so their
        # incident can be updated or wound down) go through correlation; the thousands of
        # small agricultural burns stay as a map layer.
        with self.db.read() as cur:
            linked = {r[0] for r in cur.execute(
                "SELECT external_id FROM observations WHERE source = 'firms' AND incident_id IS NOT NULL"
            ).fetchall()}  # fmt: skip
        observations = [self._to_observation(cl) for cl in clusters]
        observations = [o for o in observations if o.incident_candidate or o.external_id in linked]
        elapsed = (time.perf_counter() - t0) * 1000
        log.info("fire clustering: %d detections, %d components, %d tracked, %d incident-grade in %.0f ms",
                 n, k, len(clusters), len(observations), elapsed)  # fmt: skip
        return ClusterResult(observations, len(clusters), n, elapsed)

    def _store(self, clusters: list[dict[str, Any]]) -> None:
        now = utcnow()
        table = pa.table(
            {
                "id": [c["id"] for c in clusters],
                "lat": pa.array([c["lat"] for c in clusters], pa.float64()),
                "lon": pa.array([c["lon"] for c in clusters], pa.float64()),
                "bbox": [dumps(c["bbox"]) for c in clusters],
                "hull": [dumps(c["hull"]) for c in clusters],
                "detections": pa.array([c["detections"] for c in clusters], pa.int32()),
                "footprint_km2": pa.array([c["footprint_km2"] for c in clusters], pa.float64()),
                "frp_total": pa.array([c["frp_total"] for c in clusters], pa.float64()),
                "frp_max": pa.array([c["frp_max"] for c in clusters], pa.float64()),
                "high_confidence": pa.array([c["high"] for c in clusters], pa.int32()),
                "day_detections": pa.array([c["day"] for c in clusters], pa.int32()),
                "first_seen": pa.array([c["first"] for c in clusters], pa.timestamp("ms")),
                "last_seen": pa.array([c["last"] for c in clusters], pa.timestamp("ms")),
                "recent_12h": pa.array([c["recent"] for c in clusters], pa.int32()),
                "prior_12h": pa.array([c["prior"] for c in clusters], pa.int32()),
                "instruments": [dumps(c["instruments"]) for c in clusters],
                "static_suspect": pa.array([c["static"] for c in clusters], pa.bool_()),
                "computed_at": pa.array([now] * len(clusters), pa.timestamp("ms")),
            }
        )
        cells = pa.table(
            {
                "cluster_id": [c["id"] for c in clusters for _ in c["cells"]],
                "cell": pa.array([cell for c in clusters for cell in c["cells"]], pa.uint64()),
            }
        )
        with self.db.write() as cur:
            cur.execute("DELETE FROM fire_clusters")
            cur.execute("DELETE FROM fire_cluster_cells")
            cur.register("_fc", table)
            cur.register("_fcc", cells)
            cur.execute("INSERT INTO fire_clusters BY NAME SELECT * FROM _fc")
            cur.execute("INSERT INTO fire_cluster_cells BY NAME SELECT * FROM _fcc")
            cur.unregister("_fc")
            cur.unregister("_fcc")

    @staticmethod
    def _to_observation(cl: dict[str, Any]) -> Observation:
        recent, prior = cl["recent"], cl["prior"]
        if prior == 0:
            trend = "new" if recent > 0 else "inactive"
        else:
            ratio = recent / prior
            trend = "growing" if ratio > 1.3 else "declining" if ratio < 0.7 else "stable"
        candidate = not cl["static"] and cl["detections"] >= INCIDENT_MIN_DETECTIONS and cl["frp_total"] >= INCIDENT_MIN_FRP_MW
        return Observation(
            source="firms",
            external_id=cl["id"],
            hazard=Hazard.WILDFIRE,
            title="Possible static heat source" if cl["static"] else "Active fire cluster",
            lat=round(cl["lat"], 5),
            lon=round(cl["lon"], 5),
            event_time=cl["first"],
            source_updated_at=cl["last"],
            status="static_suspect" if cl["static"] else "active",
            url="https://firms.modaps.eosdis.nasa.gov/map/",
            metrics={
                "detections": cl["detections"],
                "frp_total_mw": cl["frp_total"],
                "frp_max_mw": cl["frp_max"],
                "footprint_km2": cl["footprint_km2"],
                "high_confidence": cl["high"],
                "day_detections": cl["day"],
                "night_detections": cl["detections"] - cl["day"],
                "recent_12h": recent,
                "prior_12h": prior,
                "trend": trend,
                "instruments": ", ".join(cl["instruments"]),
                "satellites": ", ".join(cl["satellites"]),
                "static_suspect": cl["static"],
            },
            geometry={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": cl["hull"],
                        "properties": {"role": "fire_hull", "source": "firms", "derived": True},
                    }
                ],
            },  # fmt: skip
            external_refs=[ExternalRef(scheme="firms-cluster", id=cl["id"])],
            incident_candidate=candidate,
        )


def _components(cells: np.ndarray) -> np.ndarray:
    """Union–find over H3 cells with 1-ring adjacency. Returns a root label per cell."""
    index = {int(c): i for i, c in enumerate(cells)}
    parent = np.arange(len(cells))

    def find(i: int) -> int:
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return int(root)

    for i, c in enumerate(cells):
        for nb in h3i.grid_disk(int(c), 1):
            j = index.get(nb)
            if j is not None and j != i:
                ri, rj = find(i), find(j)
                if ri != rj:
                    parent[max(ri, rj)] = min(ri, rj)
    return np.array([find(i) for i in range(len(cells))])


def fire_grid(db: Database, resolution: int, since: datetime) -> list[dict[str, Any]]:
    """Aggregate detections to a coarser H3 grid for global views."""
    resolution = max(2, min(7, resolution))
    with db.read() as cur:
        rows = cur.execute(
            """
            SELECT p, h3_cell_to_lat(p), h3_cell_to_lng(p), count(*), round(sum(coalesce(frp,0)),1),
                   max(acq_time), sum(CASE WHEN confidence='high' THEN 1 ELSE 0 END)
            FROM (SELECT h3_cell_to_parent(h3_r7, ?) AS p, frp, acq_time, confidence FROM fire_detections WHERE acq_time >= ?)
            GROUP BY p
            """,
            [resolution, since],
        ).fetchall()
    return [
        {
            "cell": h3.int_to_str(int(r[0])),
            "lat": r[1],
            "lon": r[2],
            "count": r[3],
            "frp": r[4],
            "latest": r[5],
            "high": int(r[6]),
        }
        for r in rows
    ]


def cluster_index(db: Database) -> dict[str, list[str]]:
    with db.read() as cur:
        rows = cur.execute("SELECT cluster_id, cell FROM fire_cluster_cells").fetchall()
    out: dict[str, list[str]] = defaultdict(list)
    for cid, cell in rows:
        out[cid].append(h3.int_to_str(int(cell)))
    return out
