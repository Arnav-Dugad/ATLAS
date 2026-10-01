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
