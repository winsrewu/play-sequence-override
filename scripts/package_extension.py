#!/usr/bin/env python3
"""Package the extension for the Microsoft Edge Add-ons store.

The unpacked manifest carries the public ``key`` so loading ``extension/``
unpacked keeps the store id (oacjdflkiecoclphcfdopfoingkhbomm). The store signs
uploads itself, so that field is removed from the published archive.

The version comes from ``VERSION``; bump it and run
``python3 scripts/version.py --write`` first.

    python3 scripts/package_extension.py [--out dist]
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "extension"
VERSION_FILE = ROOT / "VERSION"
STORE_ID = "oacjdflkiecoclphcfdopfoingkhbomm"
PACKAGE_ENTRIES = ("manifest.json", "icons", "src")
ZIP_TIME = (2020, 1, 1, 0, 0, 0)


def crx_id(der: bytes) -> str:
    digest = hashlib.sha256(der).digest()[:16]
    return "".join(chr(97 + (byte >> 4)) + chr(97 + (byte & 0x0F)) for byte in digest)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "dist", help="output directory")
    args = parser.parse_args()

    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    manifest_path = EXTENSION / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if manifest.get("version") != version:
        fail(
            f"manifest version {manifest.get('version')!r} != VERSION {version!r}; "
            "run python3 scripts/version.py --write"
        )
    package = json.loads((EXTENSION / "package.json").read_text(encoding="utf-8"))
    if package.get("version") != version:
        fail(
            f"package.json version {package.get('version')!r} != VERSION {version!r}; "
            "run python3 scripts/version.py --write"
        )

    key = manifest.get("key")
    if not isinstance(key, str) or not key:
        fail("extension/manifest.json has no key; the unpacked store id would change")
    try:
        key_id = crx_id(base64.b64decode(key, validate=True))
    except Exception:
        fail("extension/manifest.json key is not valid base64")
    if key_id != STORE_ID:
        fail(f"manifest key maps to {key_id}, expected {STORE_ID}")

    files = []
    for name in PACKAGE_ENTRIES:
        path = EXTENSION / name
        if path.is_dir():
            files.extend(sorted(item for item in path.rglob("*") if item.is_file()))
        elif path.is_file():
            files.append(path)
        else:
            fail(f"missing {path.relative_to(ROOT)}")

    published = dict(manifest)
    published.pop("key", None)

    args.out.mkdir(parents=True, exist_ok=True)
    archive = args.out / f"play-sequence-override-{version}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for file in files:
            relative = file.relative_to(EXTENSION).as_posix()
            if relative == "manifest.json":
                data = json.dumps(published, indent=2, ensure_ascii=False).encode() + b"\n"
            else:
                data = file.read_bytes()
            info = zipfile.ZipInfo(relative, date_time=ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            bundle.writestr(info, data)

    with zipfile.ZipFile(archive) as check:
        packaged = json.loads(check.read("manifest.json"))
        if "key" in packaged:
            fail("published manifest still contains key")
        if packaged.get("version") != version:
            fail("published manifest version does not match VERSION")

    print(f"wrote {archive.relative_to(ROOT)} ({len(files)} files, version {version}, key removed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
