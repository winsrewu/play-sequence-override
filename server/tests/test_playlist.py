from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.playlist import (
    Playlist,
    PlaylistError,
    Track,
    build_internal_id,
    dump_playlist,
    load_playlist,
    parse_internal_id,
    parse_playlist,
)

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "music.v2.json"


def test_parse_internal_id() -> None:
    first = parse_internal_id("BBV16y4y127Dz")
    assert first.provider == "bilibili"
    assert first.video_id == "BV16y4y127Dz"
    assert first.page == 1
    assert first.value == "BBV16y4y127Dz"

    second = parse_internal_id("BBV1Xx4y1277K_2")
    assert second.page == 2
    assert second.value == "BBV1Xx4y1277K_2"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "BV16y4y127Dz",  # missing provider letter
        "BBCV16y4y127Dz",
        "BBV16y4y127D",  # too short
        "BBV16y4y127Dz_0",
        "BBV16y4y127Dz_02",
        "CBV16y4y127Dz",
    ],
)
def test_reject_invalid_internal_id(value: str) -> None:
    with pytest.raises(PlaylistError):
        parse_internal_id(value)


def test_build_internal_id() -> None:
    assert build_internal_id("bilibili", "BV16y4y127Dz") == "BBV16y4y127Dz"
    assert build_internal_id("bilibili", "BV16y4y127Dz", 3) == "BBV16y4y127Dz_3"
    with pytest.raises(PlaylistError):
        build_internal_id("bilibili", "BV16y4y127Dz", 0)


def test_real_v2_catalog() -> None:
    playlist = load_playlist(CATALOG)
    assert len(playlist) == 2072
    assert sum(1 for track in playlist.tracks if track.page > 1) == 302
    assert playlist.tracks[0].id == "BBV16y4y127Dz"
    assert playlist.tracks[0].title.startswith("【完结】图书馆音乐")
    assert not hasattr(playlist.tracks[0], "author")
    assert not hasattr(playlist.tracks[0], "tags")


def test_v2_dump_round_trip(tmp_path: Path) -> None:
    playlist = load_playlist(CATALOG)
    path = dump_playlist(
        playlist, tmp_path / "copy.json", generated_at="2026-10-29T00:00:00Z"
    )
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["format"] == "jawbts.music-playlist"
    assert document["version"] == 2
    assert document["generated_at"] == "2026-10-29T00:00:00Z"
    assert set(document["tracks"][0]) == {
        "id",
        "provider",
        "video_id",
        "page",
        "title",
    }
    assert load_playlist(path).to_v2(generated_at="2026-10-29T00:00:00Z") == document


def test_legacy_shape_is_rejected() -> None:
    with pytest.raises(PlaylistError, match="unexpected playlist field"):
        parse_playlist({"async_time": 1, "data": []})
    with pytest.raises(PlaylistError, match="root must be a JSON object"):
        parse_playlist([{"inner_id": "BBV16y4y127Dz"}])


def test_duplicate_ids_are_rejected() -> None:
    entry = {
        "id": "BBV16y4y127Dz",
        "provider": "bilibili",
        "video_id": "BV16y4y127Dz",
        "page": 1,
        "title": "t",
    }
    with pytest.raises(PlaylistError, match="duplicate"):
        parse_playlist(
            {"format": "jawbts.music-playlist", "version": 2, "tracks": [entry, entry]}
        )


def test_conflicting_metadata_is_rejected() -> None:
    with pytest.raises(PlaylistError, match="conflicts"):
        parse_playlist(
            {
                "format": "jawbts.music-playlist",
                "version": 2,
                "tracks": [
                    {
                        "id": "BBV16y4y127Dz",
                        "provider": "bilibili",
                        "video_id": "BV1AA411p7zs",
                        "page": 1,
                        "title": "t",
                    }
                ],
            }
        )


def test_unknown_fields_are_rejected() -> None:
    with pytest.raises(PlaylistError, match="unexpected track field"):
        parse_playlist(
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
                        "author": "x",
                    }
                ],
            }
        )
    with pytest.raises(PlaylistError, match="unexpected playlist field"):
        parse_playlist(
            {"format": "jawbts.music-playlist", "version": 2, "tracks": [], "extra": True}
        )


def test_unknown_format_is_rejected() -> None:
    with pytest.raises(PlaylistError, match="unsupported playlist format"):
        parse_playlist({"format": "something-else", "version": 2, "tracks": []})


def test_empty_playlist() -> None:
    playlist = Playlist(tracks=[])
    assert len(playlist) == 0
    assert playlist.to_v2()["tracks"] == []


def test_track_to_v2_is_minimal() -> None:
    track = Track(
        id="BBV16y4y127Dz",
        provider="bilibili",
        video_id="BV16y4y127Dz",
        title="t",
    )
    assert track.to_v2() == {
        "id": "BBV16y4y127Dz",
        "provider": "bilibili",
        "video_id": "BV16y4y127Dz",
        "page": 1,
        "title": "t",
    }
