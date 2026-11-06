from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import AuthContext
from app.bilibili import DownloadResult
from app.config import Settings
from app.embedder import Embedding
from app.errors import InsufficientScope, TokenInvalid, UpstreamError
from app.main import create_app
from app.playlist import dump_playlist, parse_playlist
from app.vad import LyricsVerdict


class FakeVerifier:
    def __init__(self, _settings: Settings) -> None:
        pass

    def verify(self, token: str) -> AuthContext:
        if token == "expired":
            raise TokenInvalid("expired")
        if token == "noscope":
            raise InsufficientScope("play_sequence_override", ["api"])
        if token != "good":
            raise TokenInvalid("bad token")
        return AuthContext(
            subject="winsrewu",
            scope=("play_sequence_override",),
            claims={},
            token_id="jti",
            session_id="sid",
        )


class FakeAudio:
    url = "https://example.invalid/audio"
    headers = {}
    mime_type = "audio/mp4"
    bandwidth = 1
    duration_seconds = 100.0
    kind = "dash"


class FakeBilibili:
    def __init__(self, _settings: Settings) -> None:
        self.calls = []

    def resolve(self, target):  # type: ignore[no-untyped-def]
        self.calls.append(target.value)
        if target.value == "BBV1AA411p7zs":
            raise UpstreamError("simulated upstream failure")
        return FakeAudio()

    def download(self, source, destination: Path, *, force_full: bool = False):  # type: ignore[no-untyped-def]
        destination.write_bytes(b"fake audio")
        return DownloadResult(
            bytes_written=10, partial=False, total_bytes=10, requested_bytes=None
        )

    def close(self) -> None:
        pass


class FakeEmbedder:
    def __init__(self, _settings: Settings) -> None:
        pass

    def embed_wav(self, path: Path) -> Embedding:
        assert path.exists()
        return Embedding(vector=[0.25] * 960, dim=960, model="mn10_as")


class FakeLyrics:
    def __init__(self, _settings: Settings) -> None:
        pass

    def detect(self, path: Path, resampled_path: Path) -> LyricsVerdict:
        assert path.exists()
        return self.detect_16k(path)

    def detect_16k(self, path: Path) -> LyricsVerdict:
        assert path.exists()
        return LyricsVerdict(
            has_lyrics=True,
            singing_ratio=0.82,
            singing_seconds=98.5,
            segments=3,
            threshold=0.5,
        )


def make_settings(
    tmp_path: Path,
    *,
    strict: bool = False,
    max_duration_seconds: int = 900,
    dev_mode: bool = False,
) -> Settings:
    catalog = tmp_path / "catalog.v2.json"
    playlist = parse_playlist(
        {
            "format": "jawbts.music-playlist",
            "version": 2,
            "tracks": [
                {
                    "id": "BBV16y4y127Dz",
                    "provider": "bilibili",
                    "video_id": "BV16y4y127Dz",
                    "page": 1,
                    "title": "t",
                },
                {
                    "id": "BBV1AA411p7zs",
                    "provider": "bilibili",
                    "video_id": "BV1AA411p7zs",
                    "page": 1,
                    "title": "t2",
                },
            ],
        }
    )
    dump_playlist(playlist, catalog, generated_at="2026-10-29T00:00:00Z")
    return Settings(
        catalog_path=catalog,
        catalog_strict=strict,
        jwks_url="https://api.jawbts.org/.well-known/jwks.json",
        allow_insecure_jwks=False,
        max_duration_seconds=max_duration_seconds,
        dev_mode=dev_mode,
    )


def make_client(tmp_path: Path, *, strict: bool = False) -> TestClient:
    app = create_app(
        settings=make_settings(tmp_path, strict=strict),
        verifier_factory=FakeVerifier,
        embedder_factory=FakeEmbedder,
        lyrics_factory=FakeLyrics,
        bilibili_factory=FakeBilibili,
    )
    return TestClient(app)


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    import app.main as main_module

    original = main_module.decode_to_wav

    def fake_decode(_source, destination, **_kwargs):  # type: ignore[no-untyped-def]
        import wave

        with wave.open(str(destination), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(32000)
            handle.writeframes(b"\x00\x00" * 32000)

    main_module.decode_to_wav = fake_decode  # type: ignore[assignment]
    with make_client(tmp_path) as test_client:
        yield test_client
    main_module.decode_to_wav = original


def test_requires_bearer(client: TestClient) -> None:
    response = client.post("/v1/embed", json={"internal_id": "BBV16y4y127Dz"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["cache-control"] == "no-store"


def test_rejects_bad_token(client: TestClient) -> None:
    response = client.post(
        "/v1/embed",
        json={"internal_id": "BBV16y4y127Dz"},
        headers={"Authorization": "Bearer nope"},
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "token_invalid"


def test_rejects_missing_scope(client: TestClient) -> None:
    response = client.post(
        "/v1/embed",
        json={"internal_id": "BBV16y4y127Dz"},
        headers={"Authorization": "Bearer noscope"},
    )
    assert response.status_code == 403
    body = response.json()["error"]
    assert body["code"] == "insufficient_scope"
    assert body["required"] == "play_sequence_override"


def test_rejects_unknown_fields(client: TestClient) -> None:
    response = client.post(
        "/v1/embed",
        json={"internal_id": "BBV16y4y127Dz", "extra": True},
        headers={"Authorization": "Bearer good"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_rejects_malformed_id(client: TestClient) -> None:
    response = client.post(
        "/v1/embed",
        json={"internal_id": "not-an-id"},
        headers={"Authorization": "Bearer good"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_returns_embedding(client: TestClient) -> None:
    response = client.post(
        "/v1/embed",
        json={"internal_id": "BBV16y4y127Dz"},
        headers={"Authorization": "Bearer good"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["internal_id"] == "BBV16y4y127Dz"
    assert body["model"] == "mn10_as"
    assert body["dim"] == 960
    assert len(body["embedding"]) == 960
    assert body["embedding"][0] == 0.25
    assert response.headers["x-embedding-model"] == "mn10_as"
    assert response.headers["cache-control"] == "no-store"


def test_upstream_failure_is_502(client: TestClient) -> None:
    response = client.post(
        "/v1/embed",
        json={"internal_id": "BBV1AA411p7zs"},
        headers={"Authorization": "Bearer good"},
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_error"


def test_strict_catalog_rejects_unknown(tmp_path: Path) -> None:
    app = create_app(
        settings=make_settings(tmp_path, strict=True),
        verifier_factory=FakeVerifier,
        embedder_factory=FakeEmbedder,
        lyrics_factory=FakeLyrics,
        bilibili_factory=FakeBilibili,
    )
    with TestClient(app) as client:
        response = client.post(
            "/v1/embed",
            json={"internal_id": "BBV1114y127ih"},
            headers={"Authorization": "Bearer good"},
        )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "unknown_internal_id"


def test_only_one_public_route(client: TestClient) -> None:
    paths = {
        route.path
        for route in client.app.routes  # type: ignore[attr-defined]
        if getattr(route, "path", "").startswith("/")
    }
    assert paths == {"/v1/embed", "/v1/embeddings", "/v1/vocals"}
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/").status_code == 404


def test_body_limit(client: TestClient) -> None:
    response = client.post(
        "/v1/embed",
        content=b"x" * 20000,
        headers={
            "Authorization": "Bearer good",
            "Content-Type": "application/json",
            "Content-Length": "20000",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


class PartialAudio(FakeAudio):
    duration_seconds = 242.0


class PartialBilibili(FakeBilibili):
    def __init__(self, _settings: Settings) -> None:
        super().__init__(_settings)
        self.downloads: list[bool] = []

    def resolve(self, target):  # type: ignore[no-untyped-def]
        return PartialAudio()

    def download(self, source, destination: Path, *, force_full: bool = False):  # type: ignore[no-untyped-def]
        self.downloads.append(force_full)
        destination.write_bytes(b"fake audio")
        if force_full:
            return DownloadResult(
                bytes_written=9999, partial=False, total_bytes=9999, requested_bytes=None
            )
        return DownloadResult(
            bytes_written=1234, partial=True, total_bytes=9999, requested_bytes=2000
        )


def _write_wav(path: Path, seconds: float) -> None:
    import wave

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(32000)
        handle.writeframes(b"\x00\x00" * int(32000 * seconds))


def test_partial_download_headers(tmp_path: Path) -> None:
    import app.main as main_module

    original = main_module.decode_to_wav
    main_module.decode_to_wav = lambda _s, d, **k: _write_wav(Path(d), 60.0)  # type: ignore[assignment]
    app = create_app(
        settings=make_settings(tmp_path, max_duration_seconds=60),
        verifier_factory=FakeVerifier,
        embedder_factory=FakeEmbedder,
        lyrics_factory=FakeLyrics,
        bilibili_factory=PartialBilibili,
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/embed",
                json={"internal_id": "BBV16y4y127Dz"},
                headers={"Authorization": "Bearer good"},
            )
    finally:
        main_module.decode_to_wav = original
    assert response.status_code == 200, response.text
    assert response.headers["x-audio-partial"] == "true"
    assert response.headers["x-audio-bytes"] == "1234"
    assert response.headers["x-audio-duration"] == "60.0"


def test_short_partial_retries_full(tmp_path: Path) -> None:
    import app.main as main_module

    calls = {"n": 0}

    def decoder(_source, destination, **_kwargs):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        _write_wav(Path(destination), 60.0 if calls["n"] > 1 else 1.0)

    original = main_module.decode_to_wav
    main_module.decode_to_wav = decoder  # type: ignore[assignment]
    bilibili = PartialBilibili(make_settings(tmp_path))
    app = create_app(
        settings=make_settings(tmp_path, max_duration_seconds=60),
        verifier_factory=FakeVerifier,
        embedder_factory=FakeEmbedder,
        lyrics_factory=FakeLyrics,
        bilibili_factory=lambda _settings: bilibili,
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/embed",
                json={"internal_id": "BBV16y4y127Dz"},
                headers={"Authorization": "Bearer good"},
            )
    finally:
        main_module.decode_to_wav = original
    assert response.status_code == 200, response.text
    assert bilibili.downloads == [False, True]
    assert response.headers["x-audio-partial"] == "false"


def test_dev_mode_bypasses_auth(tmp_path: Path) -> None:
    import app.main as main_module

    original = main_module.decode_to_wav

    def fake_decode(_source, destination, **_kwargs):  # type: ignore[no-untyped-def]
        import wave

        with wave.open(str(destination), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(32000)
            handle.writeframes(b"\x00\x00" * 32000)

    main_module.decode_to_wav = fake_decode  # type: ignore[assignment]
    app = create_app(
        settings=make_settings(tmp_path, dev_mode=True),
        verifier_factory=FakeVerifier,
        embedder_factory=FakeEmbedder,
        lyrics_factory=FakeLyrics,
        bilibili_factory=FakeBilibili,
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/embed", json={"internal_id": "BBV16y4y127Dz"}
            )
    finally:
        main_module.decode_to_wav = original
    assert response.status_code == 200, response.text
    assert response.headers["x-dev-mode"] == "true"
    assert response.json()["dim"] == 960


def test_embed_is_cached_for_second_call(client: TestClient) -> None:
    first = client.post(
        "/v1/embed",
        json={"internal_id": "BBV16y4y127Dz"},
        headers={"Authorization": "Bearer good"},
    )
    second = client.post(
        "/v1/embed",
        json={"internal_id": "BBV16y4y127Dz"},
        headers={"Authorization": "Bearer good"},
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.headers["x-embedding-cached"] == "false"
    assert second.headers["x-embedding-cached"] == "true"
    assert second.json()["embedding"] == first.json()["embedding"]
    assert second.headers["x-audio-bytes"] == "10"


def _batch(client: TestClient, ids: list[str]):
    return client.post(
        "/v1/embeddings",
        json={"internal_ids": ids},
        headers={"Authorization": "Bearer good"},
    )


def _wait_for_batch(client: TestClient, ids: list[str], timeout: float = 5.0):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        body = _batch(client, ids).json()
        if not body["pending"]:
            return body
        time.sleep(0.02)
    raise AssertionError(f"batch did not finish: {body}")


def test_batch_returns_ready_and_queues_missing(client: TestClient) -> None:
    queued = _batch(client, ["BBV16y4y127Dz"])
    assert queued.status_code == 200
    assert queued.json()["embeddings"] == []
    assert queued.json()["pending"] == ["BBV16y4y127Dz"]

    ready = _wait_for_batch(client, ["BBV16y4y127Dz"])
    assert [item["internal_id"] for item in ready["embeddings"]] == ["BBV16y4y127Dz"]
    assert ready["embeddings"][0]["dim"] == 960
    assert ready["pending"] == []


def test_batch_deduplicates_ids(client: TestClient) -> None:
    body = _batch(client, ["BBV16y4y127Dz", "BBV16y4y127Dz"]).json()
    assert body["pending"] == ["BBV16y4y127Dz"]
    ready = _wait_for_batch(client, ["BBV16y4y127Dz", "BBV16y4y127Dz"])
    assert len(ready["embeddings"]) == 1


def test_batch_rejects_more_than_fifteen(client: TestClient) -> None:
    response = _batch(client, ["BBV16y4y127Dz"] * 16)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_batch_requires_auth(client: TestClient) -> None:
    response = client.post("/v1/embeddings", json={"internal_ids": ["BBV16y4y127Dz"]})
    assert response.status_code == 401


def test_batch_reports_failed_tracks(client: TestClient) -> None:
    queued = _batch(client, ["BBV1AA411p7zs"])
    assert queued.json()["pending"] == ["BBV1AA411p7zs"]

    body = _wait_for_batch(client, ["BBV1AA411p7zs"])
    assert body["pending"] == []
    assert [item["internal_id"] for item in body["failures"]] == ["BBV1AA411p7zs"]
    assert body["failures"][0]["code"] == "upstream_error"

    again = _batch(client, ["BBV1AA411p7zs"]).json()
    assert again["pending"] == []
    assert again["failures"][0]["internal_id"] == "BBV1AA411p7zs"


def test_single_embed_reports_cached_failure(client: TestClient) -> None:
    _batch(client, ["BBV1AA411p7zs"])
    _wait_for_batch(client, ["BBV1AA411p7zs"])
    response = client.post(
        "/v1/embed",
        json={"internal_id": "BBV1AA411p7zs"},
        headers={"Authorization": "Bearer good"},
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_error"


def _vocals(client: TestClient, ids: list[str]):
    return client.post(
        "/v1/vocals",
        json={"internal_ids": ids},
        headers={"Authorization": "Bearer good"},
    )


def _wait_for_vocals(client: TestClient, ids: list[str], timeout: float = 5.0):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        body = _vocals(client, ids).json()
        if not body["pending"]:
            return body
        time.sleep(0.02)
    raise AssertionError(f"vocals did not finish: {body}")


def test_vocals_batch_queues_then_reports_verdict(client: TestClient) -> None:
    queued = _vocals(client, ["BBV16y4y127Dz"])
    assert queued.status_code == 200
    assert queued.json()["vocals"] == []
    assert queued.json()["pending"] == ["BBV16y4y127Dz"]
    assert queued.json()["model"] == "fireredvad-aed"
    assert queued.json()["threshold"] == 0.5
    assert queued.headers["x-vocals-threshold"] == "0.5"
    assert queued.headers["cache-control"] == "no-store"

    ready = _wait_for_vocals(client, ["BBV16y4y127Dz"])
    assert ready["pending"] == []
    item = ready["vocals"][0]
    assert item["internal_id"] == "BBV16y4y127Dz"
    assert item["has_lyrics"] is True
    assert item["singing_ratio"] == 0.82
    assert item["singing_seconds"] == 98.5
    assert item["segments"] == 3


def test_vocals_reuses_the_embedding_analysis(client: TestClient) -> None:
    embedded = client.post(
        "/v1/embed",
        json={"internal_id": "BBV16y4y127Dz"},
        headers={"Authorization": "Bearer good"},
    )
    assert embedded.status_code == 200
    body = _vocals(client, ["BBV16y4y127Dz"]).json()
    assert body["pending"] == []
    assert body["vocals"][0]["has_lyrics"] is True


def test_vocals_is_batch_only(client: TestClient) -> None:
    single = client.post(
        "/v1/vocals",
        json={"internal_id": "BBV16y4y127Dz"},
        headers={"Authorization": "Bearer good"},
    )
    assert single.status_code == 400
    assert single.json()["error"]["code"] == "invalid_request"
    assert client.get("/v1/vocals").status_code == 405


def test_vocals_requires_auth(client: TestClient) -> None:
    response = client.post("/v1/vocals", json={"internal_ids": ["BBV16y4y127Dz"]})
    assert response.status_code == 401


def test_vocals_rejects_more_than_fifteen(client: TestClient) -> None:
    response = _vocals(client, ["BBV16y4y127Dz"] * 16)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_vocals_reports_failed_tracks(client: TestClient) -> None:
    queued = _vocals(client, ["BBV1AA411p7zs"])
    assert queued.json()["pending"] == ["BBV1AA411p7zs"]

    body = _wait_for_vocals(client, ["BBV1AA411p7zs"])
    assert body["pending"] == []
    assert [item["internal_id"] for item in body["failures"]] == ["BBV1AA411p7zs"]
    assert body["failures"][0]["code"] == "upstream_error"
