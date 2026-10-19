"""Adds a room through Photon's API and checks it was saved. Used by emulator-test.sh."""
import json
import sys
import urllib.request

base = sys.argv[1]
cfg = json.load(urllib.request.urlopen(base + '/api/config', timeout=5))
cfg.setdefault('rooms', []).append({'id': 'emulator-room', 'name': 'Emulator room'})
req = urllib.request.Request(base + '/api/config', data=json.dumps(cfg).encode(), method='PUT',
                             headers={'Content-Type': 'application/json'})
urllib.request.urlopen(req, timeout=5)
again = json.load(urllib.request.urlopen(base + '/api/config', timeout=5))
ok = any(r.get('name') == 'Emulator room' for r in again.get('rooms', []))
print('saved' if ok else 'not saved')
sys.exit(0 if ok else 1)
