from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from atlas.config import Settings
from atlas.connectors.base import ConnectorContext
from atlas.connectors.eonet import EonetConnector
from atlas.connectors.gdacs import GdacsConnector
from atlas.connectors.gvp import GvpConnector
from atlas.connectors.nhc import NhcConnector, saffir_simpson
from atlas.connectors.reliefweb import ReliefWebConnector
from atlas.connectors.usgs import UsgsConnector
from atlas.http.cache import HttpCache
from atlas.http.client import HttpClient
from atlas.http.security import UrlPolicy
from atlas.models import ExternalRef, Hazard
from atlas.registry import Registry
from tests.conftest import fixture_bytes


@pytest.fixture
def ctx(tmp_path: Path, registry: Registry) -> ConnectorContext:
    http = HttpClient(HttpCache(tmp_path / "c"), UrlPolicy(registry.all_hosts()))
    return ConnectorContext(http=http, settings=Settings(data_dir=tmp_path), registry=registry)


class TestUsgs:
    def test_parses_real_feed(self, ctx: ConnectorContext) -> None:
        out = UsgsConnector(ctx).parse(fixture_bytes("usgs_feed.json"))
        assert out.received == 6
        assert out.filtered == 1  # the mining explosion
        assert len(out.observations) == 5
        big = max(out.observations, key=lambda o: o.magnitude or 0)
        assert big.hazard is Hazard.EARTHQUAKE
        assert big.magnitude == 6.6 and big.incident_candidate
        assert big.depth_km is not None and big.url and big.url.startswith("https://")
        assert ExternalRef(scheme="usgs", id=big.external_id) in big.external_refs
        small = min(out.observations, key=lambda o: o.magnitude or 99)
        assert not small.incident_candidate

    def test_malformed_payloads(self, ctx: ConnectorContext) -> None:
        c = UsgsConnector(ctx)
        assert c.parse(b"{not json").rejected == 1
        assert c.parse(b'{"features": "nope"}').observations == []
        out = c.parse(json.dumps({"features": [{"id": "x", "properties": {"type": "earthquake", "time": 1, "mag": 5},
                                                "geometry": {"coordinates": [500, 0, 10]}}]}).encode())  # fmt: skip
        assert out.rejected == 1  # longitude 500 rejected by validation


class TestGdacs:
    def test_parses_multi_hazard_list(self, ctx: ConnectorContext) -> None:
        out = GdacsConnector(ctx).parse_list(fixture_bytes("gdacs_events.json"))
        hazards = {o.hazard for o in out.observations}
        assert {Hazard.EARTHQUAKE, Hazard.TROPICAL_CYCLONE, Hazard.WILDFIRE, Hazard.FLOOD, Hazard.DROUGHT} <= hazards
        eq = next(o for o in out.observations if o.hazard is Hazard.EARTHQUAKE)
        assert eq.magnitude is not None and eq.magnitude_unit == "M"
        assert eq.alert_level in {"green", "orange", "red"}
        tc = next(o for o in out.observations if o.hazard is Hazard.TROPICAL_CYCLONE)
        assert isinstance(tc.metrics["max_wind_kt"], float)

    def test_tc_geometry_track_and_cone(self, ctx: ConnectorContext) -> None:
        conn = GdacsConnector(ctx)
        out = conn.parse_list(fixture_bytes("gdacs_events.json"))
        rachel = next(o for o in out.observations if "RACHEL" in o.title)
        conn.apply_geometry(rachel, json.loads(fixture_bytes("gdacs_tc_geometry.json")))
        assert rachel.geometry is not None
        roles = {f["properties"]["role"] for f in rachel.geometry["features"]}
        assert "forecast_cone" in roles and "wind_120kmh" in roles
        assert len(rachel.track) >= 20
        times = [p.time for p in rachel.track]
        assert times == sorted(times)
        assert any(p.kind == "forecast" for p in rachel.track) and any(p.kind == "observed" for p in rachel.track)


class TestEonet:
    def test_storms_become_cyclones_with_tracks(self, ctx: ConnectorContext) -> None:
        out = EonetConnector(ctx).parse(fixture_bytes("eonet_events.json"))
        storms = [o for o in out.observations if o.hazard is Hazard.TROPICAL_CYCLONE]
        assert len(storms) == 2
        assert all(o.track for o in storms)
        ice = next(o for o in out.observations if o.hazard is Hazard.SEA_LAKE_ICE)
        assert not ice.incident_candidate  # icebergs are tracked, never incidents


class TestNhc:
    def test_parses_current_storms(self, ctx: ConnectorContext) -> None:
        out = NhcConnector(ctx).parse(fixture_bytes("nhc_current.json"))
        assert len(out.observations) >= 1
        s = out.observations[0]
        assert s.hazard is Hazard.TROPICAL_CYCLONE
        assert s.metrics["max_wind_kt"] is not None and s.metrics["min_pressure_mb"] is not None
        assert s.external_refs[0].scheme == "nhc"

    @pytest.mark.parametrize(("kt", "cat"), [(30, "Tropical depression"), (50, "Tropical storm"), (64, "Category 1"),
                                             (100, "Category 3"), (140, "Category 5")])  # fmt: skip
    def test_saffir_simpson(self, kt: float, cat: str) -> None:
        assert saffir_simpson(kt) == cat


class TestGvp:
    def test_parses_weekly_rss(self, ctx: ConnectorContext) -> None:
        out = GvpConnector(ctx).parse(fixture_bytes("gvp_weekly.xml"))
        assert len(out.observations) == 3
        v = out.observations[0]
        assert v.hazard is Hazard.VOLCANO and v.lat is not None
        assert "<" not in (v.description or "")  # HTML stripped

    def test_rejects_xml_bombs(self, ctx: ConnectorContext) -> None:
        bomb = b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><rss>&lol2;</rss>'
        out = GvpConnector(ctx).parse(bomb)
        assert out.observations == []


class TestReliefWeb:
    def test_disabled_without_appname(self, ctx: ConnectorContext) -> None:
        ok, why = ReliefWebConnector(ctx).availability()
        assert not ok and "appname" in (why or "")

    def test_normalises_documented_shape(self, ctx: ConnectorContext) -> None:
        item: dict[str, Any] = {
            "id": 52000,
            "fields": {
                "name": "Philippines: Typhoon X - Sep 2026",
                "glide": "TC-2026-000150-PHL",
                "status": "alert",
                "type": [{"code": "TC", "name": "Tropical Cyclone"}],
                "primary_country": {"iso3": "phl", "location": {"lat": 12.0, "lon": 122.0}},
                "date": {"event": "2026-09-20T00:00:00+00:00", "created": "2026-09-20T05:00:00+00:00"},
                "url": "https://reliefweb.int/disaster/tc-2026-000150-phl",
            },
        }
        obs = ReliefWebConnector(ctx).normalize(item)
        assert obs is not None and obs.hazard is Hazard.TROPICAL_CYCLONE
        assert obs.country_iso3 == "PHL"
        assert ExternalRef(scheme="glide", id="TC-2026-000150-PHL") in obs.external_refs
        assert not obs.incident_candidate
