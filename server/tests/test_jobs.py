from __future__ import annotations

import time

from app.errors import VideoUnavailable
from app.jobs import EmbeddingJobs


class Target:
    def __init__(self, value: str) -> None:
        self.value = value


def _wait_for_failure(jobs: EmbeddingJobs, key: str, timeout: float = 2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        failure = jobs.failure(key)
        if failure is not None:
            return failure
        time.sleep(0.01)
    raise AssertionError("failure was not recorded")


def test_unavailable_video_is_remembered() -> None:
    calls: list[str] = []

    def work(target: Target) -> None:
        calls.append(target.value)
        raise VideoUnavailable("video is unavailable")

    jobs = EmbeddingJobs(
        1,
        4,
        work,
        failure_backoff_seconds=0,
        unavailable_ttl_seconds=3600,
    )
    try:
        jobs.submit([Target("BBV1")])
        failure = _wait_for_failure(jobs, "BBV1")
        assert failure.code == "video_unavailable"
        assert jobs.submit([Target("BBV1")]) == []
        assert calls == ["BBV1"]
    finally:
        jobs.shutdown()


def test_transient_failure_backs_off_then_retries() -> None:
    calls: list[str] = []

    def work(target: Target) -> None:
        calls.append(target.value)
        raise RuntimeError("temporary")

    jobs = EmbeddingJobs(
        1,
        4,
        work,
        failure_backoff_seconds=0.05,
        unavailable_ttl_seconds=0,
    )
    try:
        jobs.submit([Target("BBV1")])
        failure = _wait_for_failure(jobs, "BBV1")
        assert failure.code == "RuntimeError"
        assert jobs.submit([Target("BBV1")]) == []
        time.sleep(0.08)
        jobs.submit([Target("BBV1")])
        deadline = time.time() + 2
        while len(calls) < 2 and time.time() < deadline:
            time.sleep(0.01)
        assert len(calls) >= 2
    finally:
        jobs.shutdown()
