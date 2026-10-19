"""Signs in to Photon, adds a room through its API and checks it was saved. Used by
emulator-test.sh.

    python3 save-room.py <base-url> <password> [setup-code]

With a setup code (Photon has no password yet), it chooses the password first. Like the web
page, it keeps the session cookie and sends the CSRF token with every change. It also checks
that a client with no session is turned away.
"""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request

base, password = sys.argv[1], sys.argv[2]
code = sys.argv[3] if len(sys.argv) > 3 else ''
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
csrf = None


def call(method, path, body=None, client=opener):
    headers = {'Content-Type': 'application/json'}
    if csrf and method != 'GET':
        headers['X-Photon-CSRF'] = csrf
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                 method=method, headers=headers)
    try:
        with client.open(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


# Nothing works without signing in.
status, _ = call('GET', '/api/config', client=urllib.request.build_opener())
print('config without a session:', status)
if status != 401:
    sys.exit('Photon answered /api/config without a session')

if code:
    status, reply = call('POST', '/api/auth/setup', {'code': code, 'password': password})
    print('setup:', status, reply)
else:
    status, reply = call('POST', '/api/auth/login', {'password': password})
    print('login:', status, reply)
if status != 200:
    sys.exit('could not sign in')
if not any(c.name == 'photon_sid' for c in jar):
    sys.exit('no session cookie')

status, state = call('GET', '/api/auth/state')
csrf = state.get('csrf')
print('signed in:', state.get('signedIn'))

status, cfg = call('GET', '/api/config')
before = any(r.get('name') == 'Emulator room' for r in cfg.get('rooms', []))
print('room already saved:', before)
if not before:
    cfg.setdefault('rooms', []).append({'id': 'emulator-room', 'name': 'Emulator room'})
status, reply = call('PUT', '/api/config', cfg)
print('save:', status)
status, again = call('GET', '/api/config')
ok = any(r.get('name') == 'Emulator room' for r in again.get('rooms', []))
print('saved' if ok else 'not saved')
sys.exit(0 if ok else 1)
