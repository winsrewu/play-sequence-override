from __future__ import annotations

from app.vad import verdict_from_result


def test_singing_above_the_threshold_means_lyrics() -> None:
    result = {
        "event2ratio": {"singing": 0.42},
        "event2timestamps": {"singing": [(1.0, 4.5), (10.0, 12.0)]},
    }
    verdict = verdict_from_result(result, 0.1)
    assert verdict.has_lyrics is True
    assert verdict.singing_ratio == 0.42
    assert verdict.singing_seconds == 5.5
    assert verdict.segments == 2
    assert verdict.threshold == 0.1
    assert verdict.speech_ratio == 0.0


def test_spoken_lyrics_count_too() -> None:
    result = {"event2ratio": {"speech": 0.4}, "event2timestamps": {"singing": []}}
    verdict = verdict_from_result(result, 0.1)
    assert verdict.has_lyrics is True
    assert verdict.speech_ratio == 0.4
    assert verdict.singing_ratio == 0.0


def test_no_singing_or_missing_fields_is_instrumental() -> None:
    empty = verdict_from_result({}, 0.1)
    assert empty.has_lyrics is False
    assert empty.singing_ratio == 0.0
    assert empty.singing_seconds == 0.0
    assert empty.segments == 0
    assert verdict_from_result({"event2ratio": {"singing": 0.0}}, 0.0).has_lyrics is True


def test_threshold_is_clamped_and_ratio_bounded() -> None:
    result = {"event2ratio": {"singing": 1.4}, "event2timestamps": {"singing": []}}
    verdict = verdict_from_result(result, 5.0)
    assert verdict.threshold == 1.0
    assert verdict.singing_ratio == 1.0
    assert verdict.has_lyrics is True
    assert verdict_from_result({"event2ratio": {"singing": -0.2}}, -1.0).singing_ratio == 0.0
