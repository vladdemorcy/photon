#!/usr/bin/env bash
# Builds dist/Photon-Setup-<version>.exe on Linux or macOS (needs Node.js, npm and NSIS's makensis).
#   cd installer && ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$ROOT/build/stage"

echo "Building Photon $VERSION installer"
rm -rf "$ROOT/build" && mkdir -p "$STAGE/app" "$STAGE/service" "$STAGE/installer" "$ROOT/dist"

# The app, with production packages installed fresh (all of them are plain JavaScript,
# so packages installed here run on Windows too).
cp -r "$ROOT/src" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/README.md" "$STAGE/app/"
(cd "$STAGE/app" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error)
if find "$STAGE/app/node_modules" -name '*.node' | grep -q .; then
  echo "A package has a native add-on, which wouldn't run on Windows. Stopping." >&2
  exit 1
fi

# three.js: keep only what the browser loads (the 3D view), drop the rest (~30 MB).
THREE="$STAGE/app/node_modules/three"
KEEP="$(mktemp -d)"
mkdir -p "$KEEP/build" "$KEEP/examples/jsm/controls"
cp "$THREE/package.json" "$THREE/LICENSE" "$KEEP/"
cp "$THREE/build/three.module.js" "$KEEP/build/"
[ -f "$THREE/build/three.core.js" ] && cp "$THREE/build/three.core.js" "$KEEP/build/"
cp "$THREE/examples/jsm/controls/OrbitControls.js" "$KEEP/examples/jsm/controls/"
rm -rf "$THREE" && mv "$KEEP" "$THREE"

# Service wrapper and the installer itself
cp vendor/WinSW.NET461.exe "$STAGE/service/"
cp setup.ps1 "$STAGE/installer/"
cp -r assets "$STAGE/installer/"


# The uninstaller goes into the stage, then Setup.exe packs everything.
makensis -V2 -DVERSION="$VERSION" Uninstall.nsi
makensis -V2 -DVERSION="$VERSION" Setup.nsi

OUT="$ROOT/dist/Photon-Setup-$VERSION.exe"
echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
sha256sum "$OUT" | tee "$OUT.sha256"
