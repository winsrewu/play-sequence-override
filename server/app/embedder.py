# 32 kHz mono -> mel -> mn10_as -> pooled 960-D vector, returned unnormalised.
from __future__ import annotations

import contextlib
import io
import logging
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .config import Settings
from .errors import EmbeddingFailed

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class Embedding:
    vector: list[float]
    dim: int
    model: str


class Embedder:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = threading.Lock()
        self._model = None
        self._mel = None
        self._torch = None
        self._librosa = None
        self._device = settings.device
        self._load()

    def _load(self) -> None:
        vendor = str(self._settings.efficientat_path)
        if vendor not in sys.path:
            sys.path.insert(0, vendor)

        try:
            import torch
            import librosa
            from models.mn.model import get_model
            from models.preprocess import AugmentMelSTFT
        except Exception as exc:  # pragma: no cover - import environment failure
            raise EmbeddingFailed(f"could not import the embedding stack: {exc}") from exc

        torch.set_num_threads(self._settings.torch_threads)
        if self._device == "cuda" and not torch.cuda.is_available():
            raise EmbeddingFailed("DEVICE=cuda but CUDA is not available")
        device = torch.device(self._device)

        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
            io.StringIO()
        ):
            try:
                state = torch.load(
                    self._settings.model_path,
                    map_location="cpu",
                    weights_only=True,
                )
                if "classifier.5.bias" not in state:
                    raise EmbeddingFailed(
                        "checkpoint does not look like the mn10_as AudioSet model"
                    )
                num_classes = int(state["classifier.5.bias"].shape[0])
                model = get_model(
                    pretrained_name=None,
                    width_mult=1.0,
                    num_classes=num_classes,
                    head_type="mlp",
                    input_dim_f=128,
                    input_dim_t=1000,
                )
                model.load_state_dict(state)
                mel = AugmentMelSTFT(
                    n_mels=128,
                    sr=32000,
                    win_length=800,
                    hopsize=320,
                )
            except EmbeddingFailed:
                raise
            except Exception as exc:
                raise EmbeddingFailed(f"could not load the model: {exc}") from exc

        model.to(device).eval()
        mel.to(device).eval()

        self._torch = torch
        self._librosa = librosa
        self._model = model
        self._mel = mel
        self._device_obj = device
        LOGGER.info(
            "loaded %s (%s) on %s", self._settings.model_name, self._settings.model_path, device
        )

    def embed_wav(self, path: Path) -> Embedding:
        torch = self._torch
        librosa = self._librosa
        if torch is None or self._model is None or self._mel is None:
            raise EmbeddingFailed("embedding model is not loaded")

        try:
            waveform, _ = librosa.load(
                str(path),
                sr=32000,
                mono=True,
                duration=self._settings.max_duration_seconds,
            )
        except Exception as exc:
            raise EmbeddingFailed(f"could not read the decoded audio: {exc}") from exc

        if waveform.size == 0:
            raise EmbeddingFailed("decoded audio is empty")
        if not np.isfinite(waveform).all():
            raise EmbeddingFailed("decoded audio contains non-finite samples")

        tensor = torch.from_numpy(waveform[None, :]).to(self._device_obj)
        with self._lock, torch.inference_mode():
            try:
                spec = self._mel(tensor)
                _preds, features = self._model(spec.unsqueeze(0))
                vector = features.float().reshape(-1).cpu().numpy()
            except Exception as exc:
                raise EmbeddingFailed(f"model inference failed: {exc}") from exc

        if vector.shape != (self._settings.embedding_dim,):
            raise EmbeddingFailed(
                f"model returned {vector.shape[0]} dimensions, expected "
                f"{self._settings.embedding_dim}"
            )
        if not np.isfinite(vector).all():
            raise EmbeddingFailed("model returned a non-finite vector")

        return Embedding(
            vector=[float(value) for value in vector],
            dim=int(vector.shape[0]),
            model=self._settings.model_name,
        )
