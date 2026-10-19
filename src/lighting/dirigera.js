'use strict';

// IKEA Home smart, through the DIRIGERA hub's local API (https://<hub>:8443/v1).
// Targets: "d<device id>" for a light or outlet, "r<room id>" for a room set up in the IKEA app.
// The hub uses a certificate signed by IKEA's own root, which is pinned below.

const https = require('https');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { clamp, guessShape, rgbToHs, sleep } = require('../util');

const IKEA_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICGDCCAZ+gAwIBAgIUdfH0KDnENv/dEcxH8iVqGGGDqrowCgYIKoZIzj0EAwMw
SzELMAkGA1UEBhMCU0UxGjAYBgNVBAoMEUlLRUEgb2YgU3dlZGVuIEFCMSAwHgYD
VQQDDBdJS0VBIEhvbWUgc21hcnQgUm9vdCBDQTAgFw0yMTA1MjYxOTAxMDlaGA8y
MDcxMDUxNDE5MDEwOFowSzELMAkGA1UEBhMCU0UxGjAYBgNVBAoMEUlLRUEgb2Yg
U3dlZGVuIEFCMSAwHgYDVQQDDBdJS0VBIEhvbWUgc21hcnQgUm9vdCBDQTB2MBAG
ByqGSM49AgEGBSuBBAAiA2IABIDRUvKGFMUu2zIhTdgfrfNcPULwMlc0TGSrDLBA
oTr0SMMV4044CRZQbl81N4qiuHGhFzCnXapZogkiVuFu7ZqSslsFuELFjc6ZxBjk
Kmud+pQM6QQdsKTE/cS06dA+P6NCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E
FgQUcdlEnfX0MyZA4zAdY6CLOye9wfwwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49
BAMDA2cAMGQCMG6mFIeB2GCFch3r0Gre4xRH+f5pn/bwLr9yGKywpeWvnUPsQ1KW
ckMLyxbeNPXdQQIwQc2YZDq/Mz0mOkoheTUWiZxK2a5bk0Uz1XuGshXmQvEg5TGy
2kVHW/Mz9/xwpy4u
-----END CERTIFICATE-----`;

// Tests point this at a stand-in hub with its own certificate.
const extraCa = process.env.DIRIGERA_EXTRA_CA ? [fs.readFileSync(process.env.DIRIGERA_EXTRA_CA, 'utf8')] : [];
// The hub's certificate names the hub's serial number, not its address, so only the root is checked.
const agent = new https.Agent({ ca: [IKEA_ROOT_CA, ...extraCa], checkServerIdentity: () => undefined, keepAlive: true });

const hostOf = c => String(c.hubIp || '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');

function request(c, method, path, { json, form, token = c.token, timeout = 6000 } = {}) {
  const host = hostOf(c);
  const body = json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : null;
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) {
    headers['Content-Type'] = json !== undefined ? 'application/json' : 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port: Number(c.port) || 8443, path: `/v1/${path}`, method, headers, agent, timeout }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (res.statusCode >= 400) {
          const msg = res.statusCode === 401 ? 'the hub no longer accepts Photon\'s key. Pair again.' : (typeof data === 'object' && data?.error) || String(text).slice(0, 160);
          const err = new Error(`IKEA hub: ${res.statusCode} ${msg}`);
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no response from the IKEA hub at ${host}`)));
    req.on('error', err => {
      const code = err.code;
      reject(new Error(code === 'ECONNREFUSED' ? `the IKEA hub at ${host} refused the connection`
        : code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' ? `can't reach the IKEA hub at ${host}`
        : code === 'EPROTO' || /^ERR_SSL|CERT/.test(code || '') || /certificate|self.signed|unable to verify|SSL routines/i.test(err.message) ? `${host} doesn't look like an IKEA DIRIGERA hub (its certificate isn't IKEA's)`
        : err.message));
    });
    if (body) req.write(body);
    req.end();
  });
}

const isControllable = d => (d.type === 'light' || d.type === 'outlet' || d.deviceType === 'light' || d.deviceType === 'outlet') && !d.isHidden;
const can = (d, attr) => (d.capabilities?.canReceive || []).includes(attr);

// One short cache so a room change doesn't fetch the device list once per light.
let cache = { at: 0, key: '', devices: null };
async function devices(c, fresh = false) {
  const key = `${hostOf(c)}|${c.token}`;
  if (!fresh && cache.devices && cache.key === key && Date.now() - cache.at < 3000) return cache.devices;
  const list = (await request(c, 'GET', 'devices')).filter(isControllable);
  cache = { at: Date.now(), key, devices: list };
  return list;
}

async function membersOf(c, id) {
  if (!id.startsWith('r')) return [id];
  const roomId = id.slice(1);
  return (await devices(c)).filter(d => d.room?.id === roomId).map(d => `d${d.id}`);
}

// The hub takes one attribute change per request most reliably, so changes go one after another.
async function patch(c, deviceId, attributes, transitionTime) {
  const item = { attributes };
  if (transitionTime != null) item.transitionTime = transitionTime;
  return request(c, 'PATCH', `devices/${encodeURIComponent(deviceId)}`, { json: [item] });
}

async function applyOne(c, d, state) {
  const ms = Math.round((state.transition ?? 0.4) * 1000);
  const a = d.attributes || {};
  if (!state.on) return patch(c, d.id, { isOn: false });
  if (!a.isOn) await patch(c, d.id, { isOn: true });
  if (d.type === 'outlet' || d.deviceType === 'outlet') return;
  if (state.brightness != null && can(d, 'lightLevel')) await patch(c, d.id, { lightLevel: clamp(Math.round(state.brightness), 1, 100) }, ms);
  if (state.rgb && can(d, 'colorHue')) {
    const [h, s] = rgbToHs(state.rgb);
    await patch(c, d.id, { colorHue: h, colorSaturation: +(s / 100).toFixed(2) }, ms);
  } else if ((state.kelvin || state.rgb) && can(d, 'colorTemperature')) {
    const lo = Math.min(a.colorTemperatureMin ?? 2202, a.colorTemperatureMax ?? 4000);
    const hi = Math.max(a.colorTemperatureMin ?? 2202, a.colorTemperatureMax ?? 4000);
    await patch(c, d.id, { colorTemperature: clamp(Math.round(state.kelvin || 2700), lo, hi) }, ms);
  }
}

module.exports = {
  id: 'dirigera',
  label: 'IKEA Home smart',
  blurb: 'Uses the IKEA DIRIGERA hub on your network. Rooms you made in the IKEA Home smart app show up as groups.',
  fields: [
    { key: 'hubIp', label: 'DIRIGERA hub IP address', placeholder: '192.168.1.30 (IKEA app > Hub settings)' },
    { key: 'token', label: 'Access key', placeholder: 'Filled in when you pair', secret: true },
  ],
  actions: [
    { id: 'pair', label: 'Pair (click, then press the button under the hub)' },
  ],

  configured: c => Boolean(hostOf(c) && c.token),

  async action(id, c) {
    if (id !== 'pair') throw new Error(`unknown action ${id}`);
    if (!hostOf(c)) throw new Error('Enter the hub IP first. It is in the IKEA Home smart app under Hub settings, or in your router\'s device list.');
    const verifier = crypto.randomBytes(96).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ audience: 'homesmart.local', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
    const { code } = await request(c, 'GET', `oauth/authorize?${q}`, { token: null });
    if (!code) throw new Error('The hub did not start pairing. Try again.');
    // The hub waits for its action button (on the bottom) to be pressed. Keep asking for up to 60 seconds.
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      try {
        const res = await request(c, 'POST', 'oauth/token', {
          token: null,
          form: { code, name: `Photon on ${os.hostname()}`, grant_type: 'authorization_code', code_verifier: verifier },
        });
        if (res?.access_token) return { patch: { token: res.access_token }, message: 'Paired with the IKEA hub' };
      } catch (err) {
        if (!err.status) throw err; // network trouble, not "button not pressed yet"
      }
      await sleep(1000);
    }
    throw new Error('The hub button wasn\'t pressed in time. Click Pair again, then press the action button on the bottom of the hub within a minute.');
  },

  async list(c) {
    const [list, scenes] = await Promise.all([devices(c, true), request(c, 'GET', 'scenes').catch(() => [])]);
    const rooms = new Map();
    const targets = [];
    for (const d of list) {
      const a = d.attributes || {};
      const outlet = d.type === 'outlet' || d.deviceType === 'outlet';
      if (d.room?.id) {
        const r = rooms.get(d.room.id) || { name: d.room.name, members: [] };
        r.members.push(`d${d.id}`);
        rooms.set(d.room.id, r);
      }
      targets.push({
        id: `d${d.id}`, name: a.customName || a.model || 'IKEA light', type: outlet ? 'plug' : 'light',
        detail: a.model || (outlet ? 'Outlet' : 'Light'), reachable: d.isReachable !== false,
        ...(outlet ? {} : { shape: guessShape(`${a.model || ''} ${a.customName || ''}`) }),
        caps: { dim: !outlet && can(d, 'lightLevel'), temp: can(d, 'colorTemperature'), color: can(d, 'colorHue') },
      });
    }
    for (const [rid, r] of rooms) {
      targets.unshift({ id: `r${rid}`, name: r.name, type: 'room', detail: `${r.members.length} devices`, members: r.members, caps: { dim: true, temp: true, color: true } });
    }
    const sceneList = (Array.isArray(scenes) ? scenes : [])
      .filter(s => s.info?.name)
      .map(s => ({ id: s.id, name: s.info.name }));
    return { targets, scenes: sceneList };
  },

  async apply(c, id, state) {
    const ids = new Set((await membersOf(c, id)).map(m => m.slice(1)));
    const list = (await devices(c)).filter(d => ids.has(d.id));
    if (!list.length) throw new Error('IKEA hub: that light or room was not found. It may have been removed in the IKEA app.');
    await Promise.all(list.map(d => applyOne(c, d, state)));
    cache.at = 0; // states just changed
  },

  members: (c, id) => membersOf(c, id),

  async snapshot(c, id) {
    const ids = new Set((await membersOf(c, id)).map(m => m.slice(1)));
    const out = {};
    for (const d of await devices(c, true)) {
      if (!ids.has(d.id)) continue;
      const a = d.attributes || {};
      out[d.id] = { isOn: a.isOn, lightLevel: a.lightLevel, colorMode: a.colorMode, colorTemperature: a.colorTemperature, colorHue: a.colorHue, colorSaturation: a.colorSaturation };
    }
    return out;
  },

  async restore(c, id, snap, transition) {
    const ms = Math.round((transition ?? 0.4) * 1000);
    const list = await devices(c, true);
    await Promise.all(Object.entries(snap || {}).map(async ([did, s]) => {
      const d = list.find(x => x.id === did);
      if (!d) return;
      if (!s.isOn) return patch(c, did, { isOn: false });
      await patch(c, did, { isOn: true });
      if (s.lightLevel != null && can(d, 'lightLevel')) await patch(c, did, { lightLevel: s.lightLevel }, ms);
      if (s.colorMode === 'color' && s.colorHue != null && can(d, 'colorHue')) await patch(c, did, { colorHue: s.colorHue, colorSaturation: s.colorSaturation }, ms);
      else if (s.colorTemperature != null && can(d, 'colorTemperature')) await patch(c, did, { colorTemperature: s.colorTemperature }, ms);
    }));
    cache.at = 0;
  },

  async scene(c, sceneId) {
    return request(c, 'POST', `scenes/${encodeURIComponent(sceneId)}/trigger`);
  },
};
