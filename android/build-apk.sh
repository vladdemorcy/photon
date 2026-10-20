#!/usr/bin/env bash
# Builds dist/Photon-<version>.apk, the Android app, on Linux. No Android Studio or NDK needed.
#
#   bash android/build-apk.sh
#
# Needs (Ubuntu 24.04 package names):
#   sudo apt install android-sdk-build-tools android-sdk-platform-23 android-framework-res \
#                    apksigner zipalign dalvik-exchange clang lld patchelf zip openjdk-21-jdk-headless nodejs npm
#
# Signing: Android only installs an update if it's signed with the same key as the version
# already on the phone. Point PHOTON_KEYSTORE at your release key (a .p12 or .jks file) and
# put its password in PHOTON_KEYSTORE_PASS. Without them the APK is signed with a throwaway
# key made in build/, which is fine for testing but can't update a release install.
set -euo pipefail
cd "$(dirname "$0")"
ANDROID="$(pwd)"
ROOT="$(cd .. && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
IFS=. read -r MAJ MIN PAT <<< "${VERSION%%-*}"
VERSION_CODE=$((MAJ * 10000 + MIN * 100 + PAT))
OUT="$ROOT/build/android"
VENDOR="$ANDROID/vendor"
SDK=/usr/lib/android-sdk
export PATH="$PATH:$SDK/build-tools/29.0.3"
PLATFORM_JAR="$SDK/platforms/android-23/android.jar"
FRAMEWORK_RES=/usr/share/android-framework-res/framework-res.apk
MIN_SDK=26
TARGET_SDK=35
ABIS=(arm64-v8a x86_64)

echo "Building Photon $VERSION for Android (versionCode $VERSION_CODE)"
for tool in aapt2 javac dx zip clang ld.lld patchelf zipalign apksigner keytool npm python3; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. See the top of this script for what to install." >&2; exit 1; }
done
[ -f "$PLATFORM_JAR" ] || { echo "Missing $PLATFORM_JAR (apt install android-sdk-platform-23)" >&2; exit 1; }
[ -f "$FRAMEWORK_RES" ] || { echo "Missing $FRAMEWORK_RES (apt install android-framework-res)" >&2; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT" "$VENDOR" "$ROOT/dist"

# ---- 1. Node for Android -------------------------------------------------------------------
# libnode.so comes from nodejs-mobile (MIT), which publishes it inside its React Native
# package on npm. libc++_shared.so is the C++ library from Android's NDK (Apache 2.0 with LLVM
# exceptions); pyzmq's Android wheels on PyPI carry a copy built with NDK r27. Both downloads
# are checked against fixed hashes.
NODE_PKG="$VENDOR/nodejs-mobile-react-native-18.20.4.tgz"
NODE_SHA512="2db6b99d837011bc3e2bd5909f173263ff4179a830f8d2156f2ac253a6eeac2259d69d622b14974e9e6b72d82f471cd06f8011634afd532d64ec3b1e6f516157"
if [ ! -f "$VENDOR/libnode/arm64-v8a/libnode.so" ]; then
  echo "Downloading nodejs-mobile 18.20.4 (about 100 MB, once)"
  curl -fsSL -o "$NODE_PKG" https://registry.npmjs.org/nodejs-mobile-react-native/-/nodejs-mobile-react-native-18.20.4.tgz
  echo "$NODE_SHA512  $NODE_PKG" | sha512sum -c --quiet
  tmp="$(mktemp -d)"
  tar xzf "$NODE_PKG" -C "$tmp" --wildcards 'package/android/libnode/bin/*' 'package/LICENSE'
  for abi in "${ABIS[@]}"; do
    mkdir -p "$VENDOR/libnode/$abi"
    cp "$tmp/package/android/libnode/bin/$abi/libnode.so" "$VENDOR/libnode/$abi/"
  done
  cp "$tmp/package/LICENSE" "$VENDOR/libnode/LICENSE"
  rm -rf "$tmp" "$NODE_PKG"
fi

declare -A CXX_URL=(
  [arm64-v8a]="https://files.pythonhosted.org/packages/83/5e/d0541596b48c5a19f85dcbea83d6673d8e91681cdf853eb194c31fc9766e/pyzmq-27.2.0-cp313-cp313-android_24_arm64_v8a.whl"
  [x86_64]="https://files.pythonhosted.org/packages/50/9f/8c7411bb283982d46e6d56dca6a095678c87eb0398daead12776d9881ac2/pyzmq-27.2.0-cp313-cp313-android_24_x86_64.whl"
)
declare -A CXX_SHA=(
  [arm64-v8a]="c551b9e2f86dc625fcb1a032c0d68042678caf96a8dd7c28796766b673bd5b52"
  [x86_64]="288cc790da0e3064a14a38ddc56ba169dada8c8af4cb86518db2bcbd380eedbb"
)
for abi in "${ABIS[@]}"; do
  [ -f "$VENDOR/libcxx/$abi/libc++_shared.so" ] && continue
  echo "Downloading the Android C++ library for $abi"
  mkdir -p "$VENDOR/libcxx/$abi"
  whl="$VENDOR/libcxx/$abi.whl"
  curl -fsSL -o "$whl" "${CXX_URL[$abi]}"
  echo "${CXX_SHA[$abi]}  $whl" | sha256sum -c --quiet
  python3 - "$whl" "$VENDOR/libcxx/$abi/libc++_shared.so" <<'EOF'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
name = next(n for n in z.namelist() if n.startswith('pyzmq.libs/libc++_shared'))
open(sys.argv[2], 'wb').write(z.read(name))
EOF
  # The wheel renamed it to avoid clashes inside Python. Give it back its usual name.
  patchelf --set-soname libc++_shared.so "$VENDOR/libcxx/$abi/libc++_shared.so"
  rm -f "$whl"
done

# ---- 2. The bridge between Java and Node ---------------------------------------------------
JNI_INCLUDE="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")/include"
mkdir -p "$OUT/stub-include"
: > "$OUT/stub-include/stdio.h"   # jni.h includes it but needs nothing from it
for abi in "${ABIS[@]}"; do
  case "$abi" in
    arm64-v8a) triple=aarch64-linux-android$MIN_SDK ;;
    x86_64) triple=x86_64-linux-android$MIN_SDK ;;
  esac
  mkdir -p "$OUT/lib/$abi" "$OUT/stubs/$abi"
  # A stand-in libc.so with just the names the bridge uses. Only used to link; the phone's
  # own libc.so is loaded at run time.
  printf 'int open(const char*p,int f,...){return -1;}\nint dup2(int a,int b){return -1;}\nint close(int a){return -1;}\n' > "$OUT/stubs/libc.c"
  clang --target="$triple" -shared -nostdlib -fPIC -o "$OUT/stubs/$abi/libc.so" -Wl,-soname,libc.so "$OUT/stubs/libc.c" -fuse-ld=lld
  clang --target="$triple" -shared -nostdlib -fPIC -O2 -fvisibility=hidden \
    -ffreestanding -I"$OUT/stub-include" -I"$JNI_INCLUDE" -I"$JNI_INCLUDE/linux" \
    -fuse-ld=lld -Wl,-soname,libphoton-node.so -Wl,--hash-style=both -Wl,-z,max-page-size=16384 \
    -Wl,-z,noexecstack -Wl,--no-undefined -Wl,--build-id=sha1 \
    -o "$OUT/lib/$abi/libphoton-node.so" "$ANDROID/jni/photon-node.c" \
    "$VENDOR/libnode/$abi/libnode.so" "$OUT/stubs/$abi/libc.so"
  cp "$VENDOR/libnode/$abi/libnode.so" "$VENDOR/libcxx/$abi/libc++_shared.so" "$OUT/lib/$abi/"
done

# ---- 3. Photon itself, packed into one file the app unpacks on first start --------------------
STAGE="$OUT/photon"
mkdir -p "$STAGE"
cp -r "$ROOT/src" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$ROOT/THIRD-PARTY-NOTICES.md" "$ROOT/licenses" "$STAGE/"
cp "$ANDROID/android-main.js" "$ANDROID/THIRD-PARTY.txt" "$STAGE/"
mkdir -p "$STAGE/licenses"
cp "$VENDOR/libnode/LICENSE" "$STAGE/licenses/nodejs-mobile-LICENSE.txt"
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts --loglevel=error)
if find "$STAGE/node_modules" -name '*.node' | grep -q .; then
  echo "A package has a native add-on, which wouldn't run on Android. Stopping." >&2
  exit 1
fi
# three.js: keep only what the browser loads (the 3D view).
THREE="$STAGE/node_modules/three"
KEEP="$(mktemp -d)"
mkdir -p "$KEEP/build" "$KEEP/examples/jsm/controls"
cp "$THREE/package.json" "$THREE/LICENSE" "$KEEP/"
cp "$THREE/build/three.module.js" "$KEEP/build/"
[ -f "$THREE/build/three.core.js" ] && cp "$THREE/build/three.core.js" "$KEEP/build/"
cp "$THREE/examples/jsm/controls/OrbitControls.js" "$KEEP/examples/jsm/controls/"
rm -rf "$THREE" && mv "$KEEP" "$THREE"
mkdir -p "$OUT/assets"
(cd "$STAGE" && find . -type f | LC_ALL=C sort | sed 's|^\./||' | zip -q -X -9 "$OUT/assets/photon.zip" -@)

# ---- 4. Resources and manifest ---------------------------------------------------------------
mkdir -p "$OUT/res-compiled" "$OUT/gen"
aapt2 compile --dir "$ANDROID/res" -o "$OUT/res-compiled/res.zip"
aapt2 link -o "$OUT/base.apk" -I "$FRAMEWORK_RES" \
  --manifest "$ANDROID/AndroidManifest.xml" \
  --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" --version-name "$VERSION" \
  --java "$OUT/gen" --auto-add-overlay \
  "$OUT/res-compiled/res.zip"

# ---- 5. Java ----------------------------------------------------------------------------------
# Compiled against the Android 6 platform library (the newest Ubuntu packages). Calls that
# need newer Android versions go through Compat.java, which looks them up at run time.
# Android 9's fingerprint and face classes aren't in that library either, so the build uses
# small stand-ins from android/stubs to compile against. They stay out of the APK; on the
# phone, Android's real classes are used.
mkdir -p "$OUT/classes" "$OUT/stub-classes"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 \
  -bootclasspath "$PLATFORM_JAR" -d "$OUT/stub-classes" $(find "$ANDROID/stubs" -name '*.java')
find "$ANDROID/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 \
  -bootclasspath "$PLATFORM_JAR" -classpath "$OUT/stub-classes" -d "$OUT/classes" @"$OUT/sources.txt"
dx --dex --min-sdk-version="$MIN_SDK" --output="$OUT/classes.dex" "$OUT/classes"

# ---- 6. Put the APK together, align and sign -------------------------------------------------
python3 - "$OUT" "${ABIS[@]}" <<'EOF'
import os, sys, zipfile
out, abis = sys.argv[1], sys.argv[2:]
src = zipfile.ZipFile(os.path.join(out, 'base.apk'))
apk = zipfile.ZipFile(os.path.join(out, 'unsigned.apk'), 'w')
for info in src.infolist():
    apk.writestr(info, src.read(info.filename))
def add(path, name, stored=False):
    zi = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
    zi.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    zi.external_attr = 0o644 << 16
    with open(path, 'rb') as f:
        apk.writestr(zi, f.read(), compresslevel=9)
add(os.path.join(out, 'classes.dex'), 'classes.dex')
for abi in abis:
    for so in sorted(os.listdir(os.path.join(out, 'lib', abi))):
        add(os.path.join(out, 'lib', abi, so), f'lib/{abi}/{so}')
add(os.path.join(out, 'assets', 'photon.zip'), 'assets/photon.zip', stored=True)
apk.close()
EOF
zipalign -p -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

APK="$ROOT/dist/Photon-$VERSION.apk"
if [ -n "${PHOTON_KEYSTORE:-}" ]; then
  : "${PHOTON_KEYSTORE_PASS:?Set PHOTON_KEYSTORE_PASS to the keystore password}"
  KS="$PHOTON_KEYSTORE"
  KS_PASS="$PHOTON_KEYSTORE_PASS"
else
  echo "PHOTON_KEYSTORE isn't set, so this APK is signed with a throwaway test key."
  KS="$OUT/test-key.p12"
  KS_PASS=photon-test
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -storepass "$KS_PASS" -alias photon \
    -keyalg RSA -keysize 3072 -validity 365 -dname "CN=Photon test build" >/dev/null 2>&1
fi
apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --min-sdk-version "$MIN_SDK" \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
  --out "$APK" "$OUT/aligned.apk"
apksigner verify --min-sdk-version "$MIN_SDK" "$APK"
rm -f "$APK.idsig"

echo
echo "Built $APK ($(du -h "$APK" | cut -f1))"
sha256sum "$APK" | tee "$APK.sha256"
