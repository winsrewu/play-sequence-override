# Bounded background embedding queue: deduplicates in-flight ids, retries after
# a short backoff, and keeps the HTTP handler non-blocking.
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Protocol

from .errors import VideoUnavailable

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingFailure:
    code: str
    message: str
    expires_at: float


class Target(Protocol):
    value: str


class EmbeddingJobs:
    def __init__(
        self,
        max_workers: int,
        max_pending: int,
        work: Callable[[Target], None],
        *,
        failure_backoff_seconds: int = 60,
        unavailable_ttl_seconds: int = 86400,
    ) -> None:
        self._pool = ThreadPoolExecutor(
            max_workers=max(1, int(max_workers)), thread_name_prefix="jawbts-embed"
        )
        self._work = work
        self._max_pending = max(1, int(max_pending))
        self._backoff = max(0.0, float(failure_backoff_seconds))
        self._unavailable_ttl = max(0.0, float(unavailable_ttl_seconds))
        self._lock = threading.Lock()
        self._inflight: set[str] = set()
        self._failed: dict[str, EmbeddingFailure] = {}

    def submit(self, targets: list[Target]) -> list[str]:
        accepted: list[str] = []
        now = time.monotonic()
        with self._lock:
            for target in targets:
                key = target.value
                if key in self._inflight:
                    continue
                failure = self._failed.get(key)
                if failure is not None:
                    if failure.expires_at > now:
                        continue
                    self._failed.pop(key, None)
                if len(self._inflight) >= self._max_pending:
                    break
                self._inflight.add(key)
                self._pool.submit(self._run, target)
                accepted.append(key)
        return accepted

    def _run(self, target: Target) -> None:
        try:
            self._work(target)
        except Exception as error:
            code = getattr(error, "code", type(error).__name__)
            message = getattr(error, "message", None) or str(error)
            ttl = (
                self._unavailable_ttl
                if isinstance(error, VideoUnavailable)
                else self._backoff
            )
            LOGGER.warning("embedding %s failed (%s): %s", target.value, code, message)
            if ttl > 0:
                with self._lock:
                    self._failed[target.value] = EmbeddingFailure(
                        code=str(code),
                        message=str(message),
                        expires_at=time.monotonic() + ttl,
                    )
        finally:
            with self._lock:
                self._inflight.discard(target.value)

    def clear_failure(self, key: str) -> None:
        with self._lock:
            self._failed.pop(key, None)

    def failure(self, key: str) -> EmbeddingFailure | None:
        failure = self._failed.get(key)
        if failure is None:
            return None
        if failure.expires_at <= time.monotonic():
            self._failed.pop(key, None)
            return None
        return failure

    @property
    def inflight(self) -> int:
        with self._lock:
            return len(self._inflight)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
