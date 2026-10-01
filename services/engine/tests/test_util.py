from __future__ import annotations

from datetime import datetime

import pytest

from atlas.util.geo import (
    bbox_around,
    bbox_contains,
    bbox_of,
    compass_point,
    destination_point,
    haversine_km,
    initial_bearing_deg,
    parse_hemisphere_coord,
    valid_coordinate,
)
from atlas.util.ids import crockford32, incident_id
from atlas.util.text import html_to_text, normalize_storm_name
from atlas.util.timeutil import from_epoch_ms, iso_z, parse_iso


class TestGeo:
    def test_haversine_known_distance(self) -> None:
        # London -> Paris great-circle distance is ~343.5 km
        assert haversine_km(51.5074, -0.1278, 48.8566, 2.3522) == pytest.approx(343.5, abs=1.5)

    def test_haversine_antipodal_and_zero(self) -> None:
        assert haversine_km(0, 0, 0, 0) == 0
        assert haversine_km(0, 0, 0, 180) == pytest.approx(20015.1, abs=1)

    def test_bearing_and_compass(self) -> None:
        assert initial_bearing_deg(0, 0, 1, 0) == pytest.approx(0, abs=1e-6)
        assert initial_bearing_deg(0, 0, 0, 1) == pytest.approx(90, abs=1e-6)
        assert compass_point(0) == "N"
        assert compass_point(22.5) == "NNE"
        assert compass_point(359) == "N"
        assert compass_point(225) == "SW"

    def test_destination_roundtrip(self) -> None:
        lat, lon = destination_point(35.0, 139.0, 45.0, 100.0)
        assert haversine_km(35.0, 139.0, lat, lon) == pytest.approx(100.0, rel=1e-6)

    def test_bbox_antimeridian(self) -> None:
        box = bbox_of([(179.5, 10), (-179.5, 11)])
        assert box is not None
        west, _south, east, _north = box
        assert west == pytest.approx(179.5) and east == pytest.approx(-179.5)
        assert bbox_contains(box, 10.5, 179.9)
        assert bbox_contains(box, 10.5, -179.9)
        assert not bbox_contains(box, 10.5, 0)

    def test_bbox_around_contains_circle(self) -> None:
        box = bbox_around(60.0, 10.0, 100)
        for b in range(0, 360, 15):
            lat, lon = destination_point(60.0, 10.0, b, 99.0)
            assert bbox_contains(box, lat, lon)

    def test_coordinates(self) -> None:
        assert parse_hemisphere_coord("19.2N") == 19.2
        assert parse_hemisphere_coord("108.5W") == -108.5
        assert valid_coordinate(0, 0)
        assert not valid_coordinate(91, 0)
        assert not valid_coordinate(float("nan"), 0)
        assert not valid_coordinate(None, 0)


class TestTime:
    def test_parse_iso_variants(self) -> None:
        assert parse_iso("2026-10-01T03:00:00Z") == datetime(2026, 10, 1, 3)
        assert parse_iso("2026-10-01T05:00:00+02:00") == datetime(2026, 10, 1, 3)
        assert parse_iso("2026-10-01T03:00:00") == datetime(2026, 10, 1, 3)  # naive = UTC
        assert parse_iso("not a date") is None
        assert parse_iso(None) is None

    def test_epoch_and_iso(self) -> None:
        dt = from_epoch_ms(1790824462470)
        assert dt is not None and dt.tzinfo is None
        assert iso_z(datetime(2026, 1, 2, 3, 4, 5)) == "2026-01-02T03:04:05.000Z"


class TestText:
    def test_html_to_text_strips_scripts_and_tags(self) -> None:
        dirty = "<p>Alert <b>Level</b> 3</p><script>alert('x')</script><style>p{}</style>&amp; more"
        assert html_to_text(dirty) == "Alert Level 3 & more"

    def test_html_to_text_handles_garbage(self) -> None:
        assert html_to_text("<<<>>>") in ("", "<<<>>>", "<<>>>")
        assert html_to_text(None) == ""

    def test_storm_names(self) -> None:
        assert normalize_storm_name("Tropical Storm Hanna") == "hanna"
        assert normalize_storm_name("HANNA-26") == "hanna"
        assert normalize_storm_name("Super Typhoon Surigae") == "surigae"
        assert normalize_storm_name("NINETEEN-E-26") == normalize_storm_name("Nineteen-E")


class TestIds:
    def test_incident_ids_are_deterministic(self) -> None:
        a = incident_id("EQ", datetime(2026, 9, 1), "usgs:us123")
        b = incident_id("EQ", datetime(2026, 9, 1), "usgs:us123")
        c = incident_id("EQ", datetime(2026, 9, 1), "usgs:us124")
        assert a == b != c
        assert a.startswith("ATL-EQ-2026-") and len(a.split("-")[-1]) == 8

    def test_crockford_alphabet(self) -> None:
        out = crockford32(b"\xff" * 16, 12)
        assert len(out) == 12 and not set(out) & set("ILOU")


def test_from_epoch_ms_handles_times_before_1970() -> None:
    from atlas.util.timeutil import from_epoch_ms, iso_z

    assert iso_z(from_epoch_ms(-1134832594180)) == "1934-01-15T08:43:25.820Z"  # 1934 Bihar–Nepal earthquake
    assert iso_z(from_epoch_ms(1429942285950)) == "2015-04-25T06:11:25.950Z"  # 2015 Gorkha


def test_merged_track_times_are_explicit_utc() -> None:
    from atlas.engine.fusion import _merge_track
    from atlas.models import Hazard, Observation
    from atlas.models.core import TrackPoint

    t = datetime(2026, 9, 21, 12)
    o = Observation(source="eonet", external_id="E1", hazard=Hazard.TROPICAL_CYCLONE, title="Polo", lat=20.0, lon=-110.0,
                    event_time=t, track=[TrackPoint(time=t, lat=20.0, lon=-110.0, wind_kt=55)])  # fmt: skip
    assert _merge_track([o])[0]["time"] == "2026-09-21T12:00:00.000Z"
