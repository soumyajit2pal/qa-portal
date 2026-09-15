"""Spring-style environment profiles for the QualityOps backend.

Configuration precedence, from highest to lowest, is:

1. Variables already present in the process environment.
2. ``backend/.env.<APP_ENV>`` (or the repository-root profile file when the
   backend-specific file does not exist).
3. ``backend/.env``. When it is absent, the repository-root ``.env`` may
   select ``APP_ENV`` but its container-only values are not loaded into a
   direct host process.
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
from pydantic import field_validator, model_validator
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
    # Compose reads the repository-root .env itself and exports every value to
    # its containers. A direct host process must not inherit container paths
    # such as LOG_DIR=/app/logs from that same file. It may, however, use the
    # root APP_ENV value to select the complete host-compatible profile file.
    root_selector_file = backend_dir.parent / ".env"
    root_selector_values = (
        dotenv_values(root_selector_file)
        if not base_file.is_file() and root_selector_file.is_file()
        else {}
    )
    profile = _validated_profile(
        environ.get("APP_ENV")
        or base_values.get("APP_ENV")
        or root_selector_values.get("APP_ENV")
    )
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
    secret_key: str = ""
    access_token_expire_minutes: int = 30
    session_max_minutes: int = 480
    jwt_issuer: str = "qualityops-api"
    jwt_audience: str = "qualityops-web"
    upload_storage_root: str | None = None
    document_portal_storage_host_path: str | None = None
    document_portal_embedded: bool = True
    document_portal_minimum_free_bytes: int = 100 * 1024 * 1024
    document_portal_upload_chunk_size: int = 1024 * 1024
    document_portal_allowed_extensions: str = ""
    document_portal_blocked_extensions: str = ".exe,.bat,.cmd,.sh,.ps1,.dll,.com,.msi,.scr"
    cors_allowed_origins: str = ""
    trusted_hosts: str = "localhost,127.0.0.1,backend,document_portal"
    domain_name: str = ""
    ldap_mock_enabled: bool = False
    ldap_mock_password: str = ""
    ldap_mock_username_prefix: str = "bmock"

    @field_validator("app_env")
    @classmethod
    def validate_app_env(cls, value: str) -> str:
        return _validated_profile(value)

    @model_validator(mode="after")
    def validate_security_configuration(self):
        if self.access_token_expire_minutes <= 0 or self.session_max_minutes <= 0:
            raise ValueError("Token and session durations must be positive")
        if len(self.secret_key) < 32:
            raise ValueError("SECRET_KEY must be a deployment secret of at least 32 characters")
        if self.app_env in {"uat", "prod", "production"}:
            if not self.database_url:
                raise ValueError("DATABASE_URL is required outside development")
        if self.app_env in {"prod", "production"} and self.ldap_mock_enabled:
            raise ValueError("LDAP mock authentication cannot be enabled in production")
        if self.ldap_mock_enabled:
            if len(self.ldap_mock_password) < 12:
                raise ValueError("LDAP_MOCK_PASSWORD must contain at least 12 characters")
            if not self.ldap_mock_username_prefix.strip():
                raise ValueError("LDAP_MOCK_USERNAME_PREFIX is required when LDAP mock authentication is enabled")
        return self

    @property
    def cors_origins(self) -> list[str]:
        return [item.strip().rstrip("/") for item in self.cors_allowed_origins.split(",") if item.strip()]

    @property
    def allowed_hosts(self) -> list[str]:
        hosts = [item.strip() for item in self.trusted_hosts.split(",") if item.strip()]
        if self.domain_name.strip():
            hosts.append(self.domain_name.strip())
        return list(dict.fromkeys(hosts))


settings = Settings()
