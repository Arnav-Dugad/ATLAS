"""What's here? — point facts."""

from __future__ import annotations

import json
from pathlib import Path

from atlas.engine import point


def test_dem_tile_names_follow_the_copernicus_grid() -> None:
    assert point.dem_tile_url(28.6, 77.2).endswith(
        "Copernicus_DSM_COG_10_N28_00_E077_00_DEM/Copernicus_DSM_COG_10_N28_00_E077_00_DEM.tif"
    )
    assert "S34_00_W071_00" in point.dem_tile_url(-33.4, -70.6)  # Santiago: floor of negatives
    assert point.dem_tile_url(0.5, -140.5).startswith(f"https://{point.DEM_HOST}/")


def test_time_zones_give_the_standard_offset_and_nautical_time_at_sea(tmp_path: Path) -> None:
    fc = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"zone": 5.5, "time_zone": "UTC+05:30", "tz_name1st": "Asia/Kolkata", "places": "India"},
             "geometry": {"type": "Polygon", "coordinates": [[[68, 6], [98, 6], [98, 36], [68, 36], [68, 6]]]}},
        ],
    }  # fmt: skip
    path = tmp_path / "tz.geojson"
    path.write_text(json.dumps(fc), "utf-8")
    tz = point.TimeZones(path)
    hit = tz.lookup(28.6, 77.2)
    assert hit == {"utc_offset_hours": 5.5, "label": "UTC+05:30", "places": "India"}
    assert "iana" not in hit, "example zone names are not the place's zone; none are claimed"
    assert tz.lookup(0.0, -140.0) is None


def test_polygon_area_one_degree_square_at_equator():
    from atlas.engine.exposure import polygon_area_km2

    area = polygon_area_km2([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])
    assert 12_300 < area < 12_400  # 111.2 km × 110.6 km on the mean sphere


def test_polygon_query_uses_lat_lon_order():
    from atlas.engine.exposure import build_polygon_query

    q, order = build_polygon_query([(77.1, 28.5), (77.3, 28.5), (77.3, 28.7), (77.1, 28.5)])
    assert 'poly:"28.50000 77.10000 28.50000 77.30000' in q
    assert order and "out count" in q


def _grid(tmp_path):
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    from atlas.engine.exposure import PopulationGrid

    path = tmp_path / "pop.tif"
    data = np.ones((200, 200), dtype="float32")  # 0.1° cells over 0–20°E, 0–20°N, one person each
    with rasterio.open(path, "w", driver="GTiff", width=200, height=200, count=1, dtype="float32",
                       crs="EPSG:4326", transform=from_origin(0, 20, 0.1, 0.1), nodata=-200) as ds:  # fmt: skip
        ds.write(data, 1)
    return PopulationGrid(path)


def test_tiled_population_matches_cell_count(tmp_path):
    from shapely.geometry import box

    grid = _grid(tmp_path)
    try:
        # 12° × 12° spans several 5° tiles; 120 × 120 cell centres inside, none counted twice
        assert grid.geometry(box(2, 2, 14, 14), tile_deg=5.0) == 120 * 120
        assert grid.geometry(box(2, 2, 14, 14), tile_deg=3.0) == 120 * 120
    finally:
        grid.close()


def test_zone_exposure_reports_each_published_zone(tmp_path):
    from atlas.engine.exposure import zone_exposure

    grid = _grid(tmp_path)
    cone = {"type": "Polygon", "coordinates": [[[1, 1], [11, 1], [11, 11], [1, 11], [1, 1]]]}
    wind = {"type": "Polygon", "coordinates": [[[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]}
    geometry = {"features": [
        {"properties": {"role": "forecast_cone"}, "geometry": cone},
        {"properties": {"role": "wind_120kmh"}, "geometry": wind},
        {"properties": {"role": "affected_area"}, "geometry": wind},
    ]}  # fmt: skip
    try:
        out = zone_exposure(grid, None, geometry)
    finally:
        grid.close()
    assert [z["role"] for z in out["zones"]] == ["forecast_cone", "wind_120kmh"]
    assert out["zones"][0]["residents"] == 100 * 100
    assert out["zones"][1]["residents"] == 20 * 20
    assert zone_exposure(None, None, {"features": []})["status"] == "unavailable"


def test_profile_points_are_evenly_spaced_along_the_path():
    import itertools

    from atlas.engine.point import profile_points

    pts = profile_points([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)], 5)
    assert len(pts) == 5
    assert pts[0][:2] == (0.0, 0.0)
    assert abs(pts[-1][0] - 1.0) < 1e-6 and abs(pts[-1][1] - 1.0) < 1e-6
    d = [p[2] for p in pts]
    assert all(abs((b - a) - (d[1] - d[0])) < 1e-6 for a, b in itertools.pairwise(d))
