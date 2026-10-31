#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from app.playlist import (  # noqa: E402
    Playlist,
    PlaylistError,
    Track,
    dump_playlist,
    parse_internal_id,
)


def convert(document: object) -> Playlist:
    if not isinstance(document, dict):
        raise PlaylistError("legacy music.json root must be an object")
    entries = document.get("data")
    if not isinstance(entries, list):
        raise PlaylistError('legacy music.json must contain a "data" array')

    tracks: list[Track] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise PlaylistError(f"data[{index}] is not an object")
        inner_id = entry.get("inner_id")
        if not isinstance(inner_id, str) or not inner_id:
            raise PlaylistError(f"data[{index}] is missing inner_id")
        try:
            internal = parse_internal_id(inner_id)
        except PlaylistError as exc:
            raise PlaylistError(f"data[{index}]: {exc}") from exc

        tracks.append(
            Track(
                id=internal.value,
                provider=internal.provider,
                video_id=internal.video_id,
                page=internal.page,
                title=str(entry.get("title") or ""),
            )
        )
    return Playlist(tracks=tracks)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="old music.json")
    parser.add_argument("output", type=Path, help="new v2 playlist")
    parser.add_argument(
        "--generated-at",
        default=None,
        help="override generated_at (default: current UTC time)",
    )
    args = parser.parse_args()

    try:
        document = json.loads(args.input.read_text(encoding="utf-8"))
        playlist = convert(document)
    except (OSError, json.JSONDecodeError, PlaylistError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    stamp = args.generated_at or (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    destination = dump_playlist(playlist, args.output, generated_at=stamp)
    multi_page = sum(1 for track in playlist.tracks if track.page > 1)
    dropped = sum(
        1
        for entry in document["data"]
        if entry.get("author")
        or entry.get("tags")
        or entry.get("static_tags")
        or entry.get("likes")
    )
    print(f"read   {len(document['data'])} legacy entries")
    print(f"wrote  {len(playlist)} v2 tracks ({multi_page} multi-page) to {destination}")
    print(f"dropped author/tags/static_tags/likes from {dropped} entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
