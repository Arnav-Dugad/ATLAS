"""Desktop Settings: API keys and data packs (engine side)."""

from __future__ import annotations

import json
import os
import sys
import time
import warnings
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

warnings.filterwarnings("ignore", category=DeprecationWarning)
from fastapi.testclient import TestClient

from atlas import desktop
from atlas.api import settings_routes
from atlas.api.app import create_app
from atlas.config import REPO_ROOT, Settings
from atlas.credentials import CredentialStore
from atlas.packs import PackManager
from atlas.runtime import Runtime

KEY = "0123456789abcdef" * 4  # same shape as a real OpenAQ key (64 hex)
APP = {"origin": "http://tauri.localhost"}


def _settings(tmp_path: Path, **kw: Any) -> Settings:
    base: dict[str, Any] = {
        "data_dir": tmp_path,
        "scheduler_enabled": False,
        "registry_path": REPO_ROOT / "data/registry/sources.json",
    }
    return Settings(**{**base, **kw})


@pytest.fixture
def app_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    async def no_network(_r: Runtime, name: str) -> dict[str, Any]:
        return {"ok": True, "message": f"stub test of {name}"}

    monkeypatch.setattr(settings_routes, "_test", no_network)
    monkeypatch.setattr(PackManager, "candidates", lambda self, pack_id, home=None: [])
    settings = _settings(tmp_path, desktop=True, cors_origins=["http://tauri.localhost"])
    with TestClient(create_app(settings), base_url="http://127.0.0.1:8787") as c:
        yield c


def test_settings_exist_only_in_the_desktop_app(tmp_path: Path) -> None:
    with TestClient(create_app(_settings(tmp_path)), base_url="http://127.0.0.1:8787") as c:
        assert c.get("/api/v1/settings").status_code == 404


def test_only_the_app_on_this_computer_may_use_settings(app_client: TestClient) -> None:
    assert app_client.get("/api/v1/settings", headers=APP).status_code == 200
    assert app_client.get("/api/v1/settings", headers={"origin": "https://evil.example"}).status_code == 403
    rebinding = app_client.get("/api/v1/settings", headers={"host": "evil.example:8787"})
    assert rebinding.status_code == 403
    put = app_client.put(
        "/api/v1/settings/credentials/openaq_api_key", json={"value": KEY}, headers={"origin": "https://evil.example"}
    )
    assert put.status_code == 403
    form = app_client.put(
        "/api/v1/settings/credentials/openaq_api_key",
        content=f'{{"value":"{KEY}"}}',
        headers={**APP, "content-type": "text/plain"},
    )
    assert form.status_code == 422, "no simple (CORS-preflight-free) requests"


def test_saving_a_key_applies_it_without_revealing_it(app_client: TestClient, tmp_path: Path) -> None:
    res = app_client.put("/api/v1/settings/credentials/openaq_api_key", json={"value": f"  {KEY} "}, headers=APP)
    assert res.status_code == 200
    body = res.json()
    cred = body["credentials"]["openaq_api_key"]
    assert cred == {"label": "OpenAQ API key", "configured": True, "hint": f"…{KEY[-4:]}", "source": "settings"}
    assert body["test"]["ok"] is True
    assert KEY not in json.dumps(app_client.get("/api/v1/settings", headers=APP).json())
    runtime = app_client.app.state.runtime  # type: ignore[attr-defined]
    assert runtime.settings.openaq_api_key.get_secret_value() == KEY
    stored = (tmp_path / "credentials.json").read_text("utf-8")
    if sys.platform == "win32":
        assert KEY not in stored and '"dpapi:' in stored
    assert CredentialStore(tmp_path).load() == {"openaq_api_key": KEY}

    cleared = app_client.put("/api/v1/settings/credentials/openaq_api_key", json={"value": None}, headers=APP).json()
    assert cleared["credentials"]["openaq_api_key"]["configured"] is False
    assert runtime.settings.openaq_api_key is None
    assert CredentialStore(tmp_path).load() == {}


def test_malformed_values_are_refused(app_client: TestClient) -> None:
    bad = app_client.put("/api/v1/settings/credentials/openaq_api_key", json={"value": "not a key; rm -rf"}, headers=APP)
    assert bad.status_code == 400 and "doesn't look like" in bad.json()["error"]["message"]
    assert app_client.put("/api/v1/settings/credentials/nope", json={"value": "x"}, headers=APP).status_code == 404


async def test_a_reliefweb_appname_schedules_the_connector_live(tmp_path: Path) -> None:
    rt = Runtime(_settings(tmp_path, scheduler_enabled=True))
    try:
        assert not any(j.group == "reliefweb" for j in rt.scheduler.jobs.values())
        rt.set_credential("reliefweb_appname", "atlas-test-app-x7q")
        await rt.refresh_connector("reliefweb")
        assert [j.name for j in rt.scheduler.jobs.values() if j.group == "reliefweb"] == ["reliefweb.disasters"]
        rt.set_credential("reliefweb_appname", None)
        await rt.refresh_connector("reliefweb")
        assert not any(j.group == "reliefweb" for j in rt.scheduler.jobs.values())
    finally:
        await rt.http.aclose()
        rt.db.close()


def _fake_population_pack(folder: Path) -> Path:
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    folder.mkdir(parents=True)
    with rasterio.open(
        folder / "GHS_POP_test.tif", "w", driver="GTiff", height=60, width=60, count=1, dtype="float32",
        crs="EPSG:4326", transform=from_origin(19.5, 10.5, 1 / 60, 1 / 60), nodata=-200,
    ) as ds:  # fmt: skip
        ds.write(np.full((60, 60), 10.0, dtype="float32"), 1)
    (folder / "manifest.json").write_text(json.dumps({"id": "population-ghsl", "title": "test", "files": []}), "utf-8")
    (folder / "notes.exe").write_bytes(b"MZ")  # never copied
    return folder


def _wait(client: TestClient, pack_id: str) -> dict[str, Any]:
    for _ in range(100):
        packs = client.get("/api/v1/settings", headers=APP).json()["packs"]
        task = next(p for p in packs if p["id"] == pack_id)["task"]
        if task and task["state"] in ("done", "error"):
            return task
        time.sleep(0.05)
    raise AssertionError("pack task did not finish")


def test_importing_an_existing_population_pack(app_client: TestClient, tmp_path: Path) -> None:
    source = _fake_population_pack(tmp_path / "checkout" / "data" / "runtime" / "packs" / "population-ghsl")
    res = app_client.post("/api/v1/settings/packs/population-ghsl/import", json={"path": f'"{source}"'}, headers=APP)
    assert res.status_code == 200 and res.json()["mode"] == "import"
    task = _wait(app_client, "population-ghsl")
    assert task["state"] == "done", task
    view = app_client.get("/api/v1/settings", headers=APP).json()
    assert view["population_ready"] is True
    copied = {p.name for p in (tmp_path / "packs" / "population-ghsl").iterdir()}
    assert copied == {"GHS_POP_test.tif", "manifest.json"}

    removed = app_client.delete("/api/v1/settings/packs/population-ghsl", headers=APP).json()
    assert removed["removed"] is True
    assert app_client.get("/api/v1/settings", headers=APP).json()["population_ready"] is False


def test_importing_the_wrong_folder_is_explained(app_client: TestClient, tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    res = app_client.post("/api/v1/settings/packs/population-ghsl/import", json={"path": str(empty)}, headers=APP)
    assert res.status_code == 400 and "manifest.json" in res.json()["error"]["message"]
    other = tmp_path / "other"
    other.mkdir()
    (other / "manifest.json").write_text(json.dumps({"id": "core"}), "utf-8")
    app_client.post("/api/v1/settings/packs/population-ghsl/import", json={"path": str(other)}, headers=APP)
    task = _wait(app_client, "population-ghsl")
    assert task["state"] == "error" and "does not hold" in task["error"]
    assert app_client.post("/api/v1/settings/packs/core/install", headers=APP).status_code == 404


def test_existing_downloads_are_found_in_checkouts(tmp_path: Path) -> None:
    home = tmp_path / "home"
    pack = home / "Desktop" / "ATLAS" / "data" / "runtime" / "packs" / "population-ghsl"
    pack.mkdir(parents=True)
    (pack / "manifest.json").write_text("{}", "utf-8")
    (home / "Documents" / "notes").mkdir(parents=True)
    manager = PackManager(tmp_path / "app" / "packs")
    assert manager.candidates("population-ghsl", home=home) == [str(pack)]


def test_stored_keys_reach_the_engine_but_never_override_the_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = CredentialStore(tmp_path)
    store.set("openaq_api_key", KEY)
    store.set("reliefweb_appname", "atlas-test-app-x7q")
    monkeypatch.delenv("ATLAS_OPENAQ_API_KEY", raising=False)
    monkeypatch.setenv("ATLAS_RELIEFWEB_APPNAME", "from-env")
    assert store.apply_to_environment() == ["openaq_api_key"]
    assert os.environ["ATLAS_OPENAQ_API_KEY"] == KEY
    assert os.environ["ATLAS_RELIEFWEB_APPNAME"] == "from-env"


def test_windows_data_moves_out_of_the_install_folder(tmp_path: Path) -> None:
    old, new = tmp_path / "ATLAS", tmp_path / "org.atlas.planetary"
    (old / "packs" / "core").mkdir(parents=True)
    (old / "atlas.duckdb").write_bytes(b"db")
    (old / "atlas-desktop.exe").write_bytes(b"MZ")
    assert desktop.migrate_legacy_data(new, old) == new
    assert (new / "atlas.duckdb").read_bytes() == b"db" and (new / "packs" / "core").is_dir()
    assert (old / "atlas-desktop.exe").exists(), "program files stay where the installer put them"
    assert not (old / "atlas.duckdb").exists()
    assert desktop.migrate_legacy_data(new, old) == new  # idempotent


def test_diagnostics_never_contain_keys(app_client: TestClient, tmp_path: Path) -> None:
    import zipfile

    app_client.put("/api/v1/settings/credentials/openaq_api_key", json={"value": KEY}, headers=APP)
    res = app_client.post("/api/v1/settings/diagnostics", headers=APP)
    assert res.status_code == 200
    path = Path(res.json()["path"])
    assert path.parent == tmp_path / "diagnostics" and path.exists()
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        blob = b"".join(zf.read(n) for n in names)
    assert "about.json" in names and not any("credentials" in n for n in names)
    assert KEY.encode() not in blob


def test_offline_regions_are_guarded_and_validated(app_client: TestClient) -> None:
    body = {"name": "Delhi", "bbox": [77.0, 28.5, 77.1, 28.6], "max_zoom": 9}
    assert (
        app_client.post("/api/v1/settings/offline/estimate", json=body, headers={"origin": "https://evil.example"}).status_code
        == 403
    )
    est = app_client.post("/api/v1/settings/offline/estimate", json=body, headers=APP).json()
    assert est["tiles"] > 0 and est["limit"] >= est["tiles"]
    huge = {**body, "bbox": [0, 0, 20, 20]}
    assert app_client.post("/api/v1/settings/offline/regions", json=huge, headers=APP).status_code == 400
    assert app_client.post("/api/v1/settings/offline/regions", json={**body, "max_zoom": 22}, headers=APP).status_code == 422
    assert app_client.delete("/api/v1/settings/offline/regions/../../x", headers=APP).status_code in (404, 405)
    assert app_client.get("/api/v1/settings/offline/regions", headers=APP).json() == {"regions": []}


def test_tile_endpoint_validates_and_prefers_saved_tiles(app_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from atlas.offline import OfflineStore

    async def fake_fetch(self: OfflineStore, name: str, z: int, x: int, y: int) -> bytes:
        return b"upstream"

    monkeypatch.setattr(OfflineStore, "fetch", fake_fetch)
    assert app_client.get("/api/v1/tiles/evil/1/0/0").status_code == 404
    assert app_client.get("/api/v1/tiles/s2/3/9/0").status_code == 404  # x out of range for z=3
    r = app_client.get("/api/v1/tiles/s2/3/4/3")
    assert r.status_code == 200 and r.content == b"upstream" and r.headers["content-type"] == "image/jpeg"
