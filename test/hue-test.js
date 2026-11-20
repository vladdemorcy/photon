'use strict';
// Checks Photon's Hue bridge connection against the fake bridges in mocks.js: HTTPS with a
// remembered certificate, refusing a different one, re-trusting it after pairing, accepting a
// certificate signed by the Hue root, and HTTP only for bridges that have never used HTTPS.
// Run: node test/hue-test.js   (starts mocks.js itself unless it's already running)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-hue-'));
process.env.CONFIG_PATH = path.join(tmp, 'config.json');
process.env.HUE_ROOT_CA = path.join(tmp, 'mock-hue-root.pem');
const hue = require('../src/lighting/hue');
const bridge = require('../src/lighting/hue-bridge');

let mocks = { kill() {} };
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const mode = m => fetch('http://127.0.0.1:8099/hue-tls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: m }) });
const pins = () => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'hue-bridges.json'), 'utf8')); } catch { return {}; } };
const attempt = async fn => { try { return { ok: await fn() }; } catch (err) { return { err }; } };

(async () => {
  const up = () => fetch('http://127.0.0.1:8099/state').then(r => r.ok, () => false);
  if (!(await up())) {
    mocks = spawn(process.execPath, [path.join(__dirname, 'mocks.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
    for (let i = 0; i < 100 && !(await up()); i++) await wait(100);
  }
  fs.writeFileSync(process.env.HUE_ROOT_CA, await (await fetch('http://127.0.0.1:8099/hue-ca')).text());
  await mode('self');
  const c = { bridgeIp: '127.0.0.1:8098', username: 'testkey' };

  // An updated bridge, already paired over HTTP before: the app key keeps working over HTTPS.
  let r = await attempt(() => hue.list(c));
  check(r.ok?.targets.some(t => t.name === 'Living room'), `an HTTPS-only bridge works with the existing pairing (${r.err?.message || 'listed'})`);
  check(Boolean(pins()['127.0.0.1:8098']), 'its certificate is remembered');
  check((fs.statSync(path.join(tmp, 'hue-bridges.json')).mode & 0o077) === 0, 'the remembered certificates file is private');
  r = await attempt(() => hue.apply(c, 'l2', { on: true, brightness: 20, kelvin: 2700 }));
  const st = await (await fetch('http://127.0.0.1:8099/state')).json();
  check(!r.err && st[2].bri === 51 && st[2].ct === 370, `a light changes over HTTPS (${r.err?.message || JSON.stringify(st[2])})`);

  // Something else answers with a different certificate: nothing is sent to it.
  await mode('self2');
  const before = (await (await fetch('http://127.0.0.1:8099/calls')).json()).length;
  r = await attempt(() => hue.apply(c, 'l2', { on: false }));
  const after = (await (await fetch('http://127.0.0.1:8099/calls')).json()).length;
  check(/different certificate/.test(r.err?.message || '') && after === before, `a different certificate is refused before anything is sent (${r.err?.message})`);

  // Pairing again (after pressing the button) trusts the new certificate.
  r = await attempt(() => hue.action('pair', c));
  check(r.ok?.patch?.username === 'testkey', `pairing again works (${r.err?.message || r.ok?.message})`);
  check(!(await attempt(() => hue.list(c))).err, 'and the bridge works again with the new certificate');

  // A firmware update replaces the self-made certificate with one signed by the Hue root.
  await mode('signed');
  r = await attempt(() => hue.list(c));
  check(!r.err, `a certificate signed by the Hue root is accepted even though it changed (${r.err?.message || 'ok'})`);

  // An HTTPS bridge never gets downgraded to plain HTTP.
  await mode('http');
  r = await attempt(() => hue.list(c));
  check(/won't fall back/.test(r.err?.message || ''), `no fallback to HTTP once HTTPS worked (${r.err?.message})`);

  // A bridge that has only ever spoken HTTP (older firmware) still works.
  bridge._reset();
  const old = { bridgeIp: '127.0.0.1:8099', username: 'testkey' };
  r = await attempt(() => hue.list(old));
  check(r.ok?.targets.length > 0 && !pins()['127.0.0.1:8099'], `an HTTP-only bridge still works (${r.err?.message || 'listed'})`);

  // Nothing listening: a clear message.
  r = await attempt(() => hue.list({ bridgeIp: '127.0.0.1:8096', username: 'x' }));
  check(/refused|unreachable/.test(r.err?.message || ''), `no bridge at the address is explained (${r.err?.message})`);

  // The real Hue roots ship with Photon.
  const real = fs.readFileSync(path.join(__dirname, '..', 'src', 'lighting', 'hue-root-ca.pem'), 'utf8');
  check((real.match(/BEGIN CERTIFICATE/g) || []).length === 2, 'Photon includes both Hue root certificates');

  await mode('self');
  mocks.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'hue test passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); mocks.kill(); process.exit(1); });
