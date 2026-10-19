'use strict';
// Checks TV sync boxes (Hue Sync Box and Govee DreamView) against the stand-ins in mocks.js.
// Start the mocks, and Photon with GOVEE_CLOUD_URL=http://127.0.0.1:8126 and a password set:
//   node test/sync-test.js http://127.0.0.1:18830 "the password"
const BASE = process.argv[2] || 'http://127.0.0.1:18830';
const PASSWORD = process.argv[3];
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}`); if (!cond) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cookie = '';
let csrf = '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(method !== 'GET' ? { 'X-Photon-CSRF': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.status); e.status = res.status; throw e; }
  return data;
}
const mockCalls = async () => (await fetch('http://127.0.0.1:8099/calls')).json();
const since = async n => (await mockCalls()).slice(n);

async function saveConfig(change) {
  const c = await api('GET', '/api/config');
  change(c);
  await api('PUT', '/api/config', c);
  return api('GET', '/api/config');
}

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  csrf = (await api('GET', '/api/auth/state')).csrf;

  let c = await saveConfig(cf => {
    cf.lighting.hue = { ...cf.lighting.hue, enabled: true, bridgeIp: '127.0.0.1:8099', username: 'testkey' };
    cf.lighting.huesync = { ...cf.lighting.huesync, enabled: true, ip: '127.0.0.1:8444' };
    cf.lighting.govee = { ...cf.lighting.govee, enabled: true, lan: false, apiKey: 'gkey' };
  });

  // Pairing: the box says no until its button is held (the stand-in says yes on the second try).
  const pair = await api('POST', '/api/lighting/huesync/action/pair', { config: c.lighting.huesync });
  ok(/Paired/.test(pair.message), `Hue Sync Box pairs (${pair.message})`);
  c = await api('GET', '/api/config');
  ok(c.lighting.huesync.accessToken === '__photon_saved__', 'its access token stays on the server');
  ok(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(c.lighting.huesync.certFingerprint || ''), 'its certificate is remembered');

  const targets = await api('GET', '/api/targets');
  const all = targets.flatMap(p => p.targets.map(t => ({ ...t, key: `${p.id}::${t.id}` })));
  ok(all.some(t => t.key === 'huesync::box' && t.type === 'sync'), 'the Hue Sync Box is listed as a sync box');
  ok(all.some(t => t.key === 'govee::AA:BB:CC:DD#sync' && t.type === 'sync'), 'the Govee device with DreamView is listed as a sync box');

  const found = await api('GET', '/api/sync/lights?box=huesync::box');
  ok(JSON.stringify(found.lights) === JSON.stringify(['hue::l1', 'hue::l4']), `the box's lights are found from its entertainment area (${found.lights})`);

  const rules = await api('GET', '/api/default-rules');
  c = await saveConfig(cf => {
    cf.rooms = [
      { name: 'Living room', players: ['plex:tv1'], targets: ['hue::g1'], stopDelaySeconds: 0, rules: JSON.parse(JSON.stringify(rules)),
        sync: { box: 'huesync::box', mode: 'auto', intensity: 'high', brightness: 80, lights: ['hue::l1', 'hue::l4'] } },
      { name: 'Den', players: ['plex:tv2'], targets: ['govee::AA:BB:CC:DD'], stopDelaySeconds: 0, rules: JSON.parse(JSON.stringify(rules)),
        sync: { box: 'govee::AA:BB:CC:DD#sync', lights: ['govee::AA:BB:CC:DD'] } },
    ];
    // Daytime behaviors would leave the lights alone; turn time limits off for the test.
    for (const r of cf.rooms) for (const rule of r.rules) rule.schedule.enabled = false;
  });
  const [living, den] = c.rooms;

  // Plays: the box starts syncing; Photon sets the room's other lights only.
  let n = (await mockCalls()).length;
  await api('POST', `/api/rooms/${living.id}/simulate`, { event: 'play' });
  let calls = await since(n);
  const box = calls.filter(x => x[0] === 'sync-box').map(x => x[1]);
  ok(box.some(b => b.syncActive === true && b.mode === 'video' && b.intensity === 'high' && b.brightness === 160), `play starts syncing in video mode (${JSON.stringify(box)})`);
  const lit = calls.filter(x => x[0] === 'hue-light').map(x => x[1]).sort();
  ok(JSON.stringify(lit) === JSON.stringify(['2', '6']), `only the lights the box doesn't color are dimmed (${lit})`);
  ok(!calls.some(x => x[0] === 'hue-group'), 'the whole room group isn\'t set while the box syncs');
  ok((await api('GET', '/api/status')).find(s => s.id === living.id).syncing === true, 'the room shows it\'s syncing');

  // Paused: syncing stops first, then all the room's lights come up.
  n = (await mockCalls()).length;
  await api('POST', `/api/rooms/${living.id}/simulate`, { event: 'pause' });
  calls = await since(n);
  const iOff = calls.findIndex(x => x[0] === 'sync-box' && x[1].syncActive === false);
  const iGroup = calls.findIndex(x => x[0] === 'hue-group' && x[1] === '1');
  ok(iOff >= 0 && iGroup > iOff, 'pause stops syncing, then sets the whole room');

  n = (await mockCalls()).length;
  await api('POST', `/api/rooms/${living.id}/simulate`, { event: 'resume' });
  calls = await since(n);
  ok(calls.some(x => x[0] === 'sync-box' && x[1].syncActive === true), 'resume starts syncing again');
  n = (await mockCalls()).length;
  await api('POST', `/api/rooms/${living.id}/simulate`, { event: 'stop' });
  await sleep(800);
  calls = await since(n);
  ok(calls.some(x => x[0] === 'sync-box' && x[1].syncActive === false), 'stop turns syncing off (it was off before playback)');

  // A behavior can leave the box alone.
  await saveConfig(cf => { cf.rooms[0].rules.find(r => r.enabled && r.events.includes('play')).action.sync = 'leave'; });
  n = (await mockCalls()).length;
  await api('POST', `/api/rooms/${living.id}/simulate`, { event: 'play' });
  calls = await since(n);
  ok(!calls.some(x => x[0] === 'sync-box'), '"Leave it as it is" doesn\'t touch the box');
  await api('POST', `/api/rooms/${living.id}/simulate`, { event: 'stop' });
  await sleep(500);

  // Govee DreamView.
  n = (await mockCalls()).length;
  await api('POST', `/api/rooms/${den.id}/simulate`, { event: 'play' });
  calls = await since(n);
  ok(calls.some(x => x[0] === 'govee' && x[2].instance === 'dreamViewToggle' && x[2].value === 1), 'play switches Govee DreamView on');
  ok(!calls.some(x => x[0] === 'govee' && x[2].instance === 'brightness'), 'Photon doesn\'t set the Govee light while DreamView colors it');
  n = (await mockCalls()).length;
  await api('POST', `/api/rooms/${den.id}/simulate`, { event: 'pause' });
  calls = await since(n);
  ok(calls.some(x => x[0] === 'govee' && x[2].instance === 'dreamViewToggle' && x[2].value === 0), 'pause switches DreamView off');

  // Trying it from Room settings.
  const tryOn = await api('POST', `/api/rooms/${living.id}/sync`, { on: true });
  ok(/Started syncing/.test(tryOn.message), `"Start syncing" in Room settings works (${tryOn.message})`);

  // Another device posing as the box (a different certificate) never gets the token.
  await saveConfig(cf => { cf.lighting.huesync.certFingerprint = 'AA:'.repeat(31) + 'AA'; });
  let err = '';
  try { await api('POST', `/api/rooms/${living.id}/sync`, { on: false }); } catch (e) { err = e.message; }
  ok(/different certificate/.test(err), `a box with a different certificate is refused (${err})`);

  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
