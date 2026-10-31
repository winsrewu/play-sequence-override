from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_JWKS_URL = "https://api.jawbts.org/.well-known/jwks.json"
DEFAULT_ISSUER = "jawbts-api"
DEFAULT_SCOPE = "play_sequence_override"


class ConfigError(RuntimeError):
    pass


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    lowered = raw.lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be a boolean, got {raw!r}")


def _env_list(name: str) -> tuple[str, ...]:
    raw = _env(name)
    if raw is None:
        return ()
    return tuple(part.strip() for part in raw.split(",") if part.strip())


@dataclass(frozen=True)
class Settings:
    jwks_url: str = DEFAULT_JWKS_URL
    jwt_issuer: str = DEFAULT_ISSUER
    required_scope: str = DEFAULT_SCOPE
    jwt_leeway_seconds: int = 30
    jwks_cache_seconds: int = 300
    jwks_timeout_seconds: int = 15
    allow_insecure_jwks: bool = False
    # Local-development only: skip bearer/JWKS verification. Never enable this
    dev_mode: bool = False

    catalog_path: Path | None = None
    catalog_strict: bool = False

    model_path: Path = Path("/app/assets/mn10_as_mAP_471.pt")
    efficientat_path: Path = Path("/app/vendor/EfficientAT")
    device: str = "cpu"
    torch_threads: int = 4
    max_duration_seconds: int = 900

    ffmpeg_bin: str = "ffmpeg"
    http_timeout_seconds: int = 30
    download_timeout_seconds: int = 120
    max_audio_bytes: int = 128 * 1024 * 1024
    bilibili_user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0"
    )
    trust_env_proxy: bool = False

    cors_allow_origins: tuple[str, ...] = ()
    log_level: str = "info"
    max_request_bytes: int = 16 * 1024

    model_name: str = "mn10_as"
    embedding_dim: int = 960
    service_name: str = "jawbts-embed"
    version: str = "0.1.0"

    def validate(self) -> None:
        if not self.dev_mode:
            parts = urlsplit(self.jwks_url)
            if parts.scheme not in {"https", "http"}:
                raise ConfigError("JWKS_URL must use https: or http:")
            if parts.scheme == "http" and not self.allow_insecure_jwks:
                raise ConfigError(
                    "JWKS_URL must use https: (set ALLOW_INSECURE_JWKS=true only for local tests)"
                )
            if parts.username or parts.password:
                raise ConfigError("JWKS_URL must not contain embedded credentials")
            if not parts.hostname:
                raise ConfigError("JWKS_URL must include a hostname")
        if not self.required_scope:
            raise ConfigError("REQUIRED_SCOPE must not be empty")
        if not self.model_path.is_file():
            raise ConfigError(f"MODEL_PATH does not exist: {self.model_path}")
        if not self.efficientat_path.is_dir():
            raise ConfigError(f"EFFICIENTAT_PATH does not exist: {self.efficientat_path}")
        if self.device not in {"cpu", "cuda"}:
            raise ConfigError("DEVICE must be cpu or cuda")


def load_settings() -> Settings:
    catalog_raw = _env("CATALOG_PATH")
    settings = Settings(
        jwks_url=_env("JWKS_URL", DEFAULT_JWKS_URL) or DEFAULT_JWKS_URL,
        jwt_issuer=_env("JWT_ISSUER", DEFAULT_ISSUER) or DEFAULT_ISSUER,
        required_scope=_env("REQUIRED_SCOPE", DEFAULT_SCOPE) or DEFAULT_SCOPE,
        jwt_leeway_seconds=_env_int(
            "JWT_LEEWAY_SECONDS", 30, minimum=0, maximum=600
        ),
        jwks_cache_seconds=_env_int(
            "JWKS_CACHE_SECONDS", 300, minimum=0, maximum=86400
        ),
        jwks_timeout_seconds=_env_int(
            "JWKS_TIMEOUT_SECONDS", 15, minimum=1, maximum=120
        ),
        allow_insecure_jwks=_env_bool("ALLOW_INSECURE_JWKS", False),
        dev_mode=_env_bool("DEV_MODE", False),
        catalog_path=Path(catalog_raw) if catalog_raw else None,
        catalog_strict=_env_bool("CATALOG_STRICT", False),
        model_path=Path(_env("MODEL_PATH", "/app/assets/mn10_as_mAP_471.pt")),
        efficientat_path=Path(_env("EFFICIENTAT_PATH", "/app/vendor/EfficientAT")),
        device=(_env("DEVICE", "cpu") or "cpu").lower(),
        torch_threads=_env_int("TORCH_THREADS", 4, minimum=1, maximum=64),
        max_duration_seconds=_env_int(
            "MAX_DURATION_SECONDS", 900, minimum=1, maximum=3600
        ),
        ffmpeg_bin=_env("FFMPEG_BIN", "ffmpeg") or "ffmpeg",
        http_timeout_seconds=_env_int(
            "HTTP_TIMEOUT_SECONDS", 30, minimum=1, maximum=300
        ),
        download_timeout_seconds=_env_int(
            "DOWNLOAD_TIMEOUT_SECONDS", 120, minimum=1, maximum=900
        ),
        max_audio_bytes=_env_int(
            "MAX_AUDIO_BYTES", 128 * 1024 * 1024, minimum=1024, maximum=1024**3
        ),
        bilibili_user_agent=_env("BILIBILI_USER_AGENT")
        or Settings.bilibili_user_agent,
        trust_env_proxy=_env_bool("TRUST_ENV_PROXY", False),
        cors_allow_origins=_env_list("CORS_ALLOW_ORIGINS"),
        log_level=(_env("LOG_LEVEL", "info") or "info").lower(),
        max_request_bytes=_env_int(
            "MAX_REQUEST_BYTES", 16 * 1024, minimum=256, maximum=1024**2
        ),
        model_name=_env("MODEL_NAME", "mn10_as") or "mn10_as",
        embedding_dim=_env_int("EMBEDDING_DIM", 960, minimum=1, maximum=100000),
        service_name=_env("SERVICE_NAME", "jawbts-embed") or "jawbts-embed",
        version=_env("SERVICE_VERSION", "0.1.0") or "0.1.0",
    )
    settings.validate()
    return settings
