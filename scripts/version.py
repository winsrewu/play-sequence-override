#!/usr/bin/env python3
"""Single source of truth for the release version.

The version lives in VERSION. The plugin manifests and the Docker image label
are derived from it, and CI refuses to tag or build when they disagree.

    python3 scripts/version.py           # print the version
    python3 scripts/version.py --check   # exit 1 when a derived file is stale
    python3 scripts/version.py --write   # rewrite the derived files
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = ROOT / "VERSION"

# Files that must carry the global version.
SYNCED_FILES = (
    ROOT / "extension" / "manifest.json",
    ROOT / "extension" / "package.json",
)

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def read_version() -> str:
    text = VERSION_FILE.read_text(encoding="utf-8").strip()
    if not SEMVER.fullmatch(text):
        raise SystemExit(f"VERSION must look like 1.2.3, got {text!r}")
    return text


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def render(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def stale_files(version: str) -> list[Path]:
    return [path for path in SYNCED_FILES if load(path).get("version") != version]


def main(argv: list[str]) -> int:
    version = read_version()
    if not argv:
        print(version)
        return 0
    if argv == ["--check"]:
        stale = stale_files(version)
        for path in stale:
            print(
                f"{path.relative_to(ROOT)} has version "
                f"{load(path).get('version')!r}, expected {version!r}",
                file=sys.stderr,
            )
        if stale:
            print("run: python3 scripts/version.py --write", file=sys.stderr)
        return 1 if stale else 0
    if argv == ["--write"]:
        for path in SYNCED_FILES:
            document = load(path)
            if document.get("version") == version:
                continue
            document["version"] = version
            path.write_text(render(document), encoding="utf-8")
            print(f"updated {path.relative_to(ROOT)} to {version}")
        return 0
    print("usage: version.py [--check|--write]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
