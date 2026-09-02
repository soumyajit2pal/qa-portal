"""Spring-style environment profiles for the QualityOps backend.

Configuration precedence, from highest to lowest, is:

1. Variables already present in the process environment.
2. ``backend/.env.<APP_ENV>`` (or the repository-root profile file when the
   backend-specific file does not exist).
3. ``backend/.env``.
4. Typed defaults declared by :class:`Settings`.

Docker Compose supplies the selected environment as real process variables,
so the same settings object works for containers and direct Uvicorn/Alembic
runs without environment-specific application code.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import MutableMapping

from dotenv import dotenv_values
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = "dev"
_PROFILE_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def _validated_profile(value: str | None) -> str:
    profile = (value or DEFAULT_PROFILE).strip().lower()
    if not _PROFILE_PATTERN.fullmatch(profile):
        raise RuntimeError(
            "APP_ENV may contain only letters, numbers, underscores, and hyphens."
        )
    return profile


def load_environment(
    *,
    backend_dir: Path = BACKEND_DIR,
    environ: MutableMapping[str, str] = os.environ,
) -> tuple[str, tuple[Path, ...]]:
    """Load the base and active-profile dotenv files without overriding OS env.

    The optional parameters keep the loader straightforward to test. Returned
    paths are the files that actually existed and were considered.
    """
    base_file = backend_dir / ".env"
    base_values = dotenv_values(base_file) if base_file.is_file() else {}
    profile = _validated_profile(environ.get("APP_ENV") or base_values.get("APP_ENV"))
    backend_profile_file = backend_dir / f".env.{profile}"
    root_profile_file = backend_dir.parent / f".env.{profile}"
    profile_file = (
        backend_profile_file
        if backend_profile_file.is_file() or not root_profile_file.is_file()
        else root_profile_file
    )
    profile_values = dotenv_values(profile_file) if profile_file.is_file() else {}

    # Capture genuine process variables before loading either file. This lets
    # profile values override the base file while preserving deployment-level
    # environment overrides.
    process_keys = set(environ)
    merged = {**base_values, **profile_values, "APP_ENV": profile}
    for key, value in merged.items():
        if key not in process_keys and value is not None:
            environ[key] = value

    loaded = tuple(path for path in (base_file, profile_file) if path.is_file())
    return profile, loaded


ACTIVE_PROFILE, LOADED_ENV_FILES = load_environment()


class Settings(BaseSettings):
    """Typed settings shared by the main API and Document Portal service."""

    model_config = SettingsConfigDict(case_sensitive=False, extra="ignore")

    app_env: str = DEFAULT_PROFILE
    database_url: str | None = None
    secret_key: str = "change-this-secret-in-production-please"
    access_token_expire_minutes: int = 60
    upload_storage_root: str | None = None
    document_portal_storage_host_path: str | None = None
    document_portal_embedded: bool = True
    document_portal_max_file_size: int = 500 * 1024 * 1024
    document_portal_minimum_free_bytes: int = 100 * 1024 * 1024
    document_portal_upload_chunk_size: int = 1024 * 1024
    document_portal_allowed_extensions: str = ""
    document_portal_blocked_extensions: str = ".exe,.bat,.cmd,.sh,.ps1,.dll,.com,.msi,.scr"

    @field_validator("app_env")
    @classmethod
    def validate_app_env(cls, value: str) -> str:
        return _validated_profile(value)


settings = Settings()
