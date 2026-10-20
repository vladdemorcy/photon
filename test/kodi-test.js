'use strict';
// Checks the Kodi source against the stand-in in tv-mocks.js: finding the player, reading
// play, pause, music and stop, and a clear message for a wrong password.
// Run: node test/kodi-test.js   (starts tv-mocks.js itself)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-kodi-'));
process.env.CONFIG_PATH = path.join(tmp, 'config.json');
const kodi = require('../src/media/tv/kodi');

const mocks = spawn(process.execPath, [path.join(__dirname, 'tv-mocks.js')], { stdio: 'inherit' });
const wait = ms => new Promise(r => setTimeout(r, ms));
const set = st => fetch('http://127.0.0.1:18099/set', { method: 'POST', body: JSON.stringify({ tv: 'kodi', state: st }) });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:18099/'); break; } catch { await wait(100); } }
  const c = { autoFind: false, hosts: '127.0.0.1:18080', username: 'kodi', password: 'kodipass' };

  const players = await kodi.listPlayers(c);
  check(players.length === 1 && players[0].name === 'Den LibreELEC' && players[0].product === 'Kodi', `lists the player (${JSON.stringify(players)})`);

  let err = null;
  try { await kodi.listPlayers({ ...c, password: 'wrong' }); } catch (e) { err = e; }
  check(err && /Settings > Services > Control/.test(err.message), `wrong password explains where to look (${err?.message})`);

  const seen = [];
  const tracker = {
    observe: (info, kind, p) => seen.push({ title: info.title, mediaType: info.mediaType, ...p }),
    sweep: () => {},
  };
  kodi.start(c, tracker, () => {}, () => {});
  const last = async () => { const n = seen.length; for (let i = 0; i < 40 && seen.length === n; i++) await wait(100); return seen[seen.length - 1]; };

  await set('play');
  let s = await last();
  check(s && !s.paused && s.title === 'The Expanse S1E1: Pilot' && s.mediaType === 'episode' && s.position === 125000 && s.runtime === 2640000, `playing an episode (${JSON.stringify(s)})`);
  await set('pause'); await wait(2100);
  s = await last();
  check(s && s.paused, `paused (${JSON.stringify(s)})`);
  await set('music'); await wait(2100);
  s = await last();
  check(s && !s.paused && s.mediaType === 'music' && s.title === 'Clair de Lune', `music (${JSON.stringify(s)})`);
  await set('stop'); await wait(2100);
  const n = seen.length; await wait(2500);
  check(seen.length === n, 'stopped: nothing reported as playing');
  check(kodi.status && JSON.stringify(kodi.status ? kodi.status() : {}).includes('Den LibreELEC'), 'Connections status names the player');

  kodi.stop();
  mocks.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'kodi test passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); mocks.kill(); process.exit(1); });
