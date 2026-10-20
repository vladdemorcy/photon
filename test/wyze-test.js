'use strict';
// Checks the Wyze connection against the stand-in Wyze cloud in mocks.js: signing in (with and
// without two-step verification), listing lights, color and white on each kind of Wyze light,
// saving and restoring a light, and getting a new session when Wyze's expires.
// Run: node test/wyze-test.js   (starts mocks.js itself unless it's already running)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-wyze-'));
process.env.CONFIG_PATH = path.join(tmp, 'config.json');
process.env.WYZE_AUTH_URL = 'http://127.0.0.1:8127';
process.env.WYZE_API_URL = 'http://127.0.0.1:8127';
const wyze = require('../src/lighting/wyze');

let mocks = { kill() {} };
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const W = 'http://127.0.0.1:8127';
const state = async () => (await fetch(`${W}/state`)).json();
const calls = async () => (await (await fetch('http://127.0.0.1:8099/calls')).json()).filter(x => x[0] === 'wyze');

(async () => {
  // Use the stand-ins if they're already running (as in CI), otherwise start them.
  const up = () => fetch(`${W}/state`).then(() => true, () => false);
  if (!(await up())) {
    mocks = spawn(process.execPath, [path.join(__dirname, 'mocks.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
    for (let i = 0; i < 80 && !(await up()); i++) await wait(100);
  }
  const c = { email: 'wyze@example.com', password: 'wyzepass', keyId: 'wkid', apiKey: 'wkey', code: '' };

  let err = null;
  try { await wyze.action('signin', { ...c, password: 'nope' }); } catch (e) { err = e; }
  check(err && /email or password is wrong/.test(err.message), `wrong password is explained (${err?.message})`);
  err = null;
  try { await wyze.action('signin', { ...c, apiKey: 'other' }); } catch (e) { err = e; }
  check(err && /API key/.test(err.message), `wrong API key is explained (${err?.message})`);

  const r = await wyze.action('signin', c);
  check(/Signed in to Wyze\. Found 3/.test(r.message), `signs in and finds the lights, not the camera (${r.message})`);
  const session = JSON.parse(fs.readFileSync(path.join(tmp, 'wyze-session.json'), 'utf8'));
  check(session.access && session.refresh && !JSON.stringify(session).includes('wyzepass'), 'the session is saved without the password');
  check((fs.statSync(path.join(tmp, 'wyze-session.json')).mode & 0o077) === 0, 'the session file is private');

  const { targets } = await wyze.list(c);
  const by = Object.fromEntries(targets.map(t => [t.id, t]));
  check(by.WYZE1?.caps.color && !by.WYZE2?.caps.color && by.WYZE3?.shape === 'strip', `kinds are right (${JSON.stringify(targets.map(t => [t.id, t.name, t.caps.color, t.shape]))})`);

  const before = await wyze.snapshot(c, 'WYZE1');
  check(before.P3 === '0' && before.P1502 === '3000', `snapshot reads the bulb (${JSON.stringify(before)})`);

  let n = (await calls()).length;
  await wyze.apply(c, 'WYZE1', { on: true, brightness: 8, rgb: [255, 80, 0] });
  let s = (await state()).WYZE1.props;
  check(s.P3 === '1' && s.P1501 === '8' && s.P1507 === 'FF5000' && s.P1508 === '1', `color bulb: dim orange (${JSON.stringify(s)})`);
  check((await calls()).slice(n).every(x => x[1] === 'action:set_mesh_property'), 'color bulb goes through the mesh action');

  await wyze.apply(c, 'WYZE3', { on: true, brightness: 30, kelvin: 1500 });
  s = (await state()).WYZE3.props;
  check(s.P1502 === '1800' && s.P1508 === '2' && s.P1501 === '30', `light strip: warm white, kelvin kept in range (${JSON.stringify(s)})`);

  n = (await calls()).length;
  await wyze.apply(c, 'WYZE2', { on: true, brightness: 45, kelvin: 2200, rgb: [255, 0, 0] });
  s = (await state()).WYZE2.props;
  const via = (await calls()).slice(n).map(x => x[1]);
  check(s.P1501 === '45' && s.P1502 === '2700' && s.P1507 === undefined, `white bulb: dims, no color, 2700K floor (${JSON.stringify(s)})`);
  check(via.includes('bulk') && via.includes('device'), `white bulb: on/off through the bulk endpoint (${via})`);
  await wyze.apply(c, 'WYZE2', { on: false });
  check((await state()).WYZE2.props.P3 === '0', 'white bulb turns off');

  await wyze.restore(c, 'WYZE1', before);
  s = (await state()).WYZE1.props;
  check(s.P3 === '0', `restore puts the color bulb back off (${JSON.stringify(s)})`);

  // Wyze's session runs out: Photon refreshes it and carries on.
  await fetch(`${W}/expire`, { method: 'POST' });
  await wyze.apply(c, 'WYZE1', { on: true, brightness: 50, kelvin: 4000 });
  s = (await state()).WYZE1.props;
  check(s.P3 === '1' && s.P1502 === '4000', 'after the session expires, Photon gets a new one and the change still lands');

  // Two-step verification.
  wyze._reset();
  const m = { ...c, email: 'mfa@example.com' };
  const first = await wyze.action('signin', m);
  check(/authenticator app/.test(first.message), `asks for the code (${first.message})`);
  err = null;
  try { await wyze.list(m); } catch (e) { err = e; }
  check(err && /sign in again/i.test(err.message), `lights wait for the code (${err?.message})`);
  const smsBefore = (await calls()).length;
  for (let i = 0; i < 3; i++) await wyze.list(m).catch(() => {});
  check((await calls()).filter(x => x[1] === 'login').length === (await calls()).slice(0, smsBefore).filter(x => x[1] === 'login').length, 'background checks don\'t start new sign-ins while waiting for the code');
  err = null;
  try { await wyze.action('signin', { ...m, code: '000000' }); } catch (e) { err = e; }
  check(err && /didn't accept that code/.test(err.message), `a wrong code is explained (${err?.message})`);
  const second = await wyze.action('signin', { ...m, code: '123 456' });
  check(/Signed in/.test(second.message) && second.patch?.code === '', `the code signs in and is cleared (${second.message})`);
  check((await wyze.list(m)).targets.length === 3, 'lights list after two-step sign-in');
  // When that session runs out for good, Photon asks for a new sign-in instead of trying by itself.
  await fetch(`${W}/expire`, { method: 'POST' });
  fs.writeFileSync(path.join(tmp, 'wyze-session.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(tmp, 'wyze-session.json'), 'utf8')), refresh: 'bad' }));
  wyze._reset();
  err = null;
  try { await wyze.apply(m, 'WYZE1', { on: false }); } catch (e) { err = e; }
  check(err && /sign in again/i.test(err.message), `an expired two-step account asks to sign in again (${err?.message})`);

  mocks.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'wyze test passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); mocks.kill(); process.exit(1); });
