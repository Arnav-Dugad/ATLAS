"""Copernicus Emergency Management Service rapid-mapping activations (REAL, official): when an
authority asks the EU for emergency maps of a disaster, the activation is listed here and linked
from matching incidents. ATLAS links the official maps; it does not redraw them.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta
from typing import Any

import orjson

from atlas.http.client import HttpClient
from atlas.util.timeutil import iso_z, parse_iso

LIST = "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/"
PORTAL = "https://rapidmapping.emergency.copernicus.eu/{code}/"
CATEGORY_HAZARD = {
    "wildfire": "wildfire",
    "flood": "flood",
    "storm": "tropical_cyclone",
    "earthquake": "earthquake",
    "volcanic activity": "volcano",
    "volcano": "volcano",
    "mass movement": "landslide",
    "tsunami": "tsunami",
}
CODE = re.compile(r"^EMSR\d{3,4}$")
POINT = re.compile(r"POINT \(([-\d.]+) ([-\d.]+)\)")


def parse(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for a in items:
        code = str(a.get("code") or "")
        m = POINT.match(str(a.get("centroid") or ""))
        if not CODE.match(code) or not m:
            continue
        out.append(
            {
                "code": code,
                "name": str(a.get("name") or code)[:160],
                "category": str(a.get("category") or "")[:40],
                "hazard": CATEGORY_HAZARD.get(str(a.get("category") or "").lower()),
                "countries": [str(c)[:60] for c in a.get("countries") or []][:6],
                "lon": float(m.group(1)),
                "lat": float(m.group(2)),
                "event_time": a.get("eventTime"),
                "activation_time": a.get("activationTime"),
                "last_update": a.get("lastUpdate"),
                "closed": bool(a.get("closed")),
                "products": a.get("n_products"),
                "url": PORTAL.format(code=code),
            }
        )
    return out


async def activations(http: HttpClient, pages: int = 2) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for page in range(pages):
        res = await http.get(
            LIST, params={"limit": 50, "offset": page * 50}, ttl=timedelta(minutes=30), source_id="copernicus-ems"
        )
        out.extend(parse(orjson.loads(res.content).get("results") or []))
    return out


def match(acts: list[dict[str, Any]], hazard: str, lat: float, lon: float, started: datetime) -> list[dict[str, Any]]:
    hits = []
    p1 = math.radians(lat)
    for a in acts:
        if a["hazard"] and a["hazard"] != hazard and not (hazard == "severe_storm" and a["hazard"] == "tropical_cyclone"):
            continue
        t = parse_iso(a.get("event_time")) or parse_iso(a.get("activation_time"))
        if t is None or abs((t - started).total_seconds()) > 14 * 86400:
            continue
        p2 = math.radians(a["lat"])
        h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(a["lon"] - lon) / 2) ** 2
        km = 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(h)))
        if km <= 500:
            hits.append({**a, "distance_km": round(km)})
    return sorted(hits, key=lambda a: a["distance_km"])


def summary(acts: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
    recent = [a for a in acts if (parse_iso(a.get("activation_time")) or now) >= now - timedelta(days=30)]
    return {"status": "ok", "provenance": "real", "recent": recent[:20], "count_30d": len(recent), "as_of": iso_z(now),
            "attribution": "Copernicus Emergency Management Service (© European Union)"}  # fmt: skip
