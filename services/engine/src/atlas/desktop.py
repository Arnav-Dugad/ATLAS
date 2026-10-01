"""Entry point for the packaged desktop app (the engine runs as a Tauri sidecar).

Keeps data in the user's application-data folder, points at the files bundled next to the
executable (registry, docs), allows the desktop webview's origin, installs the Core Pack on
first run, then serves on 127.0.0.1:8787 exactly as `atlas serve` does.

The engine stops when the app goes away. Tauri kills the sidecar it started, but a one-file
PyInstaller build is a bootloader that runs the engine as its own child, and that child would
outlive a killed bootloader (or a crashed app). So the engine watches both its parent and the
app (`ATLAS_PARENT_PID`) and shuts down cleanly when either exits.
"""

from __future__ import annotations

import _thread
import json
import logging
import os
import signal
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]

log = logging.getLogger("atlas.desktop")


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


def wait_for_exit(pid: int, poll_s: float = 1.0) -> None:
    """Block until process `pid` has exited (returns at once if it is already gone)."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        synchronize, infinite = 0x00100000, 0xFFFFFFFF
        handle = kernel32.OpenProcess(synchronize, False, pid)
        if not handle:
            if ctypes.get_last_error() == 5:  # access denied: it exists but cannot be watched
                while True:
                    time.sleep(3600)
            return  # no such process
        try:
            kernel32.WaitForSingleObject(handle, infinite)  # a held handle is immune to PID reuse
        finally:
            kernel32.CloseHandle(handle)
        return
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            pass
        time.sleep(poll_s)


def wait_for_reparent(ppid: int, poll_s: float = 1.0) -> None:
    """POSIX: a process whose parent dies is re-parented, so getppid() changes."""
    while os.getppid() == ppid:
        time.sleep(poll_s)


def stop_engine() -> None:
    """Ask uvicorn to shut down gracefully (as Ctrl+C would); force-exit if it hangs."""
    log.warning("the ATLAS app has exited; stopping the engine")
    _thread.interrupt_main(signal.SIGINT)
    time.sleep(20)
    os._exit(0)


def watch_app(on_exit: Callable[[], None] = stop_engine) -> list[threading.Thread]:
    """Start daemon threads that call `on_exit` once the parent or the app (ATLAS_PARENT_PID) exits."""
    fired = threading.Lock()

    def guard(wait: Callable[[], None]) -> None:
        wait()
        if fired.acquire(blocking=False):
            on_exit()

    waits: list[Callable[[], None]] = []
    ppid = os.getppid()
    if getattr(sys, "frozen", False):  # the parent is the one-file bootloader
        if sys.platform == "win32":
            waits.append(lambda: wait_for_exit(ppid))
        else:
            waits.append(lambda: wait_for_reparent(ppid))
    app = os.environ.get("ATLAS_PARENT_PID", "")
    if app.isdigit() and int(app) not in (ppid, os.getpid()):
        waits.append(lambda: wait_for_exit(int(app)))
    threads = [threading.Thread(target=guard, args=(w,), name="atlas-app-watch", daemon=True) for w in waits]
    for t in threads:
        t.start()
    return threads


def main() -> int:
    bundle = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[4]))
    configure_environment(bundle)
    watch_app()

    from atlas.cli import main as cli
    from atlas.config import get_settings
    from atlas.packs import PackManager

    if not PackManager(get_settings().packs_dir, None).installed("core"):
        cli(["setup"])  # first run: DuckDB extensions + Natural Earth Core Pack (~11 MB)
    try:
        return cli(["serve"])
    except KeyboardInterrupt:  # uvicorn re-raises the captured signal after a clean shutdown
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
