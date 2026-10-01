"""Single-process job scheduler.

Deliberately simple: one asyncio loop, bounded concurrency, per-job exponential backoff on
failure, manual triggers with a cooldown. No broker, no external queue — this runs on a
laptop and the whole pipeline fits comfortably in one process.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.scheduler")

MAX_BACKOFF = timedelta(hours=1)
MANUAL_COOLDOWN = timedelta(seconds=30)


@dataclass
class JobState:
    name: str
    group: str  # connector id or "system"
    interval: timedelta
    run: Callable[[], Awaitable[Any]]
    next_run: datetime
    running: bool = False
    last_started: datetime | None = None
    last_finished: datetime | None = None
    last_ok: datetime | None = None
    last_error: str | None = None
    failures: int = 0
    runs: int = 0
    last_duration_ms: float | None = None
    last_manual: datetime | None = None
    history: list[dict[str, Any]] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "group": self.group,
            "interval_s": int(self.interval.total_seconds()),
            "next_run": iso_z(self.next_run),
            "running": self.running,
            "last_started": iso_z(self.last_started),
            "last_finished": iso_z(self.last_finished),
            "last_ok": iso_z(self.last_ok),
            "last_error": self.last_error,
            "failures": self.failures,
            "runs": self.runs,
            "last_duration_ms": self.last_duration_ms,
        }


class Scheduler:
    def __init__(self, max_concurrency: int = 3) -> None:
        self.jobs: dict[str, JobState] = {}
        self._sem = asyncio.Semaphore(max_concurrency)
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._inflight: set[asyncio.Task[None]] = set()
        self._stopping = False

    def add(self, name: str, group: str, interval: timedelta, run: Callable[[], Awaitable[Any]], *,
            run_on_start: bool = True, start_delay: float = 0.0) -> None:  # fmt: skip
        first = utcnow() + (timedelta(seconds=start_delay) if run_on_start else interval)
        self.jobs[name] = JobState(name=name, group=group, interval=interval, run=run, next_run=first)

    def remove_group(self, group: str) -> list[str]:
        """Unschedule a connector's jobs (a run in progress finishes on its own)."""
        names = [name for name, job in self.jobs.items() if job.group == group]
        for name in names:
            del self.jobs[name]
        return names

    def wake(self) -> None:
        self._wake.set()

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="atlas-scheduler")

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        for t in list(self._inflight):
            t.cancel()
        if self._inflight:
            await asyncio.gather(*self._inflight, return_exceptions=True)

    def trigger_group(self, group: str) -> list[str]:
        now = utcnow()
        fired = []
        for job in self.jobs.values():
            if job.group != group or job.running:
                continue
            if job.last_manual and now - job.last_manual < MANUAL_COOLDOWN:
                continue
            job.last_manual = now
            job.next_run = now
            fired.append(job.name)
        self._wake.set()
        return fired

    async def _loop(self) -> None:
        while not self._stopping:
            now = utcnow()
            for job in self.jobs.values():
                if not job.running and job.next_run <= now:
                    job.running = True
                    task = asyncio.create_task(self._execute(job), name=f"job:{job.name}")
                    self._inflight.add(task)
                    task.add_done_callback(self._inflight.discard)
            upcoming = min((j.next_run for j in self.jobs.values() if not j.running), default=now + timedelta(seconds=5))
            delay = max(0.25, min(5.0, (upcoming - utcnow()).total_seconds()))
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except TimeoutError:
                pass

    async def _execute(self, job: JobState) -> None:
        async with self._sem:
            job.last_started = utcnow()
            job.runs += 1
            try:
                await job.run()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                job.failures += 1
                job.last_error = f"{type(exc).__name__}: {exc}"[:500]
                backoff = min(job.interval * (2 ** min(job.failures, 6)), max(MAX_BACKOFF, job.interval))
                job.next_run = utcnow() + backoff * random.uniform(0.8, 1.0)
                log.warning("job %s failed (%d): %s; next in %s", job.name, job.failures, job.last_error, backoff)
            else:
                job.failures = 0
                job.last_error = None
                job.last_ok = utcnow()
                job.next_run = utcnow() + job.interval * random.uniform(0.97, 1.03)
            finally:
                job.running = False
                job.last_finished = utcnow()
                job.last_duration_ms = round((job.last_finished - job.last_started).total_seconds() * 1000, 1)
                self._wake.set()
