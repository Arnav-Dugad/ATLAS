"""Embedded DuckDB store.

DuckDB is a single-writer engine. ATLAS runs ingestion and the API in one process, so a
process-wide write lock serialises writers while readers get independent cursors and run
concurrently. Spatial and H3 extensions are loaded when available (installed during setup
and cached locally, so they keep working offline).
"""

from __future__ import annotations

import importlib.abc
import importlib.util
import logging
import re
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from importlib import resources
from pathlib import Path

import duckdb

log = logging.getLogger("atlas.store")


class _AbsentModuleFinder(importlib.abc.MetaPathFinder):
    """Fail imports of known-absent optional modules in O(1).

    DuckDB's Python binding probes ``import pandas`` several times per executed statement.
    When pandas is not installed every failed probe walks sys.path (~0.6 ms each), which
    dominated ingest time (measured: 22 s of 24 s for 319 observations). A sys.modules
    ``None`` sentinel is not usable because pyarrow reads sys.modules["pandas"] directly.
    """

    def __init__(self, names: frozenset[str]) -> None:
        self.names = names

    def find_spec(self, fullname: str, path: object = None, target: object = None) -> None:
        if fullname in self.names:
            raise ModuleNotFoundError(f"No module named {fullname!r}", name=fullname)


if importlib.util.find_spec("pandas") is None and not any(isinstance(f, _AbsentModuleFinder) for f in sys.meta_path):
    sys.meta_path.insert(0, _AbsentModuleFinder(frozenset({"pandas"})))

_MIGRATION_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")


class Database:
    def __init__(self, path: Path | str, *, read_only: bool = False) -> None:
        self.path = str(path)
        self._conn = duckdb.connect(self.path, read_only=read_only)
        self._write_lock = threading.RLock()
        self.extensions: dict[str, bool] = {}
        self._load_extensions()

    def _load_extensions(self) -> None:
        for name, install in (("spatial", "INSTALL spatial"), ("h3", "INSTALL h3 FROM community")):
            try:
                try:
                    self._conn.execute(f"LOAD {name}")
                except duckdb.Error:
                    self._conn.execute(install)
                    self._conn.execute(f"LOAD {name}")
                self.extensions[name] = True
            except duckdb.Error as exc:
                log.warning("DuckDB extension %s unavailable: %s", name, exc)
                self.extensions[name] = False

    def cursor(self) -> duckdb.DuckDBPyConnection:
        cur = self._conn.cursor()
        for name, ok in self.extensions.items():
            if ok:
                cur.execute(f"LOAD {name}")
        return cur

    @contextmanager
    def read(self) -> Iterator[duckdb.DuckDBPyConnection]:
        cur = self.cursor()
        try:
            yield cur
        finally:
            cur.close()

    @contextmanager
    def write(self) -> Iterator[duckdb.DuckDBPyConnection]:
        with self._write_lock:
            cur = self.cursor()
            cur.execute("BEGIN TRANSACTION")
            try:
                yield cur
                cur.execute("COMMIT")
            except duckdb.FatalException:
                # A FATAL error invalidates the whole database instance. Reopen it so the
                # engine keeps serving (the failed transaction is discarded by the WAL).
                log.critical("DuckDB fatal error; reopening database", exc_info=True)
                self._reopen()
                raise
            except BaseException:
                try:
                    cur.execute("ROLLBACK")
                except duckdb.Error:
                    pass
                raise
            finally:
                try:
                    cur.close()
                except duckdb.Error:
                    pass

    def _reopen(self) -> None:
        try:
            self._conn.close()
        except duckdb.Error:
            pass
        self._conn = duckdb.connect(self.path)
        self._load_extensions()

    def migrate(self) -> list[str]:
        applied: list[str] = []
        with self._write_lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR PRIMARY KEY, applied_at TIMESTAMP DEFAULT now())"
            )
            done = {r[0] for r in self._conn.execute("SELECT version FROM schema_migrations").fetchall()}
            files = sorted(
                (f for f in resources.files("atlas.store.migrations").iterdir() if _MIGRATION_RE.match(f.name)),
                key=lambda f: f.name,
            )
            for f in files:
                version = f.name.split("_", 1)[0]
                if version in done:
                    continue
                sql = f.read_text("utf-8")
                self._conn.execute("BEGIN TRANSACTION")
                try:
                    self._conn.execute(sql)
                    self._conn.execute("INSERT INTO schema_migrations (version) VALUES (?)", [version])
                    self._conn.execute("COMMIT")
                except BaseException:
                    self._conn.execute("ROLLBACK")
                    raise
                applied.append(f.name)
                log.info("applied migration %s", f.name)
        return applied

    def size_bytes(self) -> int:
        p = Path(self.path)
        if not p.exists():
            return 0
        wal = p.with_suffix(p.suffix + ".wal")
        return p.stat().st_size + (wal.stat().st_size if wal.exists() else 0)

    def checkpoint(self) -> None:
        with self._write_lock:
            self._conn.execute("CHECKPOINT")

    def close(self) -> None:
        self._conn.close()
