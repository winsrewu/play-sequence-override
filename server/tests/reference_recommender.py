from __future__ import annotations

import numpy as np

DEFAULT_HISTORY_LENGTH = 400
MIN_HISTORY_LENGTH = 10
MAX_HISTORY_LENGTH = 400
CANDIDATE_SAMPLE = 500
TOP_K = 10
PENALTY_STRENGTH = 3.0
CURVE = 0.5
SIM_CURVE = 0.5
STYLE_WEIGHT = 1.0 / 3.0
SIMILARITY_SIGMA = 25.0
NOVELTY_PENALTY = 0.2
DEFAULT_FORCE_SKIP = 0


class ReferenceRecommender:
    def __init__(
        self,
        vectors: np.ndarray,
        ids: list[str],
        style_labels: np.ndarray | None = None,
    ) -> None:
        embeddings = np.asarray(vectors, dtype=np.float32)
        embeddings /= np.maximum(
            np.linalg.norm(embeddings, axis=1, keepdims=True), 1e-12
        )
        self.embeddings = embeddings
        self.ids = ids
        self.index = {name: i for i, name in enumerate(ids)}
        self._min_cache: dict[int, float] = {}
        self.style_labels = (
            np.asarray(style_labels, dtype=np.int32)
            if style_labels is not None
            else None
        )

    def min_similarity(self, index: int) -> float:
        if len(self.ids) < 2:
            return 1.0
        if index not in self._min_cache:
            similarities = self.embeddings @ self.embeddings[index]
            similarities[index] = np.inf
            self._min_cache[index] = float(similarities.min())
        return self._min_cache[index]

    def normalized(self, raw: np.ndarray | float, reference: int) -> np.ndarray | float:
        low = self.min_similarity(reference)
        if low >= 1.0:
            return np.ones_like(raw)
        return np.clip((raw - low) / (1.0 - low), 0.0, 1.0)

    def prepare_history(self, history: list[str], current: str, history_length: int = DEFAULT_HISTORY_LENGTH) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for name in history:
            if name in self.index and name not in seen:
                seen.add(name)
                ordered.append(name)
        if current in self.index:
            if current in ordered:
                ordered.remove(current)
            ordered.insert(0, current)
        return ordered[: max(MIN_HISTORY_LENGTH, min(MAX_HISTORY_LENGTH, history_length))]

    def pool(
        self,
        current: str,
        history: list[str],
        force_skip: int = DEFAULT_FORCE_SKIP,
        recent: list[str] | None = None,
    ) -> list[int]:
        blocked = {self.index[current]}
        blocked.update(self.index[name] for name in history if name in self.index)
        base_mask = np.ones(len(self.ids), dtype=bool)
        base_mask[list(blocked)] = False
        if force_skip > 0 and recent:
            forced = set(blocked)
            forced.update(
                self.index[name] for name in recent[:force_skip] if name in self.index
            )
            force_mask = np.ones(len(self.ids), dtype=bool)
            force_mask[list(forced)] = False
            if force_mask.any():
                return np.flatnonzero(force_mask).tolist()
        return np.flatnonzero(base_mask).tolist()

    def history_penalty(
        self,
        candidates: list[int],
        history: list[str],
        history_length: int = DEFAULT_HISTORY_LENGTH,
        curve: float = CURVE,
        sim_curve: float = SIM_CURVE,
    ) -> np.ndarray:
        history_idx = [self.index[name] for name in history if name in self.index]
        if not history_idx:
            return np.zeros(len(candidates), dtype=np.float32)
        weights = np.power(
            1.0 - np.arange(len(history_idx), dtype=np.float32) / max(history_length - 1, 1),
            curve,
        ).astype(np.float32)
        raw = self.embeddings[candidates] @ self.embeddings[history_idx].T
        lows = np.array([self.min_similarity(i) for i in history_idx], dtype=np.float32)
        similarities = np.clip((raw - lows) / np.maximum(1.0 - lows, 1e-12), 0.0, 1.0)
        similarities = np.power(similarities, sim_curve)
        return 0.5 * (similarities @ weights) / weights.sum() + 0.5 * similarities.max(axis=1)

    def scores(
        self,
        current: str,
        candidates: list[int],
        history: list[str],
        target: float,
        session_plays: dict[str, int] | None = None,
    ) -> np.ndarray:
        current_idx = self.index[current]
        raw = self.embeddings[candidates] @ self.embeddings[current_idx]
        similarities = self.normalized(raw, current_idx)
        base = np.exp(-SIMILARITY_SIGMA * (similarities - target) ** 2)
        penalty = self.history_penalty(candidates, history)
        style = self.style_penalty(candidates, history)
        combined = penalty + STYLE_WEIGHT * style
        score = base * np.exp(-PENALTY_STRENGTH * combined)
        if NOVELTY_PENALTY > 0 and session_plays:
            plays = np.array(
                [session_plays.get(self.ids[index], 0) for index in candidates],
                dtype=np.float32,
            )
            score *= (1.0 + plays) ** (-NOVELTY_PENALTY)
        return score

    def probabilities(
        self,
        current: str,
        history: list[str],
        target: float,
        session_plays: dict[str, int] | None = None,
        force_skip: int = DEFAULT_FORCE_SKIP,
        recent: list[str] | None = None,
    ) -> tuple[dict[str, float], float]:
        history_names = self.prepare_history(history, current)
        pool = self.pool(current, history_names, force_skip, recent)
        scores = self.scores(current, pool, history_names, target, session_plays)
        total = float(scores.sum())
        probabilities = (
            scores / total if total > 0 else np.full(len(pool), 1.0 / len(pool))
        )
        return (
            {self.ids[index]: float(value) for index, value in zip(pool, probabilities)},
            float(probabilities.max()),
        )
