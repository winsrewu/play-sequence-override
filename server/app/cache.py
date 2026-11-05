# In-process vector cache for the hosted service. Container-local (no disk, no
# database); entries expire after the configured TTL so a restart starts empty.
from __future__ import annotations

import threading
import time
from array import array
from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class CachedVector:
    values: array
    model: str
    audio_bytes: int
    audio_partial: bool
    audio_duration: float
    stored_at: float
    expires_at: float


class VectorCache:
    def __init__(self, ttl_seconds: int, max_entries: int) -> None:
        self._ttl = max(0.0, float(ttl_seconds))
        self._max = max(1, int(max_entries))
        self._lock = threading.Lock()
        self._items: dict[str, CachedVector] = {}

    def get(self, key: str) -> CachedVector | None:
        if self._ttl <= 0:
            return None
        now = time.monotonic()
        with self._lock:
            entry = self._items.get(key)
            if entry is None:
                return None
            if entry.expires_at <= now:
                self._items.pop(key, None)
                return None
            return entry

    def put(
        self,
        key: str,
        values: Iterable[float],
        *,
        model: str,
        audio_bytes: int,
        audio_partial: bool,
        audio_duration: float,
    ) -> None:
        if self._ttl <= 0:
            return
        now = time.monotonic()
        entry = CachedVector(
            values=array("f", values),
            model=model,
            audio_bytes=int(audio_bytes),
            audio_partial=bool(audio_partial),
            audio_duration=float(audio_duration),
            stored_at=now,
            expires_at=now + self._ttl,
        )
        with self._lock:
            self._prune(now)
            if key not in self._items and len(self._items) >= self._max:
                self._items.pop(next(iter(self._items)))
            self._items[key] = entry

    def _prune(self, now: float) -> None:
        expired = [key for key, entry in self._items.items() if entry.expires_at <= now]
        for key in expired:
            self._items.pop(key, None)

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)
