"""ATLAS command-line interface.

atlas setup                 install DuckDB extensions + Core Pack, apply migrations
atlas serve [--no-sync]     run the API + ingestion scheduler
atlas sync <source|all>     run one source's jobs once and print a report
atlas packs [list|install|remove] <id>
atlas demo build            cache curated historical events for Demo Mode
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any

from atlas import __version__
from atlas.config import get_settings
from atlas.observability import configure_logging


def _runtime(scheduler: bool = False) -> Any:
    from atlas.runtime import Runtime

    settings = get_settings()
    settings.scheduler_enabled = scheduler
    return Runtime(settings)


async def _setup() -> int:
    rt = _runtime()
    print(f"ATLAS {__version__} · data dir {rt.settings.data_dir}")
    print(f"  DuckDB extensions: {rt.db.extensions}")
    if not all(rt.db.extensions.values()):
        print("  ! some DuckDB extensions could not be installed; fire indexing requires h3", file=sys.stderr)
    manifest = await rt.packs.install("core")
    print(f"  Core Pack installed: {len(manifest.get('files', []))} files")
    rt.reload_geocoder()
    print(f"  Geocoder ready: {rt.geocoder.available}")
    await rt.http.aclose()
    rt.db.close()
    return 0


async def _sync(source: str) -> int:
    rt = _runtime()
    rt.bus.bind(asyncio.get_running_loop())
    targets = list(rt.connectors) if source == "all" else [source]
    avail = rt.availability()
    code = 0
    for sid in targets:
        if sid not in rt.connectors:
            print(f"unknown source {sid!r}; choose from {', '.join(rt.connectors)}", file=sys.stderr)
            return 2
        ok, why = avail[sid]
        if not ok:
            print(f"- {sid}: skipped ({why})")
            continue
        try:
            res = await rt.sync_now(sid)
            print(f"- {sid}: {json.dumps(res)}")
        except Exception as exc:
            print(f"- {sid}: FAILED {type(exc).__name__}: {exc}", file=sys.stderr)
            code = 1
    with rt.db.read() as cur:
        rows = cur.execute("SELECT hazard, status, count(*) FROM incidents GROUP BY ALL ORDER BY 3 DESC").fetchall()
    print("incidents:", ", ".join(f"{h}/{s}={n}" for h, s, n in rows) or "none")
    await rt.http.aclose()
    rt.db.close()
    return code


async def _packs(action: str, pack_id: str | None) -> int:
    # Packs never touch the database, so this works while the engine is running.
    from atlas.http.cache import HttpCache
    from atlas.http.client import HttpClient
    from atlas.http.security import UrlPolicy
    from atlas.packs import PackManager
    from atlas.registry import load_registry

    settings = get_settings()
    registry = load_registry(settings.registry_path)
    http = HttpClient(HttpCache(settings.cache_dir / "http"), UrlPolicy(registry.all_hosts()), offline=settings.offline)
    packs = PackManager(settings.packs_dir, http)
    try:
        if action == "list":
            for p in packs.status():
                mark = "✓" if p["installed"] else " "
                print(f"[{mark}] {p['id']:<18} {p['title']}  (~{p['approx_size_mb']} MB)  {p['license']}")
        elif action == "install" and pack_id:
            man = await packs.install(pack_id, force=True)
            print(json.dumps(man, indent=2))
            if pack_id == "population-ghsl":
                print("Restart the engine (or call POST /api/v1/packs/reload) to enable population exposure.")
        elif action == "remove" and pack_id:
            print("removed" if packs.remove(pack_id) else "not removed (missing or required pack)")
    finally:
        await http.aclose()
    return 0


async def _export_static(out: str) -> int:
    from pathlib import Path

    from atlas.export_static import export_spectral, export_static

    rt = _runtime()
    try:
        snap = await asyncio.to_thread(export_static, rt, Path(out))
        snap["spectral"] = await export_spectral(rt, Path(out))
        (Path(out) / "snapshot.json").write_text(json.dumps(snap, indent=2), "utf-8")
        print(json.dumps(snap, indent=2))
    finally:
        await rt.http.aclose()
        rt.db.close()
    return 0


def _serve(no_sync: bool) -> int:
    import uvicorn

    from atlas.api.app import create_app

    settings = get_settings()
    if no_sync:
        settings.scheduler_enabled = False
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="warning", access_log=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="atlas", description="ATLAS planetary intelligence engine")
    parser.add_argument("--version", action="version", version=f"atlas {__version__}")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup")
    s = sub.add_parser("serve")
    s.add_argument("--no-sync", action="store_true", help="serve cached data only; do not poll sources")
    y = sub.add_parser("sync")
    y.add_argument("source")
    p = sub.add_parser("packs")
    p.add_argument("action", choices=["list", "install", "remove"])
    p.add_argument("pack", nargs="?")
    x = sub.add_parser("export-static", help="write a read-only JSON snapshot for static hosting")
    x.add_argument("out")
    d = sub.add_parser("demo")
    d.add_argument("action", choices=["build"])
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    configure_logging(logging.DEBUG if args.verbose else logging.INFO)

    if args.cmd == "setup":
        return asyncio.run(_setup())
    if args.cmd == "serve":
        return _serve(args.no_sync)
    if args.cmd == "sync":
        return asyncio.run(_sync(args.source))
    if args.cmd == "packs":
        return asyncio.run(_packs(args.action, args.pack))
    if args.cmd == "export-static":
        return asyncio.run(_export_static(args.out))
    if args.cmd == "demo":
        from atlas.demo import build_demo

        return asyncio.run(build_demo())
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
