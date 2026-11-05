from __future__ import annotations

import time

from app.cache import VectorCache


def _put(cache: VectorCache, key: str, value: float = 1.0) -> None:
    cache.put(
        key,
        [value] * 4,
        model="mn10_as",
        audio_bytes=10,
        audio_partial=False,
        audio_duration=1.0,
    )


def test_cache_returns_values_until_ttl() -> None:
    cache = VectorCache(ttl_seconds=60, max_entries=4)
    _put(cache, "BBV1")
    entry = cache.get("BBV1")
    assert entry is not None
    assert list(entry.values) == [1.0, 1.0, 1.0, 1.0]
    assert entry.model == "mn10_as"


def test_cache_expires() -> None:
    cache = VectorCache(ttl_seconds=0.05, max_entries=4)
    _put(cache, "BBV1")
    assert cache.get("BBV1") is not None
    time.sleep(0.08)
    assert cache.get("BBV1") is None


def test_cache_can_be_disabled() -> None:
    cache = VectorCache(ttl_seconds=0, max_entries=4)
    _put(cache, "BBV1")
    assert cache.get("BBV1") is None
    assert len(cache) == 0


def test_cache_evicts_oldest_entry() -> None:
    cache = VectorCache(ttl_seconds=60, max_entries=2)
    _put(cache, "a")
    _put(cache, "b")
    _put(cache, "c")
    assert cache.get("a") is None
    assert cache.get("b") is not None
    assert cache.get("c") is not None
