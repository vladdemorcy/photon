#!/usr/bin/env bash
# Builds dist/Photon-<version>.pkg, the macOS installer, on Linux or macOS.
# Needs Node.js and npm, Python 3, plus xar and mkbom (bomutils). On a Mac it uses Apple's own
# pkgbuild and productbuild instead, which come with macOS.
#   cd installer/mac && ./build-mac.sh
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
ROOT="$(cd ../.. && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
WORK="$ROOT/build/mac"
OUT="$ROOT/dist/Photon-$VERSION.pkg"
ID=com.photon.server.pkg

echo "Building Photon $VERSION for Mac"
rm -rf "$WORK" && mkdir -p "$WORK/root/Library/Photon" "$WORK/flat/Resources" "$WORK/flat/photon.pkg" "$ROOT/dist"
LIB="$WORK/root/Library/Photon"

# The app, with production packages (all plain JavaScript, so they run on any Mac).
mkdir -p "$LIB/app"
cp -r "$ROOT/src" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/README.md" "$ROOT/LICENSE" "$ROOT/THIRD-PARTY-NOTICES.md" "$ROOT/licenses" "$LIB/app/"
(cd "$LIB/app" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error)
if find "$LIB/app/node_modules" -name '*.node' | grep -q .; then echo "A package has a native add-on. Stopping." >&2; exit 1; fi
THREE="$LIB/app/node_modules/three"; KEEP="$(mktemp -d)"
mkdir -p "$KEEP/build" "$KEEP/examples/jsm/controls"
cp "$THREE/package.json" "$THREE/LICENSE" "$KEEP/"; cp "$THREE/build/three.module.js" "$KEEP/build/"
[ -f "$THREE/build/three.core.js" ] && cp "$THREE/build/three.core.js" "$KEEP/build/"
cp "$THREE/examples/jsm/controls/OrbitControls.js" "$KEEP/examples/jsm/controls/"
rm -rf "$THREE" && mv "$KEEP" "$THREE"

# Launcher apps, the icon and the uninstaller. postinstall copies the apps into Applications.
mkdir -p "$LIB/support"
cp -R "support/Photon.app" "support/Uninstall Photon.app" "$LIB/support/"
for app in "$LIB/support/"*.app; do
  mkdir -p "$app/Contents/Resources"   # empty in git, which doesn't keep empty folders
  cp support/photon.icns "$app/Contents/Resources/photon.icns"
  sed -i.bak "s/__VERSION__/$VERSION/g" "$app/Contents/Info.plist" && rm -f "$app/Contents/Info.plist.bak"
done
cp support/photon.icns "$LIB/photon.icns"
cp support/uninstall.sh "$LIB/uninstall.sh"

# Ownership and modes as they should land on the Mac.
find "$WORK/root" -type d -exec chmod 755 {} +
find "$WORK/root" -type f -exec chmod 644 {} +
chmod 755 "$LIB/uninstall.sh" "$LIB/support/"*.app/Contents/MacOS/*

# Component package: Payload, Bom, Scripts, PackageInfo.
PKG="$WORK/flat/photon.pkg"
python3 "$HERE/mkcpio.py" "$WORK/root" "$PKG/Payload"
mkdir -p "$WORK/scripts" && cp scripts/preinstall scripts/postinstall "$WORK/scripts/" && chmod 755 "$WORK/scripts/"*
python3 "$HERE/mkcpio.py" "$WORK/scripts" "$PKG/Scripts"
NATIVE=0; [ "$(uname)" = Darwin ] && command -v pkgbuild >/dev/null && NATIVE=1
[ $NATIVE = 1 ] || mkbom -u 0 -g 80 "$WORK/root" "$PKG/Bom"
FILES=$(find "$WORK/root" | wc -l | tr -d ' ')
KB=$(du -sk "$WORK/root" | cut -f1)
cat > "$PKG/PackageInfo" <<XML
<?xml version="1.0" encoding="utf-8"?>
<pkg-info overwrite-permissions="true" relocatable="false" identifier="$ID" postinstall-action="none" version="$VERSION" format-version="2" generator-version="Photon" install-location="/" auth="root">
  <payload numberOfFiles="$FILES" installKBytes="$KB"/>
  <bundle-version/>
  <upgrade-bundle/>
  <update-bundle/>
  <atomic-update-bundle/>
  <strict-identifier/>
  <relocate/>
  <scripts>
    <preinstall file="./preinstall"/>
    <postinstall file="./postinstall"/>
  </scripts>
</pkg-info>
XML

# Product archive: the branded pages and the description of what to install.
cp resources/welcome.html resources/conclusion.html resources/background.png resources/background-dark.png "$WORK/flat/Resources/"
cat > "$WORK/flat/Distribution" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Photon $VERSION</title>
  <background file="background.png" mime-type="image/png" alignment="bottomleft" scaling="none"/>
  <background-darkAqua file="background-dark.png" mime-type="image/png" alignment="bottomleft" scaling="none"/>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="true" rootVolumeOnly="true" hostArchitectures="x86_64,arm64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check>
    <allowed-os-versions><os-version min="11.0"/></allowed-os-versions>
  </volume-check>
  <choices-outline>
    <line choice="default"><line choice="$ID"/></line>
  </choices-outline>
  <choice id="default"/>
  <choice id="$ID" visible="false"><pkg-ref id="$ID"/></choice>
  <pkg-ref id="$ID" version="$VERSION" onConclusion="none" installKBytes="$KB">#photon.pkg</pkg-ref>
  <product id="com.photon" version="$VERSION"/>
</installer-gui-script>
XML

rm -f "$OUT"
if [ $NATIVE = 1 ]; then
  # Apple's tools: files owned by root, and the launcher apps kept where they are (pkgbuild
  # would otherwise let Installer move them to wherever a copy of the app already is).
  pkgbuild --analyze --root "$WORK/root" "$WORK/components.plist" >/dev/null
  python3 - "$WORK/components.plist" <<'PY'
import plistlib, sys
p = sys.argv[1]
items = plistlib.load(open(p, 'rb'))
for i in items:
    i['BundleIsRelocatable'] = False
    i['BundleOverwriteAction'] = 'upgrade'
plistlib.dump(items, open(p, 'wb'))
PY
  mkdir -p "$WORK/native"
  pkgbuild --root "$WORK/root" --scripts "$WORK/scripts" --component-plist "$WORK/components.plist" \
    --identifier "$ID" --version "$VERSION" --install-location / --ownership recommended "$WORK/native/photon.pkg"
  productbuild --distribution "$WORK/flat/Distribution" --resources "$WORK/flat/Resources" --package-path "$WORK/native" "$OUT"
else
  (cd "$WORK/flat" && xar --compression none -cf "$OUT" Distribution Resources photon.pkg)
fi
echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
sha256sum "$OUT" 2>/dev/null | tee "$OUT.sha256" || shasum -a 256 "$OUT" | tee "$OUT.sha256"
