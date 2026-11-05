# POST /v1/embed (single) and /v1/embeddings (batch). No database; vectors are cached
# in-process for a bounded TTL and temporary audio is deleted.
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
from .cache import VectorCache
from .jobs import EmbeddingJobs
from .config import Settings, load_settings
from .embedder import Embedder, Embedding
from .errors import (
    ApiError,
    AuthUnavailable,
    InsufficientScope,
    InvalidRequest,
    TokenExpired,
    TokenInvalid,
    UnknownInternalId,
    UpstreamError,
    VideoUnavailable,
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


class BatchEmbedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    internal_ids: list[str] = Field(
        min_length=1,
        max_length=15,
        description="Up to 15 canonical internal ids; only ready ones are returned",
        examples=[["BBV16y4y127Dz"]],
    )


class BatchEmbedItem(BaseModel):
    internal_id: str
    model: str
    dim: int
    embedding: list[float]


class BatchEmbedFailure(BaseModel):
    internal_id: str
    code: str
    message: str


class BatchEmbedResponse(BaseModel):
    model: str
    embeddings: list[BatchEmbedItem]
    failures: list[BatchEmbedFailure]
    pending: list[str]


@dataclass
class Runtime:
    settings: Settings
    verifier: JWTVerifier
    embedder: Embedder
    bilibili: BilibiliClient
    catalog: "Catalog"
    cache: VectorCache
    jobs: EmbeddingJobs | None = None


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


@dataclass
class EmbedResult:
    embedding: Embedding
    downloaded: Any
    decoded_seconds: float


def _embed_target(runtime: "Runtime", target: Any) -> EmbedResult:
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
            downloaded = runtime.bilibili.download(source, raw_path, force_full=True)
            decode_to_wav(
                raw_path,
                wav_path,
                ffmpeg_bin=runtime.settings.ffmpeg_bin,
                max_duration_seconds=runtime.settings.max_duration_seconds,
            )
            decoded_seconds = wav_duration_seconds(wav_path)
        embedding = runtime.embedder.embed_wav(wav_path)
        return EmbedResult(
            embedding=embedding,
            downloaded=downloaded,
            decoded_seconds=decoded_seconds,
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _embed_and_cache(runtime: "Runtime", target: Any) -> EmbedResult:
    result = _embed_target(runtime, target)
    if runtime.jobs is not None:
        runtime.jobs.clear_failure(target.value)
    runtime.cache.put(
        target.value,
        result.embedding.vector,
        model=result.embedding.model,
        audio_bytes=result.downloaded.bytes_written,
        audio_partial=result.downloaded.partial,
        audio_duration=result.decoded_seconds,
    )
    return result


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
        cache = VectorCache(
            resolved.vector_cache_ttl_seconds, resolved.vector_cache_max_entries
        )
        runtime = Runtime(
            settings=resolved,
            verifier=verifier,
            embedder=embedder,
            bilibili=bilibili,
            catalog=catalog,
            cache=cache,
        )
        runtime.jobs = EmbeddingJobs(
            resolved.embed_workers,
            resolved.embed_max_pending,
            lambda target: _embed_and_cache(runtime, target),
            failure_backoff_seconds=resolved.embed_failure_backoff_seconds,
            unavailable_ttl_seconds=resolved.embed_unavailable_ttl_seconds,
        )
        app.state.runtime = runtime
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
            if runtime.jobs is not None:
                runtime.jobs.shutdown()
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
        if request.method == "POST" and request.url.path in {"/v1/embed", "/v1/embeddings"}:
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
        if request.url.path in {"/v1/embed", "/v1/embeddings"}:
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

        cached = runtime.cache.get(target.value)
        if cached is not None:
            embedding = Embedding(
                vector=[float(value) for value in cached.values],
                dim=len(cached.values),
                model=cached.model,
            )
            audio_bytes = cached.audio_bytes
            audio_partial = cached.audio_partial
            decoded_seconds = cached.audio_duration
            hit = True
        else:
            failure = (
                runtime.jobs.failure(target.value) if runtime.jobs is not None else None
            )
            if failure is not None:
                if failure.code == "video_unavailable":
                    raise VideoUnavailable(failure.message)
                raise UpstreamError(failure.message)
            result = _embed_and_cache(runtime, target)
            embedding = result.embedding
            audio_bytes = result.downloaded.bytes_written
            audio_partial = result.downloaded.partial
            decoded_seconds = result.decoded_seconds
            hit = False

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
                "X-Embedding-Cached": "true" if hit else "false",
                "X-Dev-Mode": "true" if runtime.settings.dev_mode else "false",
                "X-Audio-Bytes": str(audio_bytes),
                "X-Audio-Partial": "true" if audio_partial else "false",
                "X-Audio-Duration": f"{decoded_seconds:.1f}",
                "Vary": "Authorization",
            },
        )

    @app.post(
        "/v1/embeddings",
        response_model=BatchEmbedResponse,
        response_model_exclude_none=True,
        summary="Return ready embeddings for up to 15 catalog tracks and queue the rest",
    )
    def embed_batch(
        payload: BatchEmbedRequest,
        request: Request,
        auth: AuthContext = Depends(require_auth),
    ) -> JSONResponse:
        runtime = _runtime(request)
        targets: list[Any] = []
        seen: set[str] = set()
        for raw in payload.internal_ids:
            target = parse_target(raw)
            runtime.catalog.require(target.value)
            if target.value in seen:
                continue
            seen.add(target.value)
            targets.append(target)
        if not targets:
            raise InvalidRequest("internal_ids must contain at least one id")

        ready: list[BatchEmbedItem] = []
        failures: list[BatchEmbedFailure] = []
        pending: list[Any] = []
        for target in targets:
            cached = runtime.cache.get(target.value)
            if cached is not None:
                ready.append(
                    BatchEmbedItem(
                        internal_id=target.value,
                        model=cached.model,
                        dim=len(cached.values),
                        embedding=[float(value) for value in cached.values],
                    )
                )
                continue
            failure = runtime.jobs.failure(target.value) if runtime.jobs is not None else None
            if failure is not None:
                failures.append(
                    BatchEmbedFailure(
                        internal_id=target.value,
                        code=failure.code,
                        message=failure.message,
                    )
                )
                continue
            pending.append(target)
            continue
        if pending and runtime.jobs is not None:
            runtime.jobs.submit(pending)

        body = BatchEmbedResponse(
            model=runtime.settings.model_name,
            embeddings=ready,
            failures=failures,
            pending=[target.value for target in pending],
        )
        return JSONResponse(
            body.model_dump(),
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Embedding-Model": runtime.settings.model_name,
                "X-Embedding-Pending": str(len(pending)),
                "X-Dev-Mode": "true" if runtime.settings.dev_mode else "false",
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
