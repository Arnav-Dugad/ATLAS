"""Local-only observability: structured logs, counters and latency summaries.

Nothing here leaves the machine. The in-memory ring buffers back the Data Health and
Observability views; they are deliberately bounded so a long-running instance never grows.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

from atlas.util.timeutil import iso_z, utcnow


@dataclass
class _Summary:
    count: int = 0
    total: float = 0.0
    maximum: float = 0.0
    recent: deque[float] = field(default_factory=lambda: deque(maxlen=256))

    def observe(self, value: float) -> None:
        self.count += 1
        self.total += value
        self.maximum = max(self.maximum, value)
        self.recent.append(value)

    def snapshot(self) -> dict[str, float]:
        values = sorted(self.recent)
        if not values:
            return {"count": 0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0}

        def pct(p: float) -> float:
            return values[min(len(values) - 1, int(p * (len(values) - 1) + 0.5))]

        return {
            "count": self.count,
            "mean": round(self.total / self.count, 2),
            "p50": round(pct(0.5), 2),
            "p95": round(pct(0.95), 2),
            "max": round(self.maximum, 2),
        }


class Metrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: dict[str, float] = defaultdict(float)
        self._summaries: dict[str, _Summary] = defaultdict(_Summary)
        self.started_at = utcnow()

    def inc(self, name: str, value: float = 1.0) -> None:
        with self._lock:
            self._counters[name] += value

    def observe(self, name: str, value: float) -> None:
        with self._lock:
            self._summaries[name].observe(value)

    def timer(self, name: str) -> _Timer:
        return _Timer(self, name)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "started_at": iso_z(self.started_at),
                "counters": dict(sorted(self._counters.items())),
                "summaries": {k: v.snapshot() for k, v in sorted(self._summaries.items())},
            }


class _Timer:
    def __init__(self, metrics: Metrics, name: str) -> None:
        self.metrics = metrics
        self.name = name
        self.elapsed_ms = 0.0

    def __enter__(self) -> _Timer:
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        self.elapsed_ms = (time.perf_counter() - self._t0) * 1000.0
        self.metrics.observe(self.name, self.elapsed_ms)


metrics = Metrics()


class RingBufferHandler(logging.Handler):
    def __init__(self, capacity: int = 1000) -> None:
        super().__init__()
        self.records: deque[dict[str, Any]] = deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.records.append(
                {
                    "at": iso_z(utcnow()),
                    "level": record.levelname,
                    "logger": record.name,
                    "message": record.getMessage(),
                }
            )
        except Exception:  # never let logging break the engine
            self.handleError(record)


log_buffer = RingBufferHandler()


def configure_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger("atlas")
    if getattr(root, "_atlas_configured", False):
        return
    root.setLevel(level)
    stream = logging.StreamHandler()
    stream.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s · %(message)s", "%H:%M:%S"))
    root.addHandler(stream)
    root.addHandler(log_buffer)
    root.propagate = False
    root._atlas_configured = True  # type: ignore[attr-defined]
