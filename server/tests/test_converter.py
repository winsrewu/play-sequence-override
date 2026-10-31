from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts" / "convert_legacy_music.py"


def run_converter(tmp_path: Path, document: object) -> subprocess.CompletedProcess[str]:
    source = tmp_path / "legacy.json"
    target = tmp_path / "v2.json"
    source.write_text(json.dumps(document), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPT), str(source), str(target), "--generated-at", "2026-10-29T00:00:00Z"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=False,
    )


def test_converter_drops_legacy_metadata(tmp_path: Path) -> None:
    old = {
        "async_time": 123,
        "data": [
            {
                "inner_id": "BBV16y4y127Dz",
                "title": "one",
                "likes": 4,
                "author": "someone",
                "tags": ["tag"],
                "static_tags": ["static"],
                "unknown": True,
            },
            {
                "inner_id": "BBV1Xx4y1277K_2",
                "title": "two",
                "likes": "7",
                "author": "",
                "tags": [],
                "static_tags": [],
            },
        ],
    }
    completed = run_converter(tmp_path, old)
    assert completed.returncode == 0, completed.stderr
    document = json.loads((tmp_path / "v2.json").read_text(encoding="utf-8"))
    assert set(document) == {"format", "version", "generated_at", "tracks"}
    assert document["generated_at"] == "2026-10-29T00:00:00Z"
    assert document["tracks"] == [
        {
            "id": "BBV16y4y127Dz",
            "provider": "bilibili",
            "video_id": "BV16y4y127Dz",
            "page": 1,
            "title": "one",
        },
        {
            "id": "BBV1Xx4y1277K_2",
            "provider": "bilibili",
            "video_id": "BV1Xx4y1277K",
            "page": 2,
            "title": "two",
        },
    ]
    assert "author" not in document["tracks"][0]
    assert "tags" not in document["tracks"][0]


def test_converter_rejects_malformed_ids(tmp_path: Path) -> None:
    completed = run_converter(
        tmp_path, {"data": [{"inner_id": "not-an-id", "title": "x"}]}
    )
    assert completed.returncode == 2
    assert "internal id" in completed.stderr


def test_converter_handles_real_legacy_file(tmp_path: Path) -> None:
    source = ROOT / "examples" / "legacy-music.json"
    target = tmp_path / "music.v2.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(source),
            str(target),
            "--generated-at",
            "2026-10-29T00:00:00Z",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    document = json.loads(target.read_text(encoding="utf-8"))
    assert len(document["tracks"]) == 2072
    assert document["tracks"][0]["id"] == "BBV16y4y127Dz"
    assert "author" not in document["tracks"][0]
