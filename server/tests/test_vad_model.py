from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

import pytest

pytest.importorskip("torch")
pytest.importorskip("fireredvad")
pytest.importorskip("soundfile")
imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")

from app.config import Settings  # noqa: E402
from app.vad import LyricsDetector  # noqa: E402

ASSETS = Path(__file__).resolve().parents[1] / "assets" / "fireredvad" / "AED"


def _write_tone(path: Path, seconds: float = 5.0, freq: float = 440.0) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(32000)
        frames = bytearray()
        for index in range(int(32000 * seconds)):
            value = 0.2 * math.sin(2 * math.pi * freq * index / 32000)
            frames += struct.pack("<h", int(value * 32767))
        handle.writeframes(bytes(frames))


def test_fireredvad_runs_on_the_vendored_model(tmp_path: Path) -> None:
    wav = tmp_path / "tone.wav"
    _write_tone(wav)
    settings = Settings(
        vocals_model_path=ASSETS,
        vocals_min_ratio=0.5,
        ffmpeg_bin=imageio_ffmpeg.get_ffmpeg_exe(),
    )
    detector = LyricsDetector(settings)
    verdict = detector.detect(wav, tmp_path / "tone-16k.wav")
    assert verdict.has_lyrics is False
    assert verdict.singing_ratio == 0.0
    assert verdict.threshold == 0.5
