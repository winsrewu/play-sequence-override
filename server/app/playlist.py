# Strict v2 playlist. Canonical id is B<BVID> with an optional _<page> suffix.
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

FORMAT = "jawbts.music-playlist"
VERSION = 2

PROVIDER_BILIBILI = "bilibili"
PROVIDER_LETTERS = {PROVIDER_BILIBILI: "B"}
LETTER_PROVIDERS = {letter: provider for provider, letter in PROVIDER_LETTERS.items()}

_ID_RE = re.compile(
    r"^(?P<letter>[A-Z])(?P<video>[0-9A-Za-z]{12})(?:_(?P<page>[1-9][0-9]{0,3}))?$"
)
_BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")

_TRACK_KEYS = {
    "id",
    "provider",
    "video_id",
    "page",
    "title",
}


class PlaylistError(ValueError):
    pass


@dataclass(frozen=True)
class InternalId:
    provider: str
    video_id: str
    page: int
    value: str


def parse_internal_id(value: str) -> InternalId:
    if not isinstance(value, str):
        raise PlaylistError("internal id must be a string")
    raw = value.strip()
    match = _ID_RE.match(raw)
    if not match:
        raise PlaylistError(
            "internal id must look like B + BVID, optionally with _<page> "
            f"(got {value!r})"
        )
    letter = match.group("letter")
    provider = LETTER_PROVIDERS.get(letter)
    if provider is None:
        raise PlaylistError(f"unsupported provider letter {letter!r}")
    video_id = match.group("video")
    if not _BVID_RE.match(video_id):
        raise PlaylistError(f"invalid Bilibili BVID {video_id!r}")
    page = int(match.group("page") or 1)
    canonical = build_internal_id(provider, video_id, page)
    if canonical != raw:
        raise PlaylistError(
            f"internal id is not canonical: expected {canonical!r}, got {value!r}"
        )
    return InternalId(provider=provider, video_id=video_id, page=page, value=canonical)


def build_internal_id(provider: str, video_id: str, page: int = 1) -> str:
    if provider not in PROVIDER_LETTERS:
        raise PlaylistError(f"unsupported provider {provider!r}")
    if not isinstance(video_id, str) or not _BVID_RE.match(video_id):
        raise PlaylistError(f"invalid Bilibili BVID {video_id!r}")
    if not isinstance(page, int) or page < 1:
        raise PlaylistError("page must be a positive integer")
    suffix = f"_{page}" if page > 1 else ""
    return f"{PROVIDER_LETTERS[provider]}{video_id}{suffix}"


def _int(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise PlaylistError(f"expected an integer, got {value!r}") from exc


def _require_object(raw: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(raw, Mapping):
        raise PlaylistError(f"{label} must be a JSON object")
    return raw


@dataclass
class Track:
    id: str
    provider: str
    video_id: str
    page: int = 1
    title: str = ""

    @property
    def internal_id(self) -> InternalId:
        return InternalId(self.provider, self.video_id, self.page, self.id)

    def to_v2(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "provider": self.provider,
            "video_id": self.video_id,
            "page": self.page,
            "title": self.title,
        }


def track_from_entry(raw: Any) -> Track:
    entry = _require_object(raw, "each track")
    unknown = set(entry) - _TRACK_KEYS
    if unknown:
        raise PlaylistError("unexpected track field(s): " + ", ".join(sorted(unknown)))
    if "id" not in entry:
        raise PlaylistError("track is missing id")

    internal = parse_internal_id(str(entry["id"]))

    provider = str(entry.get("provider", "")).lower()
    if provider == "b":
        provider = PROVIDER_BILIBILI
    if provider != internal.provider:
        raise PlaylistError(
            f"provider {entry.get('provider')!r} conflicts with internal id {internal.value!r}"
        )

    video_id = str(entry.get("video_id", ""))
    if video_id != internal.video_id:
        raise PlaylistError(
            f"video_id {entry.get('video_id')!r} conflicts with internal id {internal.value!r}"
        )

    page = _int(entry.get("page"), 0)
    if page != internal.page:
        raise PlaylistError(
            f"page {entry.get('page')!r} conflicts with internal id {internal.value!r}"
        )

    return Track(
        id=internal.value,
        provider=internal.provider,
        video_id=internal.video_id,
        page=internal.page,
        title=str(entry.get("title") or ""),
    )


@dataclass
class Playlist:
    tracks: list[Track]
    generated_at: str | None = None

    def __post_init__(self) -> None:
        seen: set[str] = set()
        for track in self.tracks:
            if track.id in seen:
                raise PlaylistError(f"duplicate internal id {track.id!r}")
            seen.add(track.id)

    def __len__(self) -> int:
        return len(self.tracks)

    def ids(self) -> set[str]:
        return {track.id for track in self.tracks}

    def to_v2(self, generated_at: str | None = None) -> dict[str, Any]:
        return {
            "format": FORMAT,
            "version": VERSION,
            "generated_at": generated_at or self.generated_at or _utc_now(),
            "tracks": [track.to_v2() for track in self.tracks],
        }


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def parse_playlist(document: Any) -> Playlist:
    root = _require_object(document, "playlist root")
    unknown = set(root) - {"format", "version", "generated_at", "tracks"}
    if unknown:
        raise PlaylistError("unexpected playlist field(s): " + ", ".join(sorted(unknown)))
    if root.get("format") != FORMAT:
        raise PlaylistError(f"unsupported playlist format {root.get('format')!r}")
    version = _int(root.get("version"), 0)
    if version != VERSION:
        raise PlaylistError(
            f"unsupported playlist version {version}; this build reads v{VERSION}"
        )
    entries = root.get("tracks")
    if not isinstance(entries, list):
        raise PlaylistError("v2 playlist is missing a tracks array")
    return Playlist(
        tracks=[track_from_entry(item) for item in entries],
        generated_at=(
            str(root["generated_at"]) if root.get("generated_at") is not None else None
        ),
    )


def load_playlist(path: str | Path) -> Playlist:
    source = Path(path)
    try:
        with source.open("r", encoding="utf-8") as handle:
            document = json.load(handle)
    except OSError as exc:
        raise PlaylistError(f"cannot read {source}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PlaylistError(f"{source} is not valid JSON: {exc}") from exc
    return parse_playlist(document)


def dump_playlist(
    playlist: Playlist,
    path: str | Path,
    *,
    generated_at: str | None = None,
) -> Path:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(
            playlist.to_v2(generated_at=generated_at),
            handle,
            ensure_ascii=False,
            indent=2,
        )
        handle.write("\n")
    return destination


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.playlist",
        description="Validate or summarise a Jawbts v2 music playlist.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect = sub.add_parser("inspect", help="print a summary of a playlist")
    inspect.add_argument("input")

    validate = sub.add_parser("validate", help="validate a playlist (exit 0/2)")
    validate.add_argument("input")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        playlist = load_playlist(args.input)
    except PlaylistError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.command == "validate":
        print(f"ok: {len(playlist)} tracks")
        return 0

    providers: dict[str, int] = {}
    pages = 0
    for track in playlist.tracks:
        providers[track.provider] = providers.get(track.provider, 0) + 1
        if track.page > 1:
            pages += 1
    print(f"tracks      {len(playlist)}")
    print(f"providers   {providers}")
    print(f"multi-page  {pages}")
    print(f"first       {playlist.tracks[0].id if playlist.tracks else '-'}")
    print(f"last        {playlist.tracks[-1].id if playlist.tracks else '-'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
