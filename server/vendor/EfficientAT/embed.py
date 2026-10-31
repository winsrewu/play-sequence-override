from pathlib import Path
import sys

import torch
import librosa
from models.mn.model import get_model as get_mobilenet
from models.preprocess import AugmentMelSTFT


def _load_efficientat_model(model_name="mn10_as", device="cpu"):
    sample_rate = 32000
    window_size = 800
    hop_size = 320
    n_mels = 128

    # Load pre-trained model
    # width_mult 1.0 corresponds to 'mn10_as'. Use 0.4 for 'mn04_as'.
    model = get_mobilenet(width_mult=1.0, pretrained_name=model_name)
    model.to(device)
    model.eval()

    # Initialize mel spectrogram extractor
    mel_extractor = AugmentMelSTFT(
        n_mels=n_mels, sr=sample_rate, win_length=window_size, hopsize=hop_size
    )
    mel_extractor.to(device)
    mel_extractor.eval()

    return model, mel_extractor, sample_rate


def _extract_music_features(
    audio_paths: list,
    model,
    mel_extractor,
    sample_rate,
    device="cpu",
    max_duration=15 * 60,
):
    all_features = []

    for audio_path in audio_paths:
        # Load and preprocess audio to 32kHz mono
        waveform, _ = librosa.core.load(
            audio_path, sr=sample_rate, mono=True, duration=max_duration
        )
        waveform_tensor = torch.from_numpy(waveform[None, :]).to(device)

        with torch.no_grad():
            # Convert waveform to mel spectrogram
            spec = mel_extractor(waveform_tensor)

            # Forward pass: spec.unsqueeze(0) adds batch dim -> [1, 1, n_mels, time]
            preds, features = model(spec.unsqueeze(0))

        # Move features to CPU and convert to numpy array
        features_np = features.float().squeeze().cpu().numpy()
        all_features.append(features_np)

    return all_features


model = None
mel_ext = None
sr = None


def extract_music_features(audio_paths):
    global model, mel_ext, sr
    if model is None:
        model, mel_ext, sr = _load_efficientat_model()
    return _extract_music_features(audio_paths, model, mel_ext, sr)
