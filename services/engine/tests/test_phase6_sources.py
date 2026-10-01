"""Phase 6 sources: EMSC earthquakes and NOAA tsunami-centre messages (real fixtures)."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from atlas.config import Settings
from atlas.connectors.base import ConnectorContext
from atlas.connectors.emsc import EmscConnector, region_title
from atlas.connectors.tsunami import TsunamiConnector
from atlas.engine.correlate import IncidentKey, score
from atlas.engine.severity import assess
from atlas.http.cache import HttpCache
from atlas.http.client import HttpClient
from atlas.http.security import UrlPolicy
from atlas.models import Hazard, Observation
from atlas.registry import Registry
from tests.conftest import NOW, fixture_bytes


@pytest.fixture
def ctx(tmp_path: Path, registry: Registry) -> ConnectorContext:
    http = HttpClient(HttpCache(tmp_path / "c"), UrlPolicy(registry.all_hosts()))
    return ConnectorContext(http=http, settings=Settings(data_dir=tmp_path), registry=registry)


def test_emsc_parses_real_events(ctx: ConnectorContext) -> None:
    out = EmscConnector(ctx).parse(fixture_bytes("emsc_events.json"))
    assert out.received == 3 and len(out.observations) == 3
    o = out.observations[0]
    assert o.source == "emsc" and o.hazard is Hazard.EARTHQUAKE
    assert o.title == "M5.0 earthquake — Moro Gulf, Mindanao, Philippines"
    assert o.magnitude == 5.0 and o.magnitude_unit == "mb" and o.depth_km == 9.4
    assert o.url and o.url.startswith("https://www.seismicportal.eu/eventdetails.html?unid=")
    assert o.incident_candidate is True
    assert region_title("NEAR EAST COAST OF HONSHU, JAPAN") == "Near East Coast of Honshu, Japan"


def test_emsc_rejects_malformed_payloads(ctx: ConnectorContext) -> None:
    out = EmscConnector(ctx).parse(b"{not json")
    assert out.rejected == 1 and not out.observations


def test_tsunami_messages_parse_with_category_and_bulletin(ctx: ConnectorContext) -> None:
    conn = TsunamiConnector(ctx)
    ntwc = conn.parse(fixture_bytes("tsunami_ntwc.xml"), "NTWC").observations
    ptwc = conn.parse(fixture_bytes("tsunami_ptwc.xml"), "PTWC").observations
    assert len(ntwc) == 1 and len(ptwc) == 1
    o = ntwc[0]
    assert o.metrics["tsunami_message"] == "information" and o.alert_level == "green"
    assert o.incident_candidate is False  # information statements only attach to existing incidents
    assert o.magnitude == 4.0 and o.magnitude_unit == "Mwp"
    assert o.description == "There is NO tsunami danger from this earthquake."
    assert o.url and o.url.startswith("https://www.tsunami.gov/events/")
    assert ptwc[0].description is None  # an empty note is not filled with the next line


def test_tsunami_parser_refuses_entity_expansion(ctx: ConnectorContext) -> None:
    bomb = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><feed>&b;</feed>'
    out = TsunamiConnector(ctx).parse(bomb, "NTWC")
    assert out.rejected == 1


def quake_key(minutes_ago: float, mag: float = 7.6) -> IncidentKey:
    t = NOW - timedelta(minutes=minutes_ago)
    return IncidentKey(id="I1", hazard=Hazard.EARTHQUAKE, lat=40.0, lon=143.0, started_at=t, last_observation_at=t, magnitude=mag)


def tsunami(category: str, minutes_after: float, lat: float = 40.1, mag: float = 7.4) -> Observation:
    t = NOW + timedelta(minutes=minutes_after)
    return Observation(source="tsunami", external_id=f"t-{category}-{minutes_after}", hazard=Hazard.EARTHQUAKE, title=f"Tsunami {category}",
                       lat=lat, lon=143.1, event_time=t, source_updated_at=t, magnitude=mag, alert_level="red",
                       metrics={"tsunami_message": category, "tsunami_centre": "PTWC"})  # fmt: skip


def test_tsunami_message_links_to_the_earthquake_it_follows() -> None:
    assert score(tsunami("warning", 12), quake_key(0)) is not None
    assert score(tsunami("warning", 240), quake_key(0)) is None  # too late
    assert score(tsunami("warning", 12, lat=46.0), quake_key(0)) is None  # too far
    assert score(tsunami("warning", 12, mag=5.0), quake_key(0)) is None  # magnitude disagrees


def test_official_tsunami_messages_raise_the_severity_floor() -> None:
    usgs = Observation(
        source="usgs",
        external_id="us1",
        hazard=Hazard.EARTHQUAKE,
        title="M6.6",
        lat=40.0,
        lon=143.0,
        event_time=NOW,
        magnitude=6.6,
    )
    base = assess(Hazard.EARTHQUAKE, [usgs])
    warned = assess(Hazard.EARTHQUAKE, [usgs, tsunami("warning", 10)])
    watched = assess(Hazard.EARTHQUAKE, [usgs, tsunami("advisory", 10)])
    info = assess(Hazard.EARTHQUAKE, [usgs, tsunami("information", 10)])
    assert base.level == 3 and warned.level == 5 and watched.level == 4 and info.level == 3
    assert "Official NOAA tsunami warning (PTWC)" in warned.basis
    assert warned.method == "atlas-severity-v1.2"
    # a bulletin's preliminary magnitude never replaces the agency magnitude
    assert "M6.6 (USGS)" in warned.basis


def test_space_weather_scales_parse() -> None:
    import json

    from atlas.engine import spaceweather

    out = spaceweather.parse(json.loads(fixture_bytes("swpc_noaa_scales.json")))
    assert set(out["current"]) == {"R", "S", "G"}
    assert all(isinstance(v["scale"], int) for v in out["current"].values())
    assert len(out["outlook"]) == 3 and "forecast" in out["note"]


def test_air_quality_keeps_only_fresh_stations_with_tracked_pollutants() -> None:
    from datetime import datetime

    from atlas.engine import airquality

    now = datetime(2026, 10, 1, 8, 0)
    sensor = lambda sid, name: {"id": sid, "parameter": {"id": sid, "name": name, "units": "µg/m³"}}  # noqa: E731
    locs = [
        {"id": 1, "name": "Fresh far", "provider": {"name": "CPCB"}, "coordinates": {"latitude": 28.70, "longitude": 77.20},
         "datetimeLast": {"utc": "2026-10-01T07:00:00Z"}, "sensors": [sensor(11, "pm25")]},
        {"id": 2, "name": "Fresh near", "provider": {"name": "AirGradient"}, "coordinates": {"latitude": 28.62, "longitude": 77.21},
         "datetimeLast": {"utc": "2026-10-01T07:30:00Z"}, "sensors": [sensor(21, "pm25"), sensor(22, "temperature")]},
        {"id": 3, "name": "Dead since 2018", "coordinates": {"latitude": 28.61, "longitude": 77.21},
         "datetimeLast": {"utc": "2018-02-22T04:00:00Z"}, "sensors": [sensor(31, "pm25")]},
        {"id": 4, "name": "Weather only", "coordinates": {"latitude": 28.61, "longitude": 77.21},
         "datetimeLast": {"utc": "2026-10-01T07:00:00Z"}, "sensors": [sensor(41, "temperature")]},
    ]  # fmt: skip
    out = airquality.fresh_stations(locs, 28.6139, 77.2090, now)
    assert [s["name"] for s in out] == ["Fresh near", "Fresh far"]
    assert out[0]["sensors"] == {21: ("pm25", "µg/m³")}


async def test_air_quality_without_a_key_says_how_to_enable(tmp_path: Path) -> None:
    from atlas.engine import airquality

    http = HttpClient(HttpCache(tmp_path / "c"), UrlPolicy(["api.openaq.org"]))
    out = await airquality.nearby(http, None, 0.0, 0.0)
    assert out["status"] == "unavailable" and "ATLAS_OPENAQ_API_KEY" in out["reason"]
