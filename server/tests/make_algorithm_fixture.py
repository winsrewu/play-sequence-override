#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from reference_recommender import ReferenceRecommender  # noqa: E402

ROOT = HERE.parent.parent


def main() -> int:
    rng = np.random.default_rng(20261029)
    count = 30
    dim = 8
    ids = [f"T{index:02d}" for index in range(count)]
    vectors = np.round(rng.normal(size=(count, dim)).astype(np.float32), 6)
    current = "T07"
    history = ["T07", "T03", "T19", "T03", "T11", "T24"]
    target = 0.7
    plays = {"T03": 2, "T19": 1, "T24": 4}

    reference = ReferenceRecommender(vectors, ids)
    history_names = reference.prepare_history(history, current)
    pool = reference.pool(current, history_names)
    scores = reference.scores(current, pool, history_names, target, plays)
    probabilities, maximum = reference.probabilities(current, history, target, plays)
    candidate_ids = [ids[index] for index in pool]

    fixture = {
        "description": "Deterministic vectors for extension/src/lib/algorithm.js parity",
        "dim": dim,
        "ids": ids,
        "vectors": vectors.tolist(),
        "current": current,
        "history": history,
        "target": target,
        "session_plays": plays,
        "candidate_ids": candidate_ids,
        "scores": [float(value) for value in scores],
        "probabilities": probabilities,
        "max_probability": maximum,
    }
    destination = ROOT / "extension" / "tests" / "fixtures" / "algorithm-parity.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {destination} ({len(candidate_ids)} candidates)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
