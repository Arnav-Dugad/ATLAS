"""Exposure engine: population ring sums on a synthetic raster, Overpass query/parse."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from atlas.engine.exposure import (
    CATEGORIES,
    PopulationGrid,
    build_overpass_query,
    parse_overpass,
    population_exposure,
    rings_for,
)
from atlas.models import Hazard

rasterio = pytest.importorskip("rasterio")


@pytest.fixture
def grid(tmp_path: Path) -> PopulationGrid:
    """Synthetic 30″ grid around (0,0): 100 people in the centre cell, 10 in every cell
    whose centre is between ~20 and ~30 km away, nothing else. (Test fixture, not real data.)"""
    from rasterio.transform import from_origin

    res = 1 / 120  # 30 arc-seconds
    n = 241
    west = north = 120 * res + res / 2  # centre cell centred on (0, 0)
    transform = from_origin(-west, north, res, res)
    lons = -west + (np.arange(n) + 0.5) * res
    lats = north - (np.arange(n) + 0.5) * res
    lat_g, lon_g = np.meshgrid(lats, lons, indexing="ij")
    dist = 6371.0088 * np.radians(np.hypot(lat_g, lon_g))  # ~equirectangular at the equator
    data = np.zeros((n, n), dtype=np.float32)
    data[(dist > 20) & (dist < 30)] = 10.0
    data[n // 2, n // 2] = 100.0
    path = tmp_path / "pop.tif"
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32", crs="EPSG:4326",
                       transform=transform, tiled=True, blockxsize=64, blockysize=64) as ds:  # fmt: skip
        ds.write(data, 1)
    expected_ring = float(data[(dist > 20) & (dist < 30)].sum())
    g = PopulationGrid(path)
    g.expected_ring = expected_ring  # type: ignore[attr-defined]
    return g


def test_population_rings_are_cumulative_and_exact(grid: PopulationGrid) -> None:
    totals = grid.rings(0.0, 0.0, [5, 10, 25, 50])
    assert totals[0] == pytest.approx(100)
    assert totals[1] == pytest.approx(100)
    assert totals[3] == pytest.approx(100 + grid.expected_ring, rel=1e-3)  # type: ignore[attr-defined]
    assert totals == sorted(totals)


def test_population_exposure_payload(grid: PopulationGrid) -> None:
    out = population_exposure(grid, Hazard.EARTHQUAKE, 0.0, 0.0)
    assert out["status"] == "ok" and out["provenance"] == "model"
    assert [r["radius_km"] for r in out["rings"]] == [5, 10, 25, 50]
    assert "not" in out["note"].lower()  # states what the number is not


def test_population_unavailable_without_pack() -> None:
    out = population_exposure(None, Hazard.EARTHQUAKE, 0.0, 0.0)
    assert out["status"] == "unavailable" and out["action"] == "install-pack"
    assert population_exposure(None, Hazard.FLOOD, 0.0, 0.0)["status"] == "unavailable"


def test_rings_by_hazard() -> None:
    assert rings_for(Hazard.EARTHQUAKE) == [5, 10, 25, 50]
    assert rings_for(Hazard.DROUGHT) is None


def test_overpass_query_structure() -> None:
    q, order = build_overpass_query(-6.29, 145.86, [5, 10, 25, 50])
    assert q.startswith("[out:json]")
    assert q.count("out count;") == len(CATEGORIES) * 4 == len(order)
    assert "around:50000,-6.29000,145.86000" in q
    assert order[0] == ("hospital", 50) and order[3] == ("hospital", 5)


def test_overpass_parse_counts_and_facilities() -> None:
    _, order = build_overpass_query(0.0, 0.0, [5, 10])
    elements: list[dict[str, object]] = []
    for key, r in order:
        total = 3 if (key == "hospital" and r == 10) else 1 if key == "hospital" else 0
        elements.append({"type": "count", "id": 0, "tags": {"total": str(total)}})
    elements += [
        {"type": "node", "id": 1, "lat": 0.01, "lon": 0.0, "tags": {"amenity": "hospital", "name": "Near"}},
        {"type": "way", "id": 2, "center": {"lat": 0.05, "lon": 0.05}, "tags": {"amenity": "hospital", "name": "Far"}},
        {"type": "node", "id": 3, "lat": 0.02, "lon": 0.0, "tags": {"aeroway": "aerodrome", "iata": "XYZ"}},
    ]
    out = parse_overpass({"elements": elements}, order, 0.0, 0.0, [5, 10])
    hosp = next(c for c in out["categories"] if c["key"] == "hospital")
    assert hosp["counts"] == [1, 3]  # ascending ring order
    assert [f["name"] for f in out["facilities"]][:2] == ["Near", None]
    assert out["facilities"][0]["distance_km"] == pytest.approx(1.11, abs=0.01)
    assert out["provenance"] == "derived" and "OpenStreetMap" in out["attribution"]


def test_overpass_parse_rejects_truncated_counts() -> None:
    _, order = build_overpass_query(0.0, 0.0, [5])
    with pytest.raises(ValueError):
        parse_overpass({"elements": []}, order, 0.0, 0.0, [5])
