"""Runtime configuration.

Every setting can be overridden with an ``ATLAS_`` prefixed environment variable or a
``.env`` file at the repository root. Optional third-party credentials are never required:
each connector that needs one degrades to a clearly reported ``disabled`` state.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    return Path.home() / ".atlas"


REPO_ROOT = _repo_root()


class PerformanceProfile(StrEnum):
    ECO = "eco"
    BALANCED = "balanced"
    PERFORMANCE = "performance"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="ATLAS_",
        env_file=(REPO_ROOT / ".env",),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Field(default=REPO_ROOT / "data" / "runtime")
    registry_path: Path = Field(default=REPO_ROOT / "data" / "registry" / "sources.json")
    demo_dir: Path = Field(default=REPO_ROOT / "data" / "demo")
    docs_dir: Path = Field(default=REPO_ROOT / "docs")

    host: str = "127.0.0.1"
    port: int = 8787
    cors_origins: list[str] = Field(default=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"])

    # Ingestion
    scheduler_enabled: bool = True
    profile: PerformanceProfile = PerformanceProfile.BALANCED
    fire_window_hours: int = 48
    http_timeout_s: float = 30.0
    http_max_bytes: int = 64 * 1024 * 1024

    # Optional credentials — all optional, all free to obtain, none required.
    firms_map_key: SecretStr | None = None
    reliefweb_appname: str | None = None
    openaq_api_key: SecretStr | None = None
    # HDX HAPI app identifier (base64 of "app name:email", generated free by HDX)
    hdx_app_identifier: SecretStr | None = None

    # Local AI (Phase 4): an Ollama server on this machine. Loopback addresses only.
    ai_base_url: str = "http://127.0.0.1:11434"
    ai_model: str | None = None

    # Disable network entirely (offline mode): connectors serve cached data only.
    offline: bool = False
    # Compute Sentinel-2 burn-scar maps for the largest active wildfires every 6 h (a few per run).
    auto_burn_scars: bool = True

    # Set by the desktop app's entry point: enables Settings (API keys, data packs) in the API.
    desktop: bool = False

    @property
    def db_path(self) -> Path:
        return self.data_dir / "atlas.duckdb"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def packs_dir(self) -> Path:
        return self.data_dir / "packs"

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.cache_dir / "http", self.packs_dir):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    return settings
