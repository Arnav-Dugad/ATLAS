"""Settings for the desktop app: optional API keys and data packs.

Only mounted behaviour in the desktop app (``ATLAS_DESKTOP``); a 404 elsewhere. Every request
must come from the app itself: the Host must be the loopback engine (no DNS rebinding) and a
browser Origin, when sent, must be one the engine already allows — so a web page cannot change
keys or start downloads. Secret values are never returned, only whether one is set.
"""

from __future__ import annotations

import asyncio
import json
import platform
import sys
import time
import zipfile
from datetime import timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from atlas import __version__
from atlas.credentials import SPECS, CredentialStore, hint, validate
from atlas.http.client import FetchError
from atlas.observability import log_buffer, metrics
from atlas.packs import PACKS
from atlas.runtime import Runtime
from atlas.util.timeutil import iso_z, utcnow

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])

_CANDIDATES: dict[str, tuple[float, list[str]]] = {}
BUSY = ("starting", "downloading", "extracting", "copying", "indexing")


def guard(request: Request) -> Runtime:
    r: Runtime = request.app.state.runtime
    if not r.settings.desktop:
        raise HTTPException(404, "Settings are part of the ATLAS desktop app.")
    host = (request.headers.get("host") or "").lower()
    if host not in {f"127.0.0.1:{r.settings.port}", f"localhost:{r.settings.port}"}:
        raise HTTPException(403, "Settings only answer the ATLAS app on this computer.")
    origin = request.headers.get("origin")
    if origin and origin not in r.settings.cors_origins:
        raise HTTPException(403, "Settings only answer the ATLAS app on this computer.")
    return r


def _current(r: Runtime, name: str) -> str | None:
    if name == "openaq_api_key":
        return r.settings.openaq_api_key.get_secret_value() if r.settings.openaq_api_key else None
    if name == "reliefweb_appname":
        return r.settings.reliefweb_appname
    if name == "hdx_app_identifier":
        return r.settings.hdx_app_identifier.get_secret_value() if r.settings.hdx_app_identifier else None
    raise KeyError(name)


def _credentials(r: Runtime) -> dict[str, Any]:
    stored = CredentialStore(r.settings.data_dir).load()
    out: dict[str, Any] = {}
    for name, spec in SPECS.items():
        value = _current(r, name)
        source = None
        if value:
            source = "settings" if stored.get(name) == value else "environment"
        out[name] = {"label": spec.label, "configured": bool(value), "hint": hint(value, spec.secret), "source": source}
    return out


def _connector(r: Runtime, cid: str) -> dict[str, Any]:
    ok, why = r.availability()[cid]
    jobs = [j.snapshot() for j in r.scheduler.jobs.values() if j.group == cid]
    last_ok = max((j["last_ok"] for j in jobs if j["last_ok"]), default=None)
    last_error = next((j["last_error"] for j in jobs if j["last_error"]), None)
    return {"enabled": ok, "reason": why, "scheduled": bool(jobs), "last_ok": last_ok, "last_error": last_error}


async def _candidates(r: Runtime, pack_id: str) -> list[str]:
    hit = _CANDIDATES.get(pack_id)
    if hit and time.monotonic() - hit[0] < 30:
        return hit[1]
    found = await asyncio.to_thread(r.packs.candidates, pack_id)
    _CANDIDATES[pack_id] = (time.monotonic(), found)
    return found


async def _packs(r: Runtime) -> list[dict[str, Any]]:
    out = []
    for p in r.packs.status():
        task = r.pack_tasks.get(p["id"])
        p["task"] = task
        busy = bool(task and task["state"] in BUSY)
        p["candidates"] = await _candidates(r, p["id"]) if p["optional"] and not p["installed"] and not busy else []
        out.append(p)
    return out


@router.get("")
async def settings_view(request: Request) -> dict[str, Any]:
    r = guard(request)
    return {
        "version": __version__,
        "data_dir": str(r.settings.data_dir),
        "credentials": _credentials(r),
        "connectors": {"reliefweb": _connector(r, "reliefweb")},
        "packs": await _packs(r),
        "population_ready": r.population is not None,
    }


class CredentialBody(BaseModel):
    value: str | None = Field(default=None, max_length=300)


async def _test(r: Runtime, name: str) -> dict[str, Any]:
    value = _current(r, name)
    if not value:
        return {"ok": False, "message": "Nothing saved yet."}
    if name == "openaq_api_key":
        try:
            await r.http.get(
                "https://api.openaq.org/v3/parameters", params={"limit": 1},
                headers={"X-API-Key": value, "Accept": "application/json"}, ttl=timedelta(seconds=1), force=True,
                attempts=1, timeout_s=20, max_bytes=1 << 20, source_id="openaq",
            )  # fmt: skip
        except FetchError as exc:
            if exc.status in (401, 403):
                return {"ok": False, "message": "OpenAQ rejected this key. Copy it again from explore.openaq.org/account."}
            return {"ok": False, "message": f"Couldn't reach OpenAQ to check the key ({exc}). It is saved; try again later."}
        return {"ok": True, "message": "OpenAQ accepted the key. Incidents near monitoring stations now show air quality."}
    if name == "hdx_app_identifier":
        try:
            await r.http.get(
                "https://hapi.humdata.org/api/v2/metadata/location", params={"app_identifier": value, "limit": 1, "output_format": "json"},
                ttl=timedelta(seconds=1), force=True, attempts=1, timeout_s=20, max_bytes=1 << 20, source_id="hdx-hapi",
            )  # fmt: skip
        except FetchError as exc:
            if exc.status in (400, 401, 403, 422):
                return {
                    "ok": False,
                    "message": "HDX rejected this identifier. Generate it again at hapi.humdata.org/docs (encode_app_identifier).",
                }
            return {"ok": False, "message": f"Couldn't reach HDX to check the identifier ({exc}). It is saved; try again later."}
        return {"ok": True, "message": "HDX accepted the identifier. Country context now appears in each incident's Context tab."}
    try:
        await r.http.get(
            "https://api.reliefweb.int/v2/disasters", params={"appname": value, "limit": 1},
            ttl=timedelta(seconds=1), force=True, attempts=1, timeout_s=20, max_bytes=2 << 20, source_id="reliefweb",
        )  # fmt: skip
    except FetchError as exc:
        if exc.status == 403:
            return {
                "ok": False, "pending": True,
                "message": "ReliefWeb hasn't approved this appname yet (HTTP 403). It is saved: ATLAS retries at most "
                "hourly and starts using it as soon as ReliefWeb approves it.",
            }  # fmt: skip
        return {"ok": False, "message": f"Couldn't reach ReliefWeb to check the appname ({exc}). It is saved; try again later."}
    return {"ok": True, "message": "ReliefWeb accepted the appname. Its disaster reports now corroborate incidents."}


@router.put("/credentials/{name}")
async def save_credential(request: Request, name: str, body: CredentialBody) -> dict[str, Any]:
    r = guard(request)
    if name not in SPECS:
        raise HTTPException(404, "unknown setting")
    value: str | None = None
    if body.value and body.value.strip():
        try:
            value = validate(name, body.value)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None
    CredentialStore(r.settings.data_dir).set(name, value)
    r.set_credential(name, value)
    if name == "reliefweb_appname":
        await r.refresh_connector("reliefweb")
    test = await _test(r, name) if value else None
    return {"credentials": _credentials(r), "test": test}


@router.post("/credentials/{name}/test")
async def test_credential(request: Request, name: str) -> dict[str, Any]:
    r = guard(request)
    if name not in SPECS:
        raise HTTPException(404, "unknown setting")
    return await _test(r, name)


def _pack_id(pack_id: str) -> str:
    spec = PACKS.get(pack_id)
    if spec is None or not spec.optional:
        raise HTTPException(404, "unknown optional pack")
    return pack_id


@router.post("/packs/{pack_id}/install")
async def install_pack(request: Request, pack_id: str) -> dict[str, Any]:
    r = guard(request)
    _CANDIDATES.pop(pack_id, None)
    return r.start_pack_task(_pack_id(pack_id))


class ImportBody(BaseModel):
    path: str = Field(min_length=3, max_length=1000)


@router.post("/packs/{pack_id}/import")
async def import_pack(request: Request, pack_id: str, body: ImportBody) -> dict[str, Any]:
    r = guard(request)
    pack_id = _pack_id(pack_id)
    source = Path(body.path.strip().strip('"'))
    if not await asyncio.to_thread((source / "manifest.json").is_file):
        raise HTTPException(400, "That folder doesn't contain an ATLAS pack (no manifest.json).")
    _CANDIDATES.pop(pack_id, None)
    return r.start_pack_task(pack_id, source)


@router.delete("/packs/{pack_id}")
async def remove_pack(request: Request, pack_id: str) -> dict[str, Any]:
    r = guard(request)
    pack_id = _pack_id(pack_id)
    task = r.pack_tasks.get(pack_id)
    if task and task["state"] in BUSY:
        raise HTTPException(409, "The pack is being installed.")
    removed = await asyncio.to_thread(r.remove_pack, pack_id)
    _CANDIDATES.pop(pack_id, None)
    return {"removed": removed, "packs": await _packs(r)}


def _diagnostics(r: Runtime, view: dict[str, Any]) -> Path:
    """Zip what helps diagnose a problem. Never credentials.json, keys or the database."""
    out_dir = r.settings.data_dir / "diagnostics"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"atlas-diagnostics-{stamp}.zip"
    about = {
        "generated_at": iso_z(utcnow()),
        "engine_version": __version__,
        "python": sys.version,
        "platform": platform.platform(),
        "settings": view,
        "connectors": {cid: {"enabled": ok, "reason": why} for cid, (ok, why) in r.availability().items()},
        "jobs": [j.snapshot() for j in r.scheduler.jobs.values()],
        "metrics": metrics.snapshot(),
        "db_bytes": r.db.size_bytes(),
        "cache_bytes": r.cache.total_bytes(),
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("about.json", json.dumps(about, indent=2, default=str))
        zf.writestr("recent-log.json", json.dumps(list(log_buffer.records), indent=1, default=str))
        logs = r.settings.data_dir / "logs"
        if logs.is_dir():
            for f in sorted(logs.glob("engine.log*")):
                zf.write(f, f"logs/{f.name}")
    for old in sorted(out_dir.glob("atlas-diagnostics-*.zip"))[:-5]:  # keep the last five
        old.unlink(missing_ok=True)
    return path


@router.post("/diagnostics")
async def export_diagnostics(request: Request) -> dict[str, Any]:
    r = guard(request)
    view = {"credentials": _credentials(r), "packs": [{k: v for k, v in p.items() if k != "candidates"} for p in await _packs(r)]}
    path = await asyncio.to_thread(_diagnostics, r, view)
    return {"path": str(path), "bytes": path.stat().st_size}
