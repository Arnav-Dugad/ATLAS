"""Automatic burn-scar maps (DERIVED): every few hours the engine runs the Sentinel-2 dNBR
analysis for the largest active wildfires that have no fresh result, a few at a time, and the
gallery lists every result on disk. Each map carries the same scenes, dates, valid-pixel share
and caveats as one requested by hand.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from atlas.models import Hazard
from atlas.store.db import Database

log = logging.getLogger("atlas.gallery")

PER_RUN = 4  # imagery reads are tens of MB each: stay a polite, occasional user of the archive
CANDIDATES = 12


def candidates(db: Database, limit: int = CANDIDATES) -> list[tuple[str, float, float, list[float] | None, Any]]:
    """Active wildfire incidents, most severe and most intense first."""
    with db.read() as cur:
        rows = cur.execute(
            "SELECT id, lat, lon, bbox, started_at FROM incidents "
            "WHERE hazard = 'wildfire' AND status = 'active' AND lat IS NOT NULL "
            "ORDER BY severity_level DESC, last_observation_at DESC LIMIT ?",
            [limit],
        ).fetchall()
    out = []
    for iid, lat, lon, bbox, started in rows:
        out.append((str(iid), float(lat), float(lon), json.loads(bbox) if bbox else None, started))
    return out


async def refresh(spectral: Any, db: Database, per_run: int = PER_RUN) -> int:
    """Compute burn-scar maps for up to `per_run` large fires without a fresh cached result."""
    done = 0
    for iid, lat, lon, bbox, started in candidates(db):
        if done >= per_run:
            break
        if spectral.cached(iid, "nbr") is not None:
            continue
        result = await spectral.analyse(iid, Hazard.WILDFIRE, lat, lon, bbox, started, "nbr")
        done += 1
        log.info("burn scar %s: %s", iid, result.get("status"))
    return done


def listing(spectral: Any, db: Database) -> list[dict[str, Any]]:
    """Every burn-scar result on disk whose incident still exists, largest burned area first."""
    items = []
    root = spectral.root
    if not root.exists():
        return []
    with db.read() as cur:
        meta = {
            r[0]: {"title": r[1], "status": r[2], "severity": r[3]}
            for r in cur.execute("SELECT id, title, status, severity_level FROM incidents WHERE hazard = 'wildfire'").fetchall()
        }
    for d in root.iterdir():
        f = d / "nbr" / "result.json"
        if d.name not in meta or not f.is_file():
            continue
        try:
            data = json.loads(f.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("status") != "ok":
            continue
        items.append(
            {
                "incident_id": d.name,
                **meta[d.name],
                "headline": data.get("headline"),
                "before": (data.get("before") or {}).get("datetime"),
                "after": (data.get("after") or {}).get("datetime"),
                "valid_fraction": data.get("valid_fraction"),
                "bbox": (data.get("window") or {}).get("bbox"),
                "images": data.get("images"),
                "classes": data.get("classes"),
                "computed_at": data.get("computed_at"),
            }
        )
    items.sort(key=lambda x: -float((x.get("headline") or {}).get("value") or 0))
    return items
