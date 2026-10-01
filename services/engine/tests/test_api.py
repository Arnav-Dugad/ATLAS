from __future__ import annotations

import warnings
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path

import pytest

warnings.filterwarnings("ignore", category=DeprecationWarning)
from fastapi.testclient import TestClient

from atlas.api.app import create_app
from atlas.config import REPO_ROOT, Settings
from atlas.models import ExternalRef, Hazard, Observation
from atlas.util.timeutil import utcnow


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(data_dir=tmp_path, scheduler_enabled=False, registry_path=REPO_ROOT / "data/registry/sources.json")
    app = create_app(settings)
    with TestClient(app) as c:
        rt = app.state.runtime
        now = utcnow()
        o = Observation(source="usgs", external_id="us1", hazard=Hazard.EARTHQUAKE, title="M6.1", lat=10.0, lon=20.0,
                        magnitude=6.1, depth_km=12.0, event_time=now - timedelta(hours=1), source_updated_at=now,
                        url="https://earthquake.usgs.gov/earthquakes/eventpage/us1", external_refs=[ExternalRef(scheme="usgs", id="us1")])  # fmt: skip
        rt.pipeline.ingest("usgs", [o], complete_snapshot=False)
        yield c


def test_list_and_detail(client: TestClient) -> None:
    res = client.get("/api/v1/incidents")
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 1
    item = body["items"][0]
    assert item["severity"]["level"] == 3 and item["severity"]["method"].startswith("atlas-severity-v1")
    assert item["started_at"].endswith("Z")
    assert {m["provenance"] for m in item["headline"]} <= {"real", "derived", "model", "simulation", "unavailable"}

    detail = client.get(f"/api/v1/incidents/{item['id']}").json()
    assert detail["observations"][0]["source"] == "usgs"
    assert any(c["source_id"] == "usgs" for c in detail["citations"])
    assert any("official" not in link["label"].lower() or link["url"] for link in detail["official_links"])
    assert detail["limitations"]

    hist = client.get(f"/api/v1/incidents/{item['id']}/knowledge").json()
    assert hist["observations"][0]["version"] == 1


def test_errors_are_structured(client: TestClient) -> None:
    missing = client.get("/api/v1/incidents/ATL-XX-0000-NOPE")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "http_error"
    bad = client.get("/api/v1/incidents", params={"bbox": "1,2,3"})
    assert bad.status_code == 400
    invalid = client.get("/api/v1/incidents", params={"min_severity": 9})
    assert invalid.status_code == 422 and "Traceback" not in invalid.text


def test_security_headers(client: TestClient) -> None:
    res = client.get("/api/v1/health")
    assert res.headers["X-Content-Type-Options"] == "nosniff"
    assert "frame-ancestors 'none'" in res.headers["Content-Security-Policy"]


def test_sources_and_layers(client: TestClient) -> None:
    sources = {s["id"]: s for s in client.get("/api/v1/sources").json()}
    assert sources["reliefweb"]["status"] == "disabled"
    assert sources["usgs"]["meta"]["license"]["name"].startswith("Public domain")
    eq = client.get("/api/v1/layers/earthquakes").json()
    assert eq["count"] == 1 and eq["columns"]["mag"] == [6.1]
    assert client.get("/api/v1/overview").status_code == 200


def test_search_parses(client: TestClient) -> None:
    res = client.get("/api/v1/search", params={"q": "recent earthquakes"}).json()
    assert res["structured"]["parsed"]["hazards"] == ["earthquake"]


def test_polygon_exposure_validates_and_skips_overpass_for_large_areas(client: TestClient) -> None:
    bad = client.post("/api/v1/exposure/polygon", json={"coordinates": [[0, 0], [1, 1]]})
    assert bad.status_code == 422
    out_of_range = client.post("/api/v1/exposure/polygon", json={"coordinates": [[0, 0], [200, 0], [0, 1]]})
    assert out_of_range.status_code == 400
    too_wide = client.post("/api/v1/exposure/polygon", json={"coordinates": [[0, 0], [40, 0], [40, 1], [0, 1]]})
    assert too_wide.status_code == 400
    # ~1.2 million km²: residents need the Population Pack (absent here), facilities are refused
    # without any network request because the area exceeds the fair-use cap.
    big = client.post("/api/v1/exposure/polygon", json={"coordinates": [[0, 0], [10, 0], [10, 10], [0, 10]]}).json()
    assert big["area_km2"] > 1_000_000
    assert big["residents"]["provenance"] == "unavailable"
    assert big["facilities"]["status"] == "unavailable"
