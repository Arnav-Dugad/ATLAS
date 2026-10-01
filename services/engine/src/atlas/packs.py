"""Data packs: versioned, checksummed local datasets.

Packs keep the default install small (the Core Pack is ~11 MB) while allowing large
optional datasets (population rasters, regional infrastructure) to be added explicitly.
Every installed pack writes a manifest recording source URLs, sizes, SHA-256 checksums,
licence and install time, which the Storage view reads.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from atlas.http.client import HttpClient
from atlas.util.timeutil import iso_z, utcnow

log = logging.getLogger("atlas.packs")

NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"


@dataclass
class PackFile:
    url: str
    name: str
    max_bytes: int
    extract: str | None = None  # member glob to extract from a zip


@dataclass
class PackSpec:
    id: str
    title: str
    description: str
    source_ids: list[str]
    license: str
    approx_size_mb: float
    files: list[PackFile] = field(default_factory=list)
    optional: bool = True


PACKS: dict[str, PackSpec] = {
    "core": PackSpec(
        id="core",
        title="Core Pack",
        description="Natural Earth countries (1:50m, 1:110m), admin-1 regions (1:50m) and 7,300 populated places "
        "for offline reverse geocoding, gazetteer search and boundaries.",
        source_ids=["natural-earth"],
        license="Public domain",
        approx_size_mb=11.2,
        optional=False,
        files=[
            PackFile(NE_BASE + "ne_50m_admin_0_countries.geojson", "countries_50m.geojson", 8 << 20),
            PackFile(NE_BASE + "ne_110m_admin_0_countries.geojson", "countries_110m.geojson", 4 << 20),
            PackFile(NE_BASE + "ne_10m_populated_places_simple.geojson", "places.geojson", 12 << 20),
            PackFile(NE_BASE + "ne_50m_admin_1_states_provinces.geojson", "admin1_50m.geojson", 8 << 20),
        ],
    ),
    "population-ghsl": PackSpec(
        id="population-ghsl",
        title="Population Pack — GHSL 2025 (30″)",
        description="Global residential population grid (~1 km) used for exposure estimates.",
        source_ids=["ghsl-pop"],
        license="CC BY 4.0",
        approx_size_mb=484.0,
        files=[
            PackFile(
                "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/"
                "GHS_POP_E2025_GLOBE_R2023A_4326_30ss/V1-0/GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0.zip",
                "ghs_pop_2025_30ss.zip",
                600 << 20,
                extract="*.tif",
            )
        ],
    ),
}


class PackManager:
    def __init__(self, root: Path, http: HttpClient | None = None) -> None:
        self.root = root
        self.http = http
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, pack_id: str) -> Path:
        return self.root / pack_id

    def manifest(self, pack_id: str) -> dict[str, Any] | None:
        m = self.path(pack_id) / "manifest.json"
        if not m.exists():
            return None
        try:
            data: dict[str, Any] = json.loads(m.read_text("utf-8"))
        except ValueError:
            return None
        return data

    def installed(self, pack_id: str) -> bool:
        return self.manifest(pack_id) is not None

    def file(self, pack_id: str, name: str) -> Path | None:
        p = self.path(pack_id) / name
        return p if p.exists() else None

    def status(self) -> list[dict[str, Any]]:
        out = []
        for spec in PACKS.values():
            man = self.manifest(spec.id)
            size = sum(f.stat().st_size for f in self.path(spec.id).rglob("*") if f.is_file()) if man else 0
            out.append(
                {
                    "id": spec.id,
                    "title": spec.title,
                    "description": spec.description,
                    "license": spec.license,
                    "sources": spec.source_ids,
                    "optional": spec.optional,
                    "approx_size_mb": spec.approx_size_mb,
                    "installed": man is not None,
                    "installed_at": (man or {}).get("installed_at"),
                    "size_bytes": size,
                }
            )
        return out

    async def install(self, pack_id: str, *, force: bool = False) -> dict[str, Any]:
        if self.http is None:
            raise RuntimeError("pack installation requires an HTTP client")
        spec = PACKS[pack_id]
        if self.installed(pack_id) and not force:
            return self.manifest(pack_id) or {}
        target = self.path(pack_id)
        staging = self.root / f".{pack_id}.staging"
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        files: list[dict[str, Any]] = []
        for pf in spec.files:
            log.info("pack %s: downloading %s", pack_id, pf.url)
            dest = staging / pf.name
            last_log = [0.0]

            def report(done: int, expected: int | None, name: str = pf.name, last_log: list[float] = last_log) -> None:
                if expected and done - last_log[0] >= expected / 10:
                    last_log[0] = done
                    log.info("pack %s: %s %.0f%%", pack_id, name, 100 * done / expected)

            size, digest = await self.http.download(pf.url, dest, max_bytes=pf.max_bytes, progress=report)
            entry = {"name": pf.name, "url": pf.url, "bytes": size, "sha256": digest}
            if pf.extract:
                entry["extracted"] = _safe_extract(dest, staging, pf.extract)
                dest.unlink()
            files.append(entry)
        manifest = {
            "id": spec.id,
            "title": spec.title,
            "license": spec.license,
            "sources": spec.source_ids,
            "installed_at": iso_z(utcnow()),
            "files": files,
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)
        return manifest

    def remove(self, pack_id: str) -> bool:
        spec = PACKS.get(pack_id)
        if spec is None or not spec.optional:
            return False
        target = self.path(pack_id)
        if target.exists():
            shutil.rmtree(target)
            return True
        return False


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


MAX_EXTRACT_BYTES = 8 << 30  # 8 GiB ceiling: archive-bomb protection
MAX_RATIO = 200  # reject members compressing better than 200:1


def _safe_extract(archive: Path, dest: Path, pattern: str) -> list[str]:
    """Extract matching members with path-traversal and decompression-bomb guards."""
    extracted: list[str] = []
    total = 0
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            name = PurePosixPath(info.filename)
            if info.is_dir() or not name.match(pattern):
                continue
            if name.is_absolute() or ".." in name.parts:
                raise ValueError(f"unsafe path in archive: {info.filename}")
            if info.compress_size and info.file_size / max(info.compress_size, 1) > MAX_RATIO:
                raise ValueError(f"suspicious compression ratio for {info.filename}")
            total += info.file_size
            if total > MAX_EXTRACT_BYTES:
                raise ValueError("archive exceeds extraction size limit")
            out = dest / name.name  # flatten: never honour archive directories
            with zf.open(info) as src, out.open("wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            extracted.append(name.name)
    return extracted
