"""Knowledge graph: documented, rule-based relations between incidents (Phase 5).

Every edge states the rule and the evidence that produced it. Relations are spatial-temporal
associations; ATLAS does not claim causation, except that aftershock windows follow the
seismological convention below.

Rules (method `atlas-relations-v1`):
* Earthquake sequences — Gardner & Knopoff (1974) windows as fitted by van Stiphout et al.
  (2012, CORSSA): L(M) = 10^(0.1238·M + 0.983) km; T(M) = 10^(0.032·M + 2.7389) days for
  M ≥ 6.5, else 10^(0.5409·M − 0.547) days. A smaller event inside the larger event's window
  is an aftershock (after it) or a foreshock (before it).
* Cyclone → flood — a flood starting between a cyclone's start and 7 days after its last
  data, within 300 km of the cyclone's track extent: "possibly cyclone-related".
* Earthquake near volcano — within 30 km and 30 days.
* Same-hazard neighbours — wildfires within 60 km and 5 days; floods within 300 km and 14
  days; other hazards within 150 km and 10 days.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import orjson

from atlas.util.geo import haversine_km
from atlas.util.timeutil import iso_z

METHOD = "atlas-relations-v1"
NOTE = (
    "Relations are rule-based spatial-temporal associations, not proof of cause (except the seismological aftershock convention)."
)


@dataclass(frozen=True)
class Node:
    id: str
    title: str
    hazard: str
    severity_level: int
    status: str
    lat: float
    lon: float
    started_at: datetime
    last_at: datetime
    magnitude: float | None = None
    bbox: tuple[float, float, float, float] | None = None

    def out(self) -> dict[str, Any]:
        return {
            "id": self.id, "title": self.title, "hazard": self.hazard, "severity_level": self.severity_level,
            "status": self.status, "lat": self.lat, "lon": self.lon, "started_at": iso_z(self.started_at),
            "magnitude": self.magnitude,
        }  # fmt: skip


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    type: str
    label: str
    evidence: str

    def out(self) -> dict[str, Any]:
        return {"source": self.source, "target": self.target, "type": self.type, "label": self.label, "evidence": self.evidence}


def gk_window(magnitude: float) -> tuple[float, float]:
    """Gardner–Knopoff aftershock window (km, days) for a mainshock magnitude."""
    km = 10 ** (0.1238 * magnitude + 0.983)
    days = 10 ** (0.032 * magnitude + 2.7389) if magnitude >= 6.5 else 10 ** (0.5409 * magnitude - 0.547)
    return km, days


def _dist_to_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float] | None, flat: float, flon: float) -> float:
    if bbox is None:
        return haversine_km(lat, lon, flat, flon)
    w, s, e, n = bbox
    clat = min(max(flat, s), n)
    clon = min(max(flon, w), e) if w <= e else flon
    return haversine_km(clat, clon, flat, flon)


def relate(a: Node, b: Node) -> Edge | None:
    """The relation between two incidents, oriented from the 'parent' to the 'child'."""
    d = haversine_km(a.lat, a.lon, b.lat, b.lon)
    hz = {a.hazard, b.hazard}

    if hz == {"earthquake"} and a.magnitude is not None and b.magnitude is not None:
        main, other = (a, b) if (a.magnitude, -a.started_at.timestamp()) >= (b.magnitude, -b.started_at.timestamp()) else (b, a)
        if other.magnitude is None or main.magnitude is None or other.magnitude >= main.magnitude:
            return None
        km, days = gk_window(main.magnitude)
        dt_days = (other.started_at - main.started_at).total_seconds() / 86400
        if d <= km and abs(dt_days) <= days:
            kind = "aftershock" if dt_days > 0 else "foreshock"
            when = f"{abs(dt_days):.1f} days {'after' if dt_days > 0 else 'before'}"
            return Edge(main.id, other.id, kind, f"M{other.magnitude:.1f} {kind} of M{main.magnitude:.1f}",
                        f"{d:.0f} km and {when} — inside the Gardner–Knopoff window for M{main.magnitude:.1f} ({km:.0f} km, {days:.0f} days)")  # fmt: skip
        return None

    if hz == {"tropical_cyclone", "flood"}:
        cyc, flood = (a, b) if a.hazard == "tropical_cyclone" else (b, a)
        near = _dist_to_bbox(cyc.lat, cyc.lon, cyc.bbox, flood.lat, flood.lon)
        if near <= 300 and cyc.started_at <= flood.started_at <= cyc.last_at + timedelta(days=7):
            return Edge(cyc.id, flood.id, "cyclone_flood", "Flooding possibly related to the cyclone",
                        f"Flood began {(flood.started_at - cyc.started_at).days} days after the cyclone formed, {near:.0f} km from its track")  # fmt: skip
        return None

    if hz == {"volcano", "earthquake"}:
        volc, quake = (a, b) if a.hazard == "volcano" else (b, a)
        if d <= 30 and abs((quake.started_at - volc.last_at).days) <= 30:
            mag = f"M{quake.magnitude:.1f} " if quake.magnitude is not None else ""
            return Edge(
                volc.id,
                quake.id,
                "volcano_earthquake",
                f"{mag}earthquake near the volcano",
                f"{d:.0f} km from the volcano within 30 days of its latest report",
            )
        return None

    if a.hazard == b.hazard:
        limit_km, limit_days = {"wildfire": (60, 5), "flood": (300, 14)}.get(a.hazard, (150, 10))
        gap = abs((a.started_at - b.started_at).total_seconds()) / 86400
        if d <= limit_km and gap <= limit_days:
            first, second = (a, b) if a.started_at <= b.started_at else (b, a)
            return Edge(
                first.id,
                second.id,
                "nearby",
                "Nearby activity of the same kind",
                f"{d:.0f} km apart, starting {gap:.1f} days apart",
            )
    return None


def _nodes(cur: Any, where: str, params: list[Any]) -> list[Node]:
    rows = cur.execute(
        "SELECT i.id, i.title, i.hazard, i.severity_level, i.status, i.lat, i.lon, i.started_at, i.last_observation_at, i.bbox, "
        "(SELECT max(o.magnitude) FROM observations o WHERE o.incident_id = i.id AND o.hazard = 'earthquake') AS mag "
        f"FROM incidents i WHERE i.lat IS NOT NULL AND {where}",
        params,
    ).fetchall()
    out = []
    for r in rows:
        bbox = orjson.loads(r[9]) if r[9] else None
        out.append(Node(r[0], r[1], r[2], int(r[3]), r[4], float(r[5]), float(r[6]), r[7], r[8], float(r[10]) if r[10] is not None else None,
                        tuple(bbox) if bbox and len(bbox) == 4 else None))  # fmt: skip
    return out


def neighbours(cur: Any, node: Node, limit: int = 30) -> list[tuple[Node, Edge]]:
    """Incidents related to `node` by any rule."""
    span = 1100 if node.hazard == "earthquake" else 400  # days: the largest GK window (M9) is ~1 000 days
    dlat = 8.0
    cands = _nodes(
        cur, "i.id <> ? AND i.lat BETWEEN ? AND ? AND i.started_at BETWEEN ? AND ?",
        [node.id, node.lat - dlat, node.lat + dlat, node.started_at - timedelta(days=span), node.last_at + timedelta(days=span)],
    )  # fmt: skip
    out = [(c, e) for c in cands if (e := relate(node, c)) is not None]
    out = sequence_view(node, out)
    out.sort(key=lambda x: haversine_km(node.lat, node.lon, x[0].lat, x[0].lon))
    return out[:limit]


SEQUENCE = frozenset({"aftershock", "foreshock"})


def sequence_view(node: Node, found: list[tuple[Node, Edge]]) -> list[tuple[Node, Edge]]:
    """In an earthquake sequence every event belongs to the mainshock (the largest event whose
    window contains it), not to its neighbours: a smaller event links only to that mainshock,
    and only the mainshock fans out to the rest of the sequence."""
    parents = [(c, e) for c, e in found if e.type in SEQUENCE and e.target == node.id]
    if not parents:
        return found
    main = max(parents, key=lambda x: (x[0].magnitude or 0.0, -x[0].started_at.timestamp()))
    return [main] + [(c, e) for c, e in found if e.type not in SEQUENCE]


def graph(cur: Any, incident_id: str, depth: int = 1, max_nodes: int = 40) -> dict[str, Any] | None:
    centre = _nodes(cur, "i.id = ?", [incident_id])
    if not centre:
        return None
    nodes: dict[str, Node] = {centre[0].id: centre[0]}
    edges: dict[tuple[str, str], Edge] = {}
    frontier = [centre[0]]
    for _ in range(max(1, min(depth, 2))):
        nxt: list[Node] = []
        for n in frontier:
            for other, edge in neighbours(cur, n):
                edges.setdefault((edge.source, edge.target), edge)
                if other.id not in nodes and len(nodes) < max_nodes:
                    nodes[other.id] = other
                    nxt.append(other)
        frontier = nxt
    kept = {k: e for k, e in edges.items() if e.source in nodes and e.target in nodes}
    return {
        "centre": incident_id,
        "nodes": [n.out() for n in nodes.values()],
        "edges": [e.out() for e in kept.values()],
        "method": METHOD,
        "note": NOTE,
    }


def distance_km(a: Node, b: Node) -> float:
    return round(haversine_km(a.lat, a.lon, b.lat, b.lon), 1)


__all__ = ["METHOD", "NOTE", "Edge", "Node", "distance_km", "gk_window", "graph", "neighbours", "relate", "sequence_view"]
