'use strict';
// Checks the Yeelight connection against the stand-in lights in mocks.js: finding them, color and
// white on a color bulb, brightness only on a white-only one, turning on before changing a light
// that's off, saving and restoring, and a clear message when LAN Control is off.
// Run: node test/yeelight-test.js   (starts mocks.js itself unless it's already running)
const { spawn } = require('child_process');
const path = require('path');

process.env.YEELIGHT_SEARCH = '127.0.0.1:19820';
const yeelight = require('../src/lighting/yeelight');

let mocks = { kill() {} };
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const state = async () => (await fetch('http://127.0.0.1:8099/yeelight')).json();
const calls = async () => (await (await fetch('http://127.0.0.1:8099/calls')).json()).filter(x => x[0] === 'yeelight');

(async () => {
  const up = () => fetch('http://127.0.0.1:8099/yeelight').then(r => r.ok, () => false);
  if (!(await up())) {
    mocks = spawn(process.execPath, [path.join(__dirname, 'mocks.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
    for (let i = 0; i < 80 && !(await up()); i++) await wait(100);
  }
  const c = { hosts: '' };
  const COLOR = '0x00000000aa01', MONO = '0x00000000aa02';

  const r = await yeelight.action('scan', c);
  check(/Found 2 Yeelight/.test(r.message), `finds both lights (${r.message})`);
  const { targets } = await yeelight.list(c);
  const by = Object.fromEntries(targets.map(t => [t.id, t]));
  check(by[COLOR]?.name === 'Bedroom lamp' && by[COLOR].caps.color && by[COLOR].caps.temp, `color bulb: its name and color (${JSON.stringify(by[COLOR])})`);
  check(by[MONO] && !by[MONO].caps.color && !by[MONO].caps.temp && /mono/.test(by[MONO].name), `white-only light: brightness only, named by model (${JSON.stringify(by[MONO])})`);

  const before = await yeelight.snapshot(c, COLOR);
  check(before.power === 'off' && before.ct === 4000, `snapshot reads the light (${JSON.stringify(before)})`);

  let n = (await calls()).length;
  await yeelight.apply(c, COLOR, { on: true, brightness: 8, rgb: [255, 80, 0], transition: 1 });
  let s = (await state())[COLOR];
  const sent = (await calls()).slice(n).map(x => x[2]);
  check(s.power === 'on' && s.bright === 8 && s.rgb === 0xFF5000 && s.color_mode === 1, `a light that was off turns on, then goes dim orange (${JSON.stringify(s)})`);
  check(sent[0] === 'set_power' && (await calls()).slice(n)[0][3][1] === 'smooth' && (await calls()).slice(n)[0][3][2] === 1000, `power goes first, with a 1 second fade (${sent})`);

  await yeelight.apply(c, COLOR, { on: true, brightness: 40, kelvin: 1500 });
  s = (await state())[COLOR];
  check(s.ct === 1700 && s.color_mode === 2 && s.bright === 40, `warm white, kept in the light's range (${JSON.stringify(s)})`);

  n = (await calls()).length;
  await yeelight.apply(c, MONO, { on: true, brightness: 25, kelvin: 2200, rgb: [255, 0, 0] });
  s = (await state())[MONO];
  const monoSent = (await calls()).slice(n).map(x => x[2]);
  check(s.bright === 25 && !monoSent.includes('set_rgb') && !monoSent.includes('set_ct_abx'), `white-only light just dims (${monoSent})`);

  await yeelight.restore(c, COLOR, before, 0);
  s = (await state())[COLOR];
  check(s.power === 'off', `restore turns the color bulb back off (${JSON.stringify(s)})`);
  await yeelight.apply(c, COLOR, { on: true, brightness: 60, rgb: [0, 0, 255] });
  const blue = await yeelight.snapshot(c, COLOR);
  await yeelight.apply(c, COLOR, { on: true, brightness: 10, kelvin: 2700 });
  await yeelight.restore(c, COLOR, blue, 0.5);
  s = (await state())[COLOR];
  check(s.color_mode === 1 && s.rgb === 255 && s.bright === 60, `restore brings back a color (${JSON.stringify(s)})`);

  // A light whose LAN Control is off refuses the connection.
  const lost = { hosts: '' };
  let err = null;
  try { await yeelight.apply(lost, 'nope', { on: false }); } catch (e) { err = e; }
  check(err && /LAN Control/.test(err.message), `an unknown light points to LAN Control (${err?.message})`);

  mocks.kill();
  console.log(failed ? `${failed} failed` : 'yeelight test passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); mocks.kill(); process.exit(1); });
