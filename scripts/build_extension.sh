#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD="$ROOT/build/extension"
PYTHON=${PYTHON:-python3}

rm -rf "$BUILD"
mkdir -p "$(dirname "$BUILD")"
cp -a "$ROOT/extension" "$BUILD"
rm -rf "$BUILD/data"
mkdir -p "$BUILD/data"
cp "$ROOT/LICENSE" "$BUILD/LICENSE"
cp "$ROOT/THIRD_PARTY_NOTICES.md" "$BUILD/THIRD_PARTY_NOTICES.md"
"$PYTHON" "$ROOT/scripts/build_extension_data.py" --out "$BUILD/data"
