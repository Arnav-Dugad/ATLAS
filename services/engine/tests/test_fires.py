"""FIRMS bulk loading and clustering on a synthetic CSV (test fixture, not real data)."""

from __future__ import annotations

import random
from datetime import timedelta
from pathlib import Path

import pytest

from atlas.connectors.base import DetectionFile
from atlas.engine.fires import FireEngine
from atlas.store.db import Database
from atlas.util.timeutil import utcnow

HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n"


def write_viirs(path: Path, points: list[tuple[float, ...]], hours_ago: float = 2.0) -> None:
    """Points are (lat, lon, frp) or (lat, lon, frp, hours_ago)."""
    rows = []
    for p in points:
        lat, lon, frp = p[:3]
        t = utcnow() - timedelta(hours=p[3] if len(p) > 3 else hours_ago)
        conf = "h" if frp > 20 else "n"
        rows.append(f"{lat:.5f},{lon:.5f},330.0,0.4,0.4,{t:%Y-%m-%d},{t:%H%M},N20,{conf},2.0NRT,290.0,{frp:.2f},D")
    path.write_text(HEADER + "\n".join(rows) + "\n")


@pytest.fixture
def engine(db: Database) -> FireEngine:
    if not db.extensions.get("h3"):
        pytest.skip("DuckDB h3 extension unavailable")
    return FireEngine(db, window_hours=48)


def blob(lat: float, lon: float, n: int, spread: float, frp: float, seed: int) -> list[tuple[float, float, float]]:
    rnd = random.Random(seed)
    return [(lat + rnd.uniform(-spread, spread), lon + rnd.uniform(-spread, spread), frp) for _ in range(n)]


def test_clusters_separate_and_classify(engine: FireEngine, tmp_path: Path) -> None:
    big = blob(-10.0, -50.0, 200, 0.05, 40.0, 1)  # large, intense fire complex
    small = blob(20.0, 10.0, 12, 0.02, 3.0, 2)  # small cluster far away
    # Persistent point source (gas-flare-like): 10 detections within ~300 m over 4 overpasses
    flare = [(30.0 + 0.002 * (i % 3), 48.0 + 0.002 * (i // 3 % 2), 15.0 + i, 2.0 + 12 * (i % 4)) for i in range(10)]
    csv = tmp_path / "viirs.csv"
    write_viirs(csv, big + small + flare)
    loaded = engine.load([DetectionFile(csv, "VIIRS", "NOAA-20", "TEST")])
    assert loaded["TEST"] > 200

    res = engine.cluster()
    by_size = sorted(res.observations, key=lambda o: -int(o.metrics["detections"]))  # type: ignore[call-overload]
    assert by_size and by_size[0].incident_candidate
    assert by_size[0].metrics["frp_total_mw"] > 2500
    assert by_size[0].geometry and by_size[0].geometry["features"][0]["properties"]["role"] == "fire_hull"
    with engine.db.read() as cur:
        statics = cur.execute("SELECT count(*) FROM fire_clusters WHERE static_suspect").fetchone()[0]
        tracked = cur.execute("SELECT count(*) FROM fire_clusters").fetchone()[0]
    assert statics == 1  # the gas-flare-like point source
    assert tracked == 3


def test_reload_is_idempotent_and_identity_persists(engine: FireEngine, tmp_path: Path) -> None:
    csv = tmp_path / "v.csv"
    write_viirs(csv, blob(-10.0, -50.0, 200, 0.05, 40.0, 3))
    f = DetectionFile(csv, "VIIRS", "NOAA-20", "TEST")
    first = engine.load([f])["TEST"]
    again = engine.load([f])["TEST"]
    assert first > 0 and again == 0
    id1 = engine.cluster().observations[0].external_id

    csv2 = tmp_path / "v2.csv"
    write_viirs(csv2, blob(-10.0, -50.0, 120, 0.06, 40.0, 4), hours_ago=1)  # the fire grows
    engine.load([DetectionFile(csv2, "VIIRS", "NOAA-20", "TEST2")])
    id2 = engine.cluster().observations[0].external_id
    assert id1 == id2


def test_window_pruning(engine: FireEngine, tmp_path: Path) -> None:
    csv = tmp_path / "old.csv"
    write_viirs(csv, blob(0.0, 0.0, 30, 0.01, 5.0, 5), hours_ago=72)
    assert engine.load([DetectionFile(csv, "VIIRS", "NOAA-20", "OLD")])["OLD"] == 0
