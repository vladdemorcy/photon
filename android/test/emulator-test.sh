#!/usr/bin/env bash
# Installs the APK on a running emulator and checks that Photon starts, answers, survives a
# crash, stops and starts again. Used by .github/workflows/android.yml; works the same against
# any emulator or phone that adb can see (a phone needs "adb root" for the crash test).
#
#   bash android/test/emulator-test.sh dist/Photon-1.4.3.apk [results-dir]
set -uo pipefail
APK="$1"
OUT="${2:-android-test-results}"
PKG=com.photon.app
mkdir -p "$OUT"
FAILED=0
pass() { echo "PASS: $*" | tee -a "$OUT/summary.txt"; }
fail() { echo "FAIL: $*" | tee -a "$OUT/summary.txt"; FAILED=1; }

adb wait-for-device
adb root >/dev/null 2>&1 && sleep 3 && adb wait-for-device
adb shell getprop ro.build.version.release | sed 's/^/Android /' | tee "$OUT/device.txt"
adb shell getprop ro.product.cpu.abi | tee -a "$OUT/device.txt"
adb logcat -c || true

# Waits until Photon answers on the phone, up to $1 seconds.
wait_up() {
  local secs="$1"
  for _ in $(seq 1 "$secs"); do
    if curl -sf -m 2 http://127.0.0.1:8787/api/version > "$OUT/version.json" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
wait_down() {
  for _ in $(seq 1 "$1"); do
    curl -sf -m 2 http://127.0.0.1:8787/api/version >/dev/null 2>&1 || return 0
    sleep 1
  done
  return 1
}
# Taps the on-screen button with this text.
tap() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb shell cat /sdcard/ui.xml > "$OUT/ui.xml"
  local xy
  xy="$(python3 - "$OUT/ui.xml" "$1" <<'EOF'
import re, sys
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
for m in re.finditer(r'<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
    if m.group(1) == sys.argv[2]:
        x1, y1, x2, y2 = map(int, m.groups()[1:])
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
EOF
)"
  if [ -z "$xy" ]; then fail "couldn't find the \"$1\" button"; return 1; fi
  adb shell input tap $xy
}
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }

# 1. Install and open
if adb install -r -g "$APK" > "$OUT/install.txt" 2>&1; then pass "installed"; else fail "install: $(cat "$OUT/install.txt")"; fi
adb forward tcp:8787 tcp:8787
adb shell am start -W -n $PKG/.MainActivity > /dev/null

# 2. Photon answers
if wait_up 120; then pass "Photon answered: $(cat "$OUT/version.json")"; else fail "Photon didn't answer within 2 minutes"; fi
sleep 3
shot 1-main-screen
curl -s -m 5 http://127.0.0.1:8787/api/diagnostics > "$OUT/diagnostics.json" || true
code="$(curl -s -o "$OUT/index.html" -w '%{http_code}' -m 5 http://127.0.0.1:8787/)"
[ "$code" = 200 ] && pass "web page loads" || fail "web page returned $code"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:8787/app.js)"
[ "$code" = 200 ] && pass "app.js loads" || fail "app.js returned $code"
# Settings save and read back
if python3 "$(dirname "$0")/save-room.py" http://127.0.0.1:8787 > "$OUT/config-save.txt" 2>&1; then
  pass "settings save"
else
  fail "settings didn't save: $(head -c 300 "$OUT/config-save.txt")"
fi
if adb shell dumpsys notification --noredact 2>/dev/null | grep -A3 "pkg=$PKG" > "$OUT/notification.txt" && [ -s "$OUT/notification.txt" ]; then
  pass "notification shown"
else
  fail "no notification"
fi
adb shell dumpsys activity services $PKG > "$OUT/service.txt" 2>&1
grep -q "isForeground=true" "$OUT/service.txt" && pass "running as a foreground service" || fail "not a foreground service"

# 3. The in-app web view
tap "Open Photon" && sleep 12 && shot 2-web-view
adb shell input keyevent KEYCODE_BACK; sleep 2

# 4. Android brings Photon back after a crash
pid="$(adb shell pidof $PKG:node | tr -d '\r')"
if [ -n "$pid" ]; then
  adb shell kill -9 "$pid"
  sleep 2
  if wait_up 90; then pass "came back after a crash (old process $pid, new $(adb shell pidof $PKG:node | tr -d '\r'))"; else fail "didn't come back after a crash"; fi
else
  fail "couldn't find Photon's process"
fi
curl -sf -m 5 http://127.0.0.1:8787/api/config | grep -q 'Emulator room' && pass "settings kept after the crash" || fail "settings lost after the crash"

# 5. Stop and start from the app
adb shell am start -W -n $PKG/.MainActivity > /dev/null; sleep 3
tap "Stop Photon" && if wait_down 20; then pass "Stop works"; else fail "still answering after Stop"; fi
sleep 2; shot 3-stopped
tap "Start Photon" && if wait_up 90; then pass "Start works"; else fail "didn't answer after Start"; fi
sleep 2; shot 4-started

# Evidence
adb shell cat /data/data/$PKG/files/data/console.log > "$OUT/console.log" 2>/dev/null || true
adb shell cat /data/data/$PKG/files/data/photon.log > "$OUT/photon.log" 2>/dev/null || true
adb logcat -d > "$OUT/logcat.txt" 2>/dev/null || true
grep -E "Photon|photon|AndroidRuntime|DEBUG|linker" "$OUT/logcat.txt" > "$OUT/logcat-photon.txt" || true

echo; echo "---- Photon's console (start) ----"; head -n 15 "$OUT/console.log" 2>/dev/null
echo "---- Photon's console (end) ----"; tail -n 15 "$OUT/console.log" 2>/dev/null

echo; cat "$OUT/summary.txt"
exit $FAILED
