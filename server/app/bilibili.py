# DASH download. Long tracks use a byte Range, trimmed to a complete mdat, then ffmpeg decodes the window.
from __future__ import annotations

import hashlib
import json
import logging
import re
import struct
import subprocess
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from .config import Settings
from .errors import (
    ApiError,
    AudioDecodeError,
    AudioTooLarge,
    InvalidAudioFormat,
    InvalidRequest,
    RangeNotSupported,
    UpstreamError,
    UpstreamTimeout,
    UnsupportedProvider,
    VideoUnavailable,
)
from .playlist import InternalId, PlaylistError, parse_internal_id

LOGGER = logging.getLogger(__name__)

PLAYINFO_RE = re.compile(
    r"<script>\s*window\.__playinfo__\s*=\s*(.*?)\s*</script>", re.DOTALL
)

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]


@dataclass(frozen=True)
class AudioSource:
    url: str
    headers: dict[str, str]
    mime_type: str | None
    bandwidth: int | None
    duration_seconds: float | None
    kind: str


@dataclass(frozen=True)
class DownloadResult:
    bytes_written: int
    partial: bool
    total_bytes: int | None
    requested_bytes: int | None


def parse_target(internal_id: str) -> InternalId:
    try:
        target = parse_internal_id(internal_id)
    except PlaylistError as exc:
        raise InvalidRequest(str(exc)) from exc
    if target.provider != "bilibili":
        raise UnsupportedProvider(
            f"provider {target.provider!r} is not supported; this build only handles Bilibili"
        )
    return target


def _mixin_key(raw: str) -> str:
    return "".join(raw[index] for index in MIXIN_KEY_ENC_TAB if index < len(raw))


def _md5(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def _duration_seconds(data: dict[str, Any]) -> float | None:
    dash = data.get("dash")
    if isinstance(dash, dict):
        duration = dash.get("duration")
        try:
            if duration is not None and float(duration) > 0:
                return float(duration)
        except (TypeError, ValueError):
            pass
    timelength = data.get("timelength")
    try:
        if timelength is not None and float(timelength) > 0:
            return float(timelength) / 1000.0
    except (TypeError, ValueError):
        pass
    return None


def _best_dash_audio(
    payload: dict[str, Any],
) -> tuple[str, str | None, int | None, float | None] | None:
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        return None
    dash = data.get("dash") or {}
    audios = dash.get("audio") if isinstance(dash, dict) else None
    if not isinstance(audios, list) or not audios:
        return None

    def bandwidth(item: Any) -> int:
        try:
            return int(item.get("bandwidth") or 0)
        except (TypeError, ValueError):
            return 0

    best = max(audios, key=bandwidth)
    url = best.get("baseUrl") or best.get("base_url")
    if not url:
        backups = best.get("backupUrl") or best.get("backup_url") or []
        if isinstance(backups, list) and backups:
            url = backups[0]
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return None
    mime = best.get("mimeType") or best.get("mime_type")
    return url, (str(mime) if mime else None), bandwidth(best), _duration_seconds(data)


def extract_audio(
    payload: dict[str, Any],
) -> tuple[str, str | None, int | None, float | None, str] | None:
    dash = _best_dash_audio(payload)
    if dash:
        url, mime, bandwidth, duration = dash
        return url, mime, bandwidth, duration, "dash"

    data = payload.get("data") or {}
    if not isinstance(data, dict):
        return None
    durl = data.get("durl")
    if isinstance(durl, list) and durl:
        first = durl[0]
        url = first.get("url") if isinstance(first, dict) else None
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            return url, None, None, _duration_seconds(data), "durl"
    return None


class BilibiliClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.Client(
            timeout=httpx.Timeout(
                connect=min(10, settings.http_timeout_seconds),
                read=settings.http_timeout_seconds,
                write=settings.http_timeout_seconds,
                pool=10,
            ),
            follow_redirects=True,
            trust_env=settings.trust_env_proxy,
            headers={"User-Agent": settings.bilibili_user_agent},
        )

    def close(self) -> None:
        self._client.close()


    def resolve(self, target: InternalId) -> AudioSource:
        page_url = f"https://www.bilibili.com/video/{target.video_id}"
        if target.page > 1:
            page_url += f"?p={target.page}"

        page_error: Exception | None = None
        try:
            response = self._client.get(page_url)
            if response.status_code == 200:
                match = PLAYINFO_RE.search(response.text)
                if match:
                    try:
                        payload = json.loads(match.group(1))
                    except ValueError:
                        payload = None
                    extracted = extract_audio(payload) if isinstance(payload, dict) else None
                    if extracted:
                        url, mime, bandwidth, duration, kind = extracted
                        return AudioSource(
                            url=url,
                            headers=self._media_headers(page_url),
                            mime_type=mime,
                            bandwidth=bandwidth,
                            duration_seconds=duration,
                            kind=kind,
                        )
                LOGGER.info("no usable __playinfo__ for %s; using WBI fallback", target.value)
            else:
                page_error = UpstreamError(
                    f"video page returned HTTP {response.status_code}"
                )
        except httpx.TimeoutException as exc:
            page_error = exc
        except httpx.HTTPError as exc:
            page_error = exc

        try:
            return self._resolve_via_wbi(target, page_url)
        except (VideoUnavailable, UnsupportedProvider, InvalidRequest):
            raise
        except Exception as exc:
            if isinstance(page_error, Exception):
                LOGGER.warning(
                    "page path failed (%s); WBI fallback failed (%s)",
                    page_error,
                    exc,
                )
            raise

    def _media_headers(self, referer: str) -> dict[str, str]:
        return {
            "User-Agent": self._settings.bilibili_user_agent,
            "Referer": referer,
            "Origin": "https://www.bilibili.com",
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        }

    def _api_headers(self, referer: str) -> dict[str, str]:
        return {
            "User-Agent": self._settings.bilibili_user_agent,
            "Referer": referer,
        }

    def _get_json(self, url: str, *, headers: dict[str, str]) -> dict[str, Any]:
        try:
            response = self._client.get(url, headers=headers)
        except httpx.TimeoutException as exc:
            raise UpstreamTimeout() from exc
        except httpx.HTTPError as exc:
            raise UpstreamError(f"Bilibili request failed: {exc}") from exc
        if response.status_code >= 500:
            raise UpstreamError(f"Bilibili returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise UpstreamError("Bilibili returned a non-JSON response") from exc
        if not isinstance(payload, dict):
            raise UpstreamError("Bilibili returned an unexpected response")
        return payload

    def _resolve_via_wbi(self, target: InternalId, referer: str) -> AudioSource:
        headers = self._api_headers(referer)

        page_list = self._get_json(
            f"https://api.bilibili.com/x/player/pagelist?bvid={target.video_id}",
            headers=headers,
        )
        if page_list.get("code") != 0:
            message = str(page_list.get("message") or "unknown error")
            if page_list.get("code") in {-404, -403, 62002, 62012}:
                raise VideoUnavailable(f"video is unavailable: {message}")
            raise UpstreamError(f"pagelist failed: {message}")

        pages = page_list.get("data")
        if not isinstance(pages, list) or not pages:
            raise VideoUnavailable("video has no playable pages")
        if target.page > len(pages):
            raise VideoUnavailable(
                f"video has {len(pages)} page(s); requested page {target.page}"
            )
        cid = pages[target.page - 1].get("cid")
        if not isinstance(cid, (int, str)):
            raise UpstreamError("pagelist did not return a cid")

        nav = self._get_json(
            "https://api.bilibili.com/x/web-interface/nav", headers=headers
        )
        data = nav.get("data")
        wbi = data.get("wbi_img") if isinstance(data, dict) else None
        if not isinstance(wbi, dict):
            raise UpstreamError("Bilibili nav did not return WBI keys")
        img_url = str(wbi.get("img_url") or "")
        sub_url = str(wbi.get("sub_url") or "")
        try:
            img_key = img_url.rsplit("/", 1)[1].split(".", 1)[0]
            sub_key = sub_url.rsplit("/", 1)[1].split(".", 1)[0]
        except IndexError as exc:
            raise UpstreamError("Bilibili nav returned malformed WBI keys") from exc
        mixin_key = _mixin_key(img_key + sub_key)
        if not mixin_key:
            raise UpstreamError("Bilibili WBI mixin key was empty")

        params = [
            ("bvid", target.video_id),
            ("cid", str(cid)),
            ("qn", "0"),
            ("fnver", "0"),
            ("fnval", "4048"),
            ("fourk", "1"),
            ("gaia_source", ""),
            ("from_client", "BROWSER"),
            ("voice_balance", "1"),
            ("web_location", "1315873"),
            ("wts", str(int(time.time()))),
        ]
        query = urlencode(params)
        signed = f"{query}&w_rid={_md5(query + mixin_key)}"
        payload = self._get_json(
            f"https://api.bilibili.com/x/player/playurl?{signed}", headers=headers
        )
        if payload.get("code") != 0:
            message = str(payload.get("message") or "unknown error")
            if payload.get("code") in {-404, -403, 62002, 62012}:
                raise VideoUnavailable(f"video is unavailable: {message}")
            raise UpstreamError(f"playurl failed: {message}")

        extracted = extract_audio(payload)
        if not extracted:
            raise UpstreamError("playurl returned no audio track")
        url, mime, bandwidth, duration, kind = extracted
        return AudioSource(
            url=url,
            headers=self._media_headers(referer),
            mime_type=mime,
            bandwidth=bandwidth,
            duration_seconds=duration,
            kind=kind,
        )


    def download(
        self, source: AudioSource, destination: Path, *, force_full: bool = False
    ) -> DownloadResult:
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                return self._download_once(
                    source, destination, force_full=force_full
                )
            except ApiError:
                raise
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                last_error = exc
                if status in {403, 429} or status >= 500:
                    if attempt == 0:
                        time.sleep(1.0)
                        continue
                raise UpstreamError(f"audio download returned HTTP {status}") from exc
            except httpx.HTTPError as exc:
                last_error = exc
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                raise UpstreamError(f"audio download failed: {exc}") from exc
        raise UpstreamError(f"audio download failed: {last_error}")

    def _download_once(
        self, source: AudioSource, destination: Path, *, force_full: bool
    ) -> DownloadResult:
        limit = self._settings.max_audio_bytes
        requested_bytes = (
            None
            if force_full
            else estimate_range_bytes(source, self._settings.max_duration_seconds)
        )
        if requested_bytes is not None:
            requested_bytes = min(requested_bytes, limit)

        headers = dict(source.headers)
        headers["Accept-Encoding"] = "identity"
        if requested_bytes is not None:
            headers["Range"] = f"bytes=0-{requested_bytes - 1}"

        timeout = httpx.Timeout(
            connect=min(10, self._settings.http_timeout_seconds),
            read=max(30, self._settings.download_timeout_seconds),
            write=30,
            pool=10,
        )
        written = 0
        with self._client.stream(
            "GET", source.url, headers=headers, timeout=timeout
        ) as response:
            if response.status_code not in {200, 206}:
                raise httpx.HTTPStatusError(
                    f"audio download returned HTTP {response.status_code}",
                    request=response.request,
                    response=response,
                )

            partial = response.status_code == 206
            if requested_bytes is not None and not partial:
                raise RangeNotSupported(
                    "Bilibili ignored the Range request; refusing to download the full track"
                )

            content_range = response.headers.get("content-range")
            total_bytes: int | None = None
            if partial:
                if not content_range:
                    raise RangeNotSupported(
                        "Bilibili returned 206 without a Content-Range header"
                    )
                match = re.match(
                    r"bytes\s+(\d+)-(\d+)/(\d+|\*)", content_range.strip()
                )
                if not match:
                    raise RangeNotSupported(
                        f"Bilibili returned an unusable Content-Range: {content_range!r}"
                    )
                if int(match.group(1)) != 0:
                    raise RangeNotSupported(
                        "Bilibili returned a range that does not start at byte 0"
                    )
                if match.group(3) != "*":
                    total_bytes = int(match.group(3))

            declared = response.headers.get("content-length")
            if declared and declared.isdigit():
                declared_size = int(declared)
                if declared_size > limit:
                    raise AudioTooLarge(
                        f"audio response is larger than the {limit} byte limit"
                    )
                if total_bytes is None and not partial:
                    total_bytes = declared_size

            with destination.open("wb") as handle:
                for chunk in response.iter_bytes(chunk_size=256 * 1024):
                    written += len(chunk)
                    if written > limit:
                        raise AudioTooLarge(
                            f"audio exceeded the {limit} byte limit while downloading"
                        )
                    handle.write(chunk)

        if written == 0:
            raise UpstreamError("audio download was empty")

        if partial:
            _validate_and_trim_fragmented_mp4(destination)
            written = destination.stat().st_size
            if total_bytes is not None and written >= total_bytes:
                partial = False

        return DownloadResult(
            bytes_written=written,
            partial=partial,
            total_bytes=total_bytes,
            requested_bytes=requested_bytes,
        )


def estimate_range_bytes(source: AudioSource, max_duration_seconds: int) -> int | None:
    if source.kind != "dash" or not source.bandwidth or not source.duration_seconds:
        return None
    if source.duration_seconds <= max_duration_seconds + 1:
        return None
    if source.bandwidth <= 0:
        return None
    target = min(float(max_duration_seconds), source.duration_seconds)
    estimated = int(source.bandwidth * target / 8.0 * 1.08) + 128 * 1024
    return max(estimated, 512 * 1024)


def _top_level_boxes(path: Path) -> list[tuple[str, int, int]]:
    size = path.stat().st_size
    boxes: list[tuple[str, int, int]] = []
    with path.open("rb") as handle:
        offset = 0
        while offset + 8 <= size:
            handle.seek(offset)
            header = handle.read(16)
            if len(header) < 8:
                break
            box_size = struct.unpack(">I", header[:4])[0]
            box_type = header[4:8].decode("latin1", "replace")
            header_size = 8
            if box_size == 1:
                if len(header) < 16:
                    break
                box_size = struct.unpack(">Q", header[8:16])[0]
                header_size = 16
            elif box_size == 0:
                box_size = size - offset
            if box_size < header_size or offset + box_size > size:
                break
            boxes.append((box_type, offset, offset + box_size))
            offset += box_size
    return boxes


def _validate_and_trim_fragmented_mp4(path: Path) -> None:
    boxes = _top_level_boxes(path)
    types = [box[0] for box in boxes]
    if not types or types[0] != "ftyp":
        raise InvalidAudioFormat(
            "Bilibili returned an audio container without an ftyp box"
        )
    if "moov" not in types or "moof" not in types or "mdat" not in types:
        raise InvalidAudioFormat(
            "Bilibili returned audio that is not fragmented MP4; refusing a partial decode"
        )
    mdat_ends = [end for box_type, _start, end in boxes if box_type == "mdat"]
    if not mdat_ends:
        raise InvalidAudioFormat("Bilibili audio has no complete mdat fragment")
    complete_end = mdat_ends[-1]
    if complete_end < 1024:
        raise InvalidAudioFormat("Bilibili audio range was too small to decode")
    if complete_end < path.stat().st_size:
        with path.open("r+b") as handle:
            handle.truncate(complete_end)


def wav_duration_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate()
    except (wave.Error, OSError) as exc:
        raise AudioDecodeError(f"could not read the decoded WAV header: {exc}") from exc
    if frames <= 0 or rate <= 0:
        raise AudioDecodeError("decoded WAV has no audio frames")
    return frames / float(rate)


def decode_to_wav(
    source: Path,
    destination: Path,
    *,
    ffmpeg_bin: str,
    max_duration_seconds: int,
    timeout_seconds: int = 300,
) -> None:
    command = [
        ffmpeg_bin,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-map",
        "0:a:0?",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "32000",
        "-t",
        str(max_duration_seconds),
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AudioDecodeError(
            f"ffmpeg was not found ({ffmpeg_bin!r}); install ffmpeg in the image"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise AudioDecodeError("ffmpeg timed out while decoding the audio") from exc

    if completed.returncode != 0 or not destination.is_file():
        detail = (completed.stderr or b"").decode("utf-8", "replace").strip()
        detail = detail[-500:] if detail else "no ffmpeg diagnostics"
        raise AudioDecodeError(f"ffmpeg could not decode the audio: {detail}")
    if destination.stat().st_size <= 44:
        raise AudioDecodeError("ffmpeg produced an empty WAV file")


def probe_page(internal_id: str, settings: Settings) -> AudioSource:
    target = parse_target(internal_id)
    client = BilibiliClient(settings)
    try:
        return client.resolve(target)
    finally:
        client.close()


def describe(source: AudioSource) -> str:
    return (
        f"{source.kind} mime={source.mime_type or '?'} "
        f"bandwidth={source.bandwidth or '?'}"
    )
