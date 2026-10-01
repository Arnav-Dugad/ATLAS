from __future__ import annotations

import asyncio
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from atlas import cli, desktop
from atlas.config import get_settings


def test_one_shot_runtime_leaves_the_servers_scheduler_on(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The desktop entry point runs `setup` then `serve` in one process; the first run once
    served with the scheduler off because setup's runtime switched it off globally."""
    monkeypatch.setenv("ATLAS_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    try:
        rt = cli._runtime()
        try:
            assert rt.settings.scheduler_enabled is False
            assert get_settings().scheduler_enabled is True
        finally:
            asyncio.run(rt.http.aclose())
            rt.db.close()
    finally:
        get_settings.cache_clear()


def test_desktop_engine_stops_when_the_app_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    """The sidecar must not outlive the app (a one-file build runs the engine as a grandchild)."""
    app = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(2)"])
    monkeypatch.setenv("ATLAS_PARENT_PID", str(app.pid))
    stopped = threading.Event()
    threads = desktop.watch_app(on_exit=stopped.set)
    assert threads, "the app process is watched"
    assert not stopped.wait(0.5), "still running: the engine keeps serving"
    app.wait(timeout=10)
    assert stopped.wait(10), "the engine is told to stop once the app has gone"


def test_waiting_for_a_process_that_already_exited_returns() -> None:
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait(timeout=10)
    desktop.wait_for_exit(gone.pid, poll_s=0.05)
