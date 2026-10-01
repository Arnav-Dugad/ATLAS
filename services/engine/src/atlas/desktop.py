"""Entry point for the packaged desktop app (the engine runs as a Tauri sidecar).

Keeps data in the user's application-data folder, points at the files bundled next to the
executable (registry, docs), allows the desktop webview's origin, installs the Core Pack on
first run, then serves on 127.0.0.1:8787 exactly as `atlas serve` does.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]


def data_home() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "ATLAS"


def configure_environment(bundle: Path) -> None:
    os.environ.setdefault("ATLAS_DATA_DIR", str(data_home()))
    registry = bundle / "data" / "registry" / "sources.json"
    if registry.is_file():
        os.environ.setdefault("ATLAS_REGISTRY_PATH", str(registry))
    docs = bundle / "docs"
    if docs.is_dir():
        os.environ.setdefault("ATLAS_DOCS_DIR", str(docs))
    os.environ.setdefault("ATLAS_CORS_ORIGINS", json.dumps(DESKTOP_ORIGINS))


def main() -> int:
    bundle = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[4]))
    configure_environment(bundle)

    from atlas.cli import main as cli
    from atlas.config import get_settings
    from atlas.packs import PackManager

    if not PackManager(get_settings().packs_dir, None).installed("core"):
        cli(["setup"])  # first run: DuckDB extensions + Natural Earth Core Pack (~11 MB)
    return cli(["serve"])


if __name__ == "__main__":
    raise SystemExit(main())
