# FireRedVAD AED on 16 kHz mono PCM: speech, singing and music events.
#
# A track counts as having lyrics when the singing ratio clears a small
# threshold, so one vocal phrase still counts while instrumental tracks stay
# near zero. The model is tiny (2.4 MB) and runs alongside the embedding pass
# on the same downloaded audio.
from __future__ import annotations

import logging
import queue
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import EmbeddingFailed

LOGGER = logging.getLogger(__name__)

MODEL_NAME = "fireredvad-aed"
SAMPLE_RATE = 16000
RESAMPLE_TIMEOUT_SECONDS = 120


@dataclass(frozen=True)
class LyricsVerdict:
    has_lyrics: bool
    singing_ratio: float
    singing_seconds: float
    segments: int
    threshold: float
    speech_ratio: float = 0.0


def verdict_from_result(result: dict[str, Any], threshold: float) -> LyricsVerdict:
    """Turn one FireRedVAD AED result into a binary lyrics verdict."""
    ratios = result.get("event2ratio") or {}
    ratio = float(ratios.get("singing", 0.0))
    speech = float(ratios.get("speech", 0.0))
    timestamps = (result.get("event2timestamps") or {}).get("singing") or []
    seconds = sum(float(end) - float(start) for start, end in timestamps)
    limit = min(1.0, max(0.0, float(threshold)))
    # Words can be sung or spoken: rap/recitative registers as speech, so both
    # events count as a lyrics-bearing track.
    return LyricsVerdict(
        has_lyrics=ratio >= limit or speech >= limit,
        singing_ratio=round(min(1.0, max(0.0, ratio)), 4),
        singing_seconds=round(max(0.0, seconds), 3),
        segments=len(timestamps),
        threshold=limit,
        speech_ratio=round(min(1.0, max(0.0, speech)), 4),
    )


class LyricsDetector:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._pool: "queue.Queue[Any]" = queue.Queue()
        self._load()

    def _load(self) -> None:
        try:
            from fireredvad import FireRedAed, FireRedAedConfig
        except Exception as exc:  # pragma: no cover - import environment failure
            raise EmbeddingFailed(f"could not import FireRedVAD: {exc}") from exc

        model_dir = self._settings.vocals_model_path
        # One instance per detection worker: the model forward is thread-safe,
        # but FireRedVAD's postprocessors keep per-run state, so each concurrent
        # detection needs its own instance.
        workers = max(1, int(self._settings.vocals_workers or 1))
        try:
            config = FireRedAedConfig(
                use_gpu=False,
                singing_threshold=self._settings.vocals_singing_threshold,
                min_event_frame=self._settings.vocals_min_event_frames,
            )
            for _ in range(workers):
                self._pool.put(FireRedAed.from_pretrained(str(model_dir), config))
        except Exception as exc:
            raise EmbeddingFailed(
                f"could not load the FireRedVAD AED model from {model_dir}: {exc}"
            ) from exc
        LOGGER.info("loaded %d FireRedVAD AED instance(s) (%s)", workers, model_dir)

    def detect(self, wav_path: Path, resampled_path: Path) -> LyricsVerdict:
        """Resample an existing 32 kHz WAV and detect, reusing one audio pass."""
        self._resample(wav_path, resampled_path)
        return self.detect_16k(resampled_path)

    def detect_16k(self, wav_path: Path) -> LyricsVerdict:
        """Run the AED model on an existing 16 kHz PCM WAV.

        Instances are leased from a pool, so several workers detect in parallel.
        """
        aed = self._pool.get()
        try:
            result, _probs = aed.detect(str(wav_path))
        except Exception as exc:
            raise EmbeddingFailed(f"singing detection failed: {exc}") from exc
        finally:
            self._pool.put(aed)
        return verdict_from_result(result, self._settings.vocals_min_ratio)

    def _resample(self, source: Path, destination: Path) -> None:
        command = [
            self._settings.ffmpeg_bin,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(destination),
        ]
        try:
            subprocess.run(
                command,
                check=True,
                capture_output=True,
                timeout=RESAMPLE_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise EmbeddingFailed("could not resample the audio for singing analysis") from exc
        except subprocess.CalledProcessError as exc:
            detail = (exc.stderr or b"").decode("utf-8", "replace").strip()
            raise EmbeddingFailed(
                f"could not resample the audio for singing analysis: {detail[:200]}"
            ) from exc
        except OSError as exc:
            raise EmbeddingFailed(f"could not run ffmpeg: {exc}") from exc
