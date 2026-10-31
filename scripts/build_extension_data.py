#!/usr/bin/env python3
# Builds ignored build/extension data from the v2 catalog and /mnt/g/C/embed_data. Not used at runtime.
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from app.playlist import Playlist, dump_playlist, load_playlist  # noqa: E402


def load_embeddings(embed_dir: Path) -> dict[str, np.ndarray]:
    vectors: dict[str, np.ndarray] = {}
    files = sorted(embed_dir.glob("music_embed*.json"))
    if not files:
        raise SystemExit(f"no music_embed*.json under {embed_dir}")
    for path in files:
        with path.open(encoding="utf-8") as handle:
            document = json.load(handle)
        for entry in document.get("data", []):
            name = str(entry.get("name") or "")
            vector = entry.get("embed")
            if not name.endswith(".mp3") or not isinstance(vector, list):
                continue
            key = name[:-4]
            array = np.asarray(vector, dtype=np.float32)
            if array.shape != (960,):
                raise SystemExit(f"{path}: {name} has shape {array.shape}, expected (960,)")
            previous = vectors.get(key)
            if previous is not None and not np.array_equal(previous, array):
                raise SystemExit(f"conflicting embeddings for {name}")
            vectors[key] = array
    return vectors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--catalog",
        type=Path,
        default=ROOT / "server" / "data" / "music.v2.json",
    )
    parser.add_argument(
        "--embed-dir",
        type=Path,
        default=Path("/mnt/g/C/embed_data"),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "extension" / "data",
    )
    args = parser.parse_args()

    playlist: Playlist = load_playlist(args.catalog)
    embeddings = load_embeddings(args.embed_dir)

    catalog_ids = {track.id for track in playlist.tracks}
    indexed_ids = sorted(
        track.id
        for track in playlist.tracks
        if track.page == 1 and f"B{track.video_id}" == track.id and track.video_id in embeddings
    )
    if not indexed_ids:
        raise SystemExit("no catalog track matched an embedding")

    matrix = np.stack([embeddings[track_id[1:]] for track_id in indexed_ids]).astype("<f4")
    raw = matrix.tobytes(order="C")
    digest = hashlib.sha256(raw).hexdigest()

    from sklearn.cluster import KMeans
    from sklearn.decomposition import KernelPCA

    normalized = matrix.astype(np.float32)
    normalized /= np.maximum(np.linalg.norm(normalized, axis=1, keepdims=True), 1e-12)
    reducer = KernelPCA(n_components=2, kernel="cosine", random_state=42)
    coords = reducer.fit_transform(normalized)

    k_fit_rows = np.asarray(reducer._centerer.K_fit_rows_, dtype=np.float32)
    k_fit_all = float(reducer._centerer.K_fit_all_)
    scaled_alphas = np.zeros_like(reducer.eigenvectors_)
    non_zero = np.flatnonzero(reducer.eigenvalues_)
    scaled_alphas[:, non_zero] = reducer.eigenvectors_[:, non_zero] / np.sqrt(
        reducer.eigenvalues_[non_zero]
    )

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "embeddings.bin").write_bytes(raw)
    index = {
        "format": "jawbts.embedding-bundle",
        "version": 1,
        "model": "mn10_as",
        "dim": 960,
        "count": len(indexed_ids),
        "ids": indexed_ids,
        "sha256": digest,
    }
    (args.out / "embeddings-index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    projection = {
        "model": "mn10_as",
        "projection": "KernelPCA",
        "kernel": "cosine",
        "random_state": 42,
        "ids": indexed_ids,
        "x": [float(point[0]) for point in coords],
        "y": [float(point[1]) for point in coords],
        "k_fit_rows": [float(value) for value in k_fit_rows],
        "k_fit_all": k_fit_all,
        "scaled_alphas": scaled_alphas.tolist(),
    }
    (args.out / "projection.json").write_text(
        json.dumps(projection, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    all_keys = list(embeddings.keys())
    all_normalized = np.stack([embeddings[key] for key in all_keys]).astype(np.float32)
    all_normalized /= np.maximum(
        np.linalg.norm(all_normalized, axis=1, keepdims=True), 1e-12
    )
    kmeans = KMeans(n_clusters=30, n_init=10, random_state=42).fit(all_normalized)
    label_by_key = {
        key: int(kmeans.labels_[index]) for index, key in enumerate(all_keys)
    }
    style = {
        "model": "mn10_as",
        "clusters": 30,
        "n_init": 10,
        "random_state": 42,
        "ids": indexed_ids,
        "labels": [label_by_key[track_id[1:]] for track_id in indexed_ids],
        "centroids": kmeans.cluster_centers_.astype(np.float32).tolist(),
    }
    (args.out / "style-labels.json").write_text(
        json.dumps(style, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    dump_playlist(
        playlist,
        args.out / "music.v2.json",
        generated_at="2026-10-29T00:00:00Z",
    )

    missing = sorted(catalog_ids - set(indexed_ids))
    print(f"catalog tracks      {len(playlist)}")
    print(f"embedded tracks     {len(indexed_ids)}")
    print(f"missing vectors     {len(missing)}")
    print(f"bundle bytes        {len(raw)} ({len(raw) / 1024 / 1024:.2f} MiB)")
    print(f"bundle sha256       {digest}")
    print(f"output              {args.out}")
    if missing:
        print(f"first missing       {missing[:5]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
