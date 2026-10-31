from __future__ import annotations

import struct
import wave
from pathlib import Path

import pytest

from app.bilibili import (
    AudioSource,
    _validate_and_trim_fragmented_mp4,
    estimate_range_bytes,
    extract_audio,
    parse_target,
    wav_duration_seconds,
)
from app.errors import InvalidAudioFormat, InvalidRequest


def test_extract_prefers_highest_bandwidth_dash_audio() -> None:
    payload = {
        "data": {
            "dash": {
                "duration": 242,
                "audio": [
                    {"bandwidth": 64000, "baseUrl": "https://example.invalid/low", "mimeType": "audio/mp4"},
                    {"bandwidth": 320000, "baseUrl": "https://example.invalid/high", "mimeType": "audio/mp4"},
                    {"bandwidth": 128000, "baseUrl": "https://example.invalid/mid"},
                ],
            }
        }
    }
    assert extract_audio(payload) == (
        "https://example.invalid/high",
        "audio/mp4",
        320000,
        242.0,
        "dash",
    )


def test_extract_uses_backup_url() -> None:
    payload = {
        "data": {
            "dash": {
                "duration": 10,
                "audio": [
                    {"bandwidth": 1, "backupUrl": ["https://example.invalid/backup"]}
                ],
            }
        }
    }
    assert extract_audio(payload)[0] == "https://example.invalid/backup"


def test_extract_durl_fallback() -> None:
    payload = {
        "data": {
            "timelength": 241151,
            "durl": [{"url": "https://example.invalid/combined.mp4"}],
        }
    }
    assert extract_audio(payload) == (
        "https://example.invalid/combined.mp4",
        None,
        None,
        241.151,
        "durl",
    )


def test_extract_none() -> None:
    assert extract_audio({"data": {}}) is None
    assert extract_audio({"data": {"dash": {"audio": []}}}) is None
    assert extract_audio({"data": "weird"}) is None


def source(**overrides: object) -> AudioSource:
    values = {
        "url": "https://example.invalid/audio",
        "headers": {},
        "mime_type": "audio/mp4",
        "bandwidth": 160_000,
        "duration_seconds": 1800.0,
        "kind": "dash",
    }
    values.update(overrides)
    return AudioSource(**values)  # type: ignore[arg-type]


def test_estimate_range_bytes_only_when_track_is_longer_than_window() -> None:
    assert estimate_range_bytes(source(), 900) is not None
    assert estimate_range_bytes(source(duration_seconds=600), 900) is None
    assert estimate_range_bytes(source(bandwidth=None), 900) is None
    assert estimate_range_bytes(source(kind="durl"), 900) is None


def test_estimate_range_is_smaller_than_a_full_long_track() -> None:
    estimated = estimate_range_bytes(source(), 900)
    assert estimated is not None
    full = int(160_000 * 1800 / 8)
    assert 0 < estimated < full


def test_estimate_range_has_a_floor() -> None:
    estimated = estimate_range_bytes(
        source(bandwidth=1, duration_seconds=10_000), 900
    )
    assert estimated == 512 * 1024


def _box(box_type: str, payload: bytes = b"") -> bytes:
    size = 8 + len(payload)
    return struct.pack(">I", size) + box_type.encode("latin1") + payload


def test_fragmented_mp4_is_trimmed_to_last_complete_mdat(tmp_path: Path) -> None:
    complete = (
        _box("ftyp", b"iso5")
        + _box("moov", b"m" * 128)
        + _box("moof", b"f" * 16)
        + _box("mdat", b"d" * 512)
        + _box("moof", b"f" * 16)
        + _box("mdat", b"d" * 512)
    )
    path = tmp_path / "frag.m4s"
    path.write_bytes(complete + _box("moof", b"x" * 64)[:-20])
    _validate_and_trim_fragmented_mp4(path)
    assert path.read_bytes() == complete


def test_non_fragmented_mp4_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "plain.mp4"
    path.write_bytes(_box("ftyp", b"iso5") + _box("moov", b"m" * 64) + _box("mdat", b"d" * 64))
    with pytest.raises(InvalidAudioFormat):
        _validate_and_trim_fragmented_mp4(path)


def test_non_mp4_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "audio.mp3"
    path.write_bytes(b"ID3\x04\x00\x00" + b"x" * 1024)
    with pytest.raises(InvalidAudioFormat):
        _validate_and_trim_fragmented_mp4(path)


def test_wav_duration(tmp_path: Path) -> None:
    path = tmp_path / "audio.wav"
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(32000)
        handle.writeframes(b"\x00\x00" * 64000)
    assert wav_duration_seconds(path) == pytest.approx(2.0)


def test_parse_target() -> None:
    target = parse_target("BBV16y4y127Dz_2")
    assert target.video_id == "BV16y4y127Dz"
    assert target.page == 2


def test_parse_target_rejects_other_providers() -> None:
    with pytest.raises(InvalidRequest):
        parse_target("nope")
