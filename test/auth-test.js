'use strict';
// Checks Photon's sign-in and request protections against a running Photon.
// Start the stand-ins (node test/mocks.js) and a Photon with an empty settings folder, then:
//   node test/auth-test.js http://127.0.0.1:18820 /path/to/that/settings/folder

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:18820';
const DATA = process.argv[3];
const PASSWORD = 'correct horse battery staple';
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}`); if (!cond) failed++; };

// Plain http requests, so headers browsers protect (Host, Origin, Sec-Fetch-Site) can be set.
const http = require('http');
function req(method, p, { body, cookie, csrf, headers = {} } = {}) {
  const u = new URL(BASE + p);
  const h = { ...headers };
  const payload = body !== undefined ? JSON.stringify(body) : null;
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-Photon-CSRF'] = csrf;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, res => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let data = text; try { data = JSON.parse(text); } catch { /* text */ }
        resolve({ status: res.statusCode, data, setCookie: [].concat(res.headers['set-cookie'] || []).join('\n'), headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const cookieOf = setCookie => (/photon_sid=([^;]*)/.exec(setCookie) || [])[0] || '';

(async () => {
  // Before a password exists
  let st = await req('GET', '/api/auth/state');
  ok(st.data.setup === true && st.data.signedIn === false, 'new Photon asks for a password first');
  ok((await req('GET', '/api/config')).status === 401, 'settings need sign-in');
  ok((await req('GET', '/api/diagnostics')).status === 401, 'diagnostics need sign-in');
  ok((await req('GET', '/api/version')).status === 200, 'version stays open for installers');
  const code = fs.readFileSync(path.join(DATA, 'setup-code'), 'utf8').trim();
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `setup code made (${code.replace(/[A-Z0-9]/g, 'x')})`);
  ok((await req('POST', '/api/auth/login', { body: { password: 'x' } })).status === 409, 'no sign-in before a password exists');
  ok((await req('POST', '/api/auth/setup', { body: { code: 'AAAA-BBBB-CCCC', password: PASSWORD } })).status === 401, 'wrong setup code refused');
  ok((await req('POST', '/api/auth/setup', { body: { code, password: 'password123' } })).status === 400, 'common password refused');
  ok((await req('POST', '/api/auth/setup', { body: { code, password: 'short' } })).status === 400, 'short password refused');
  ok((await req('POST', '/api/auth/setup', { body: { code, password: PASSWORD }, headers: { Origin: 'http://evil.example' } })).status === 403, 'setup from another website refused');
  const setup = await req('POST', '/api/auth/setup', { body: { code: code.toLowerCase(), password: PASSWORD } });
  ok(setup.status === 200, 'password set with the setup code');
  ok(/HttpOnly/.test(setup.setCookie) && /SameSite=Strict/.test(setup.setCookie) && /Path=\//.test(setup.setCookie), 'session cookie is HttpOnly and SameSite=Strict');
  ok(!fs.existsSync(path.join(DATA, 'setup-code')), 'setup code removed once used');
  const authFile = JSON.parse(fs.readFileSync(path.join(DATA, 'auth.json'), 'utf8'));
  ok(authFile.kdf === 'scrypt' && authFile.N >= 32768 && !JSON.stringify(authFile).includes(PASSWORD), 'password stored only as a scrypt hash');
  ok((fs.statSync(path.join(DATA, 'auth.json')).mode & 0o077) === 0, 'password file readable only by Photon');
  ok((await req('POST', '/api/auth/setup', { body: { code, password: 'another long password' } })).status === 409, 'setup can\'t be used again');

  let cookie = cookieOf(setup.setCookie);
  st = await req('GET', '/api/auth/state', { cookie });
  ok(st.data.signedIn && st.data.csrf, 'signed in after setup');
  let csrf = st.data.csrf;
  const sessions = fs.readFileSync(path.join(DATA, 'sessions.json'), 'utf8');
  ok(!sessions.includes(cookie.split('=')[1]), 'sessions file keeps only hashes of session IDs');

  // Keys stay on the server
  let cfg = (await req('GET', '/api/config', { cookie })).data;
  cfg.lighting.homeassistant = { ...cfg.lighting.homeassistant, enabled: true, url: 'http://127.0.0.1:8123', token: 'hatoken' };
  cfg.lighting.hue = { ...cfg.lighting.hue, enabled: true, bridgeIp: '127.0.0.1:8099', username: 'testkey' };
  let put = await req('PUT', '/api/config', { cookie, body: cfg });
  ok(put.status === 403, 'change without the CSRF token refused');
  put = await req('PUT', '/api/config', { cookie, csrf, body: cfg, headers: { Origin: 'http://evil.example' } });
  ok(put.status === 403, 'change from another website refused');
  put = await req('PUT', '/api/config', { cookie, csrf, body: cfg, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  ok(put.status === 403, 'cross-site request refused (Sec-Fetch-Site)');
  put = await req('PUT', '/api/config', { cookie, csrf, body: cfg, headers: { Origin: BASE } });
  ok(put.status === 200, 'change from Photon\'s own page saved');
  cfg = (await req('GET', '/api/config', { cookie })).data;
  ok(cfg.lighting.homeassistant.token === '__photon_saved__' && cfg.lighting.hue.username === '__photon_saved__', 'saved keys come back only as "saved"');
  ok(!JSON.stringify(cfg).includes('hatoken') && !JSON.stringify(cfg).includes('testkey'), 'no key appears anywhere in what the page gets');
  put = await req('PUT', '/api/config', { cookie, csrf, body: cfg });
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  ok(onDisk.lighting.homeassistant.token === 'hatoken' && onDisk.lighting.hue.username === 'testkey', 'saving the page keeps the real keys');
  const test = await req('POST', '/api/lighting/homeassistant/test', { cookie, csrf, body: { config: cfg.lighting.homeassistant } });
  ok(test.status === 200, `testing with a saved key works (${test.data.message || test.data.error})`);
  ok(!JSON.stringify(onDisk).includes(PASSWORD) && !('password' in onDisk), 'password isn\'t in the settings file');

  // Downloading everything, keys included, takes the password again
  ok((await req('POST', '/api/backups/export', { cookie, body: { password: PASSWORD } })).status === 403, 'settings download without the CSRF token refused');
  ok((await req('POST', '/api/backups/export', { body: { password: PASSWORD } })).status === 401, 'settings download without signing in refused');
  ok((await req('POST', '/api/backups/export', { cookie, csrf, body: { password: 'not the password' } })).status === 403, 'settings download with the wrong password refused');
  const exported = await req('POST', '/api/backups/export', { cookie, csrf, body: { password: PASSWORD } });
  ok(exported.status === 200 && exported.data.lighting.homeassistant.token === 'hatoken' && /attachment/.test(exported.headers['content-disposition'] || ''), 'settings download with the password has the keys');
  ok(/no-store/.test(exported.headers['cache-control'] || ''), 'the download isn\'t cached');
  // Importing a file saved from the page (keys hidden) keeps the keys this Photon has
  const imp = await req('POST', '/api/backups/import', { cookie, csrf, body: { config: cfg } });
  const afterImport = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  ok(imp.status === 200 && afterImport.lighting.homeassistant.token === 'hatoken', 'importing a file with hidden keys keeps the real ones');
  cfg = (await req('GET', '/api/config', { cookie })).data;

  // Addresses
  ok((await req('GET', '/api/version', { headers: { Host: 'evil.example:8787' } })).status === 421, 'request addressed to another name refused (DNS rebinding)');
  ok((await req('GET', '/api/version', { headers: { Host: 'localhost:8787' } })).status === 200, 'localhost works');
  ok((await req('GET', '/api/version', { headers: { Host: '192.168.1.60:8787' } })).status === 200, 'an IP address works');
  ok((await req('POST', '/webhook/plex/wrong', { body: { event: 'media.play' } })).status === 403, 'webhook with the wrong key refused');
  const hdr = await req('GET', '/');
  ok(hdr.headers['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(hdr.headers['content-security-policy'] || ''), 'page can\'t be framed by other sites');

  // Another program on the same computer: no cookie, or a page on another local port
  ok((await req('POST', '/api/webhook-token/regenerate', { csrf })).status === 401, 'another program can\'t change anything without signing in');
  ok((await req('POST', '/api/auth/logout-all', {})).status === 401, 'another program can\'t sign everyone out');
  ok((await req('PUT', '/api/config', { cookie, csrf, body: cfg, headers: { Origin: 'http://127.0.0.1:3000' } })).status === 403, 'a page from another app on this computer (other port) can\'t make changes');
  const stolenRead = await req('GET', '/api/config', { headers: { Origin: 'http://127.0.0.1:3000' } });
  ok(stolenRead.status === 401 && !stolenRead.headers['access-control-allow-origin'], 'nothing is readable from other origins');

  // A webhook with the wrong key is refused before any upload is read
  const big = await new Promise(resolve => {
    const u = new URL(`${BASE}/webhook/plex/wrong`);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': 50 * 1024 * 1024 } }, res => resolve(res.statusCode));
    r.on('error', () => resolve('closed'));
    r.write('--x\r\nContent-Disposition: form-data; name="thumb"; filename="a.jpg"\r\n\r\n');
    r.write(Buffer.alloc(256 * 1024));
  });
  ok(big === 403, `big upload to a webhook with the wrong key refused straight away (${big})`);

  // Changing the password signs out every other device
  const second = cookieOf((await req('POST', '/api/auth/login', { body: { password: PASSWORD } })).setCookie);
  ok((await req('GET', '/api/config', { cookie: second })).status === 200, 'a second device signs in');
  const changed = await req('POST', '/api/auth/password', { cookie, csrf, body: { current: PASSWORD, password: 'an even longer passphrase now' } });
  ok(changed.status === 200, 'password changed with the current password');
  ok((await req('GET', '/api/config', { cookie: second })).status === 401, 'the other device is signed out after the change');
  cookie = cookieOf(changed.setCookie);
  csrf = (await req('GET', '/api/auth/state', { cookie })).data.csrf;
  ok((await req('GET', '/api/config', { cookie })).status === 200, 'this device stays signed in with a new session');
  ok((await req('POST', '/api/auth/logout-all', { cookie, csrf })).status === 200, 'sign out everywhere');
  ok((await req('GET', '/api/config', { cookie })).status === 401, 'signed out everywhere, including here');
  const third = await req('POST', '/api/auth/login', { body: { password: 'an even longer passphrase now' } });
  cookie = cookieOf(third.setCookie);
  csrf = (await req('GET', '/api/auth/state', { cookie })).data.csrf;
  ok(third.status === 200, 'sign in with the new password');

  // Wrong passwords
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await req('POST', '/api/auth/login', { body: { password: `wrong guess ${i}` } })).status);
  ok(results.slice(0, 5).every(s => s === 401) && results[5] === 429, `sixth wrong try in a row is blocked (${results.join(',')})`);
  ok((await req('POST', '/api/auth/login', { body: { password: PASSWORD } })).status === 429, 'still blocked for a while, even with the right password');

  // Change password: other sessions end
  const other = cookie;
  const ch = await req('POST', '/api/auth/password', { cookie, csrf, body: { current: 'not it', password: 'a different long passphrase' } });
  ok(ch.status === 401 || ch.status === 429, 'change needs the current password');
  // (that address is rate limited now, so use the password tool to check the rest)

  // Password tool and reset
  const env = { ...process.env, CONFIG_PATH: path.join(DATA, 'config.json') };
  execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'password.js'), 'set'], { env, input: 'brand new passphrase here\n' });
  ok((await req('GET', '/api/config', { cookie: other })).status === 401, 'setting a password with the tool signs everyone out');
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'password.js'), 'reset'], { env }).toString();
  st = await req('GET', '/api/auth/state');
  ok(st.data.setup === true && /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/.test(out), 'reset brings back the setup screen with a new code, without a restart');

  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
