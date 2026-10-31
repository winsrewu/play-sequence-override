# POST /v1/embed is the only business route. No database or application cache; temporary audio is deleted.
from __future__ import annotations

import logging
import os
import shutil
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .auth import AuthContext, JWTVerifier, bearer_token
from .bilibili import BilibiliClient, decode_to_wav, parse_target, wav_duration_seconds
from .config import Settings, load_settings
from .embedder import Embedder
from .errors import (
    ApiError,
    AuthUnavailable,
    InsufficientScope,
    InvalidRequest,
    TokenExpired,
    TokenInvalid,
    UnknownInternalId,
)
from .playlist import Playlist, PlaylistError, load_playlist

LOGGER = logging.getLogger(__name__)


class EmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    internal_id: str = Field(
        min_length=3,
        max_length=32,
        description="Canonical internal id, e.g. BBV16y4y127Dz",
        examples=["BBV16y4y127Dz"],
    )


class EmbedResponse(BaseModel):
    internal_id: str
    model: str
    dim: int
    embedding: list[float]


@dataclass
class Runtime:
    settings: Settings
    verifier: JWTVerifier
    embedder: Embedder
    bilibili: BilibiliClient
    catalog: "Catalog"


class Catalog:

    def __init__(self, path: Path | None, strict: bool) -> None:
        self.path = path
        self.strict = strict
        self._playlist: Playlist | None = None
        self._ids: set[str] = set()
        if path is None:
            if strict:
                raise RuntimeError("CATALOG_STRICT requires CATALOG_PATH")
            LOGGER.info("no CATALOG_PATH set; internal-id membership is not enforced")
            return
        if not path.is_file():
            if strict:
                raise FileNotFoundError(f"CATALOG_PATH does not exist: {path}")
            LOGGER.warning("CATALOG_PATH does not exist (%s); membership not enforced", path)
            return
        try:
            self._playlist = load_playlist(path)
        except PlaylistError as exc:
            raise RuntimeError(f"cannot load CATALOG_PATH {path}: {exc}") from exc
        self._ids = self._playlist.ids()
        LOGGER.info("loaded %d catalog tracks from %s", len(self._ids), path)

    def __len__(self) -> int:
        return len(self._ids)

    def __contains__(self, internal_id: str) -> bool:
        return internal_id in self._ids

    def require(self, internal_id: str) -> None:
        if self.strict and internal_id not in self._ids:
            raise UnknownInternalId(
                f"internal id {internal_id!r} is not in the configured catalog"
            )


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _runtime(request: Request) -> Runtime:
    runtime = getattr(request.app.state, "runtime", None)
    if runtime is None:  # pragma: no cover - lifespan always runs in practice
        raise RuntimeError("application runtime is not initialized")
    return runtime


def require_auth(request: Request) -> AuthContext:
    runtime = _runtime(request)
    if runtime.settings.dev_mode:
        # Explicit local-development escape hatch. Never enable this on a
        return AuthContext(
            subject="local-dev",
            scope=(runtime.settings.required_scope,),
            claims={"dev_mode": True},
        )
    token = bearer_token(request.headers.get("authorization"))
    try:
        return runtime.verifier.verify(token)
    except (TokenExpired, TokenInvalid, InsufficientScope, AuthUnavailable, ApiError):
        raise
    except Exception as exc:  # pragma: no cover - fail closed
        LOGGER.exception("unexpected authentication failure")
        raise TokenInvalid("token verification failed") from exc


def _error_response(error: ApiError) -> JSONResponse:
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    if error.status == 401:
        headers["WWW-Authenticate"] = "Bearer"
    return JSONResponse(error.to_dict(), status_code=error.status, headers=headers)


def _env_cors_origins() -> tuple[str, ...]:
    raw = os.environ.get("CORS_ALLOW_ORIGINS", "")
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def create_app(
    *,
    settings: Settings | None = None,
    settings_loader: Callable[[], Settings] = load_settings,
    embedder_factory: Callable[[Settings], Embedder] = Embedder,
    bilibili_factory: Callable[[Settings], BilibiliClient] = BilibiliClient,
    verifier_factory: Callable[[Settings], JWTVerifier] = JWTVerifier,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> Iterator[None]:
        resolved = settings if settings is not None else settings_loader()
        _configure_logging(resolved.log_level)
        verifier = verifier_factory(resolved)
        embedder = embedder_factory(resolved)
        bilibili = bilibili_factory(resolved)
        catalog = Catalog(resolved.catalog_path, resolved.catalog_strict)
        app.state.runtime = Runtime(
            settings=resolved,
            verifier=verifier,
            embedder=embedder,
            bilibili=bilibili,
            catalog=catalog,
        )
        if resolved.dev_mode:
            LOGGER.warning(
                "DEV_MODE is enabled: bearer/JWKS auth is bypassed. "
                "Bind the service to loopback and do not expose it."
            )
        LOGGER.info(
            "ready: issuer=%s scope=%s jwks=%s catalog=%d",
            resolved.jwt_issuer,
            resolved.required_scope,
            resolved.jwks_url,
            len(catalog),
        )
        try:
            yield
        finally:
            bilibili.close()
            app.state.runtime = None

    app = FastAPI(
        title="Jawbts embedding service",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.exception_handler(ApiError)
    async def api_error_handler(_request: Request, error: ApiError) -> JSONResponse:
        if error.status >= 500:
            LOGGER.error("%s: %s", error.code, error.message)
        return _error_response(error)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        _request: Request, error: RequestValidationError
    ) -> JSONResponse:
        details = []
        for item in error.errors():
            location = ".".join(str(part) for part in item.get("loc", ()))
            details.append(f"{location}: {item.get('msg', 'invalid value')}")
        return _error_response(
            InvalidRequest("; ".join(details) or "request body is invalid")
        )

    @app.middleware("http")
    async def guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        if request.method == "POST" and request.url.path == "/v1/embed":
            runtime = getattr(request.app.state, "runtime", None)
            limit = runtime.settings.max_request_bytes if runtime else 16 * 1024
            declared = request.headers.get("content-length")
            if declared is not None:
                if not declared.isdigit():
                    return _error_response(InvalidRequest("invalid Content-Length"))
                if int(declared) > limit:
                    return _error_response(
                        InvalidRequest(f"request body exceeds {limit} bytes")
                    )
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path == "/v1/embed":
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.post(
        "/v1/embed",
        response_model=EmbedResponse,
        response_model_exclude_none=True,
        summary="Embed one catalog track",
    )
    def embed(
        payload: EmbedRequest,
        request: Request,
        auth: AuthContext = Depends(require_auth),
    ) -> JSONResponse:
        runtime = _runtime(request)
        target = parse_target(payload.internal_id)
        runtime.catalog.require(target.value)

        workdir = tempfile.mkdtemp(prefix="jawbts-embed-")
        try:
            raw_path = Path(workdir) / "audio.bin"
            wav_path = Path(workdir) / "audio.wav"
            source = runtime.bilibili.resolve(target)
            downloaded = runtime.bilibili.download(source, raw_path)
            decode_to_wav(
                raw_path,
                wav_path,
                ffmpeg_bin=runtime.settings.ffmpeg_bin,
                max_duration_seconds=runtime.settings.max_duration_seconds,
            )
            decoded_seconds = wav_duration_seconds(wav_path)
            needed_seconds = float(runtime.settings.max_duration_seconds)
            if source.duration_seconds:
                needed_seconds = min(needed_seconds, source.duration_seconds)
            if (
                downloaded.partial
                and source.duration_seconds
                and source.duration_seconds > runtime.settings.max_duration_seconds
                and decoded_seconds + 2.0 < needed_seconds
            ):
                LOGGER.info(
                    "partial range for %s decoded %.1fs of %.1fs; refetching full",
                    target.value,
                    decoded_seconds,
                    needed_seconds,
                )
                downloaded = runtime.bilibili.download(
                    source, raw_path, force_full=True
                )
                decode_to_wav(
                    raw_path,
                    wav_path,
                    ffmpeg_bin=runtime.settings.ffmpeg_bin,
                    max_duration_seconds=runtime.settings.max_duration_seconds,
                )
                decoded_seconds = wav_duration_seconds(wav_path)
            embedding = runtime.embedder.embed_wav(wav_path)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

        body = EmbedResponse(
            internal_id=target.value,
            model=embedding.model,
            dim=embedding.dim,
            embedding=embedding.vector,
        )
        return JSONResponse(
            body.model_dump(),
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Embedding-Model": embedding.model,
                "X-Dev-Mode": "true" if runtime.settings.dev_mode else "false",
                "X-Audio-Bytes": str(downloaded.bytes_written),
                "X-Audio-Partial": "true" if downloaded.partial else "false",
                "X-Audio-Duration": f"{decoded_seconds:.1f}",
                "Vary": "Authorization",
            },
        )

    cors_origins = settings.cors_allow_origins if settings else _env_cors_origins()
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cors_origins),
            allow_methods=["POST", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
            max_age=600,
        )

    return app


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, workers=1)
