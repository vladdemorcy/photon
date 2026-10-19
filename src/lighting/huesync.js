'use strict';

// Philips Hue Play HDMI Sync Box (and the 8K model), over its local API.
//
// The box colors the Hue lights in its entertainment area from the picture on the TV. Photon
// doesn't color those lights itself while the box syncs; it starts and stops syncing at the
// right moments (see "TV sync box" in a room) and sets the mode, intensity and brightness.
//
// The box answers on HTTPS with its own certificate, which no browser or computer trusts.
// Photon remembers the certificate it saw when pairing and refuses a different one later, so
// nothing else on the network can pose as the box and collect its access token.
//
// Target id: "box". A room picks it as its sync box; it isn't a light to place on a plan.

const http = require('http');
const tls = require('tls');
const crypto = require('crypto');

const INTENSITIES = ['subtle', 'moderate', 'high', 'intense'];
const MODES = ['video', 'music', 'game'];

// Opens a TLS connection and checks the certificate before anything is sent on it, so the
// access token only ever goes to the box Photon paired with.
function connect(host, port, expected) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, servername: /^[\d.]+$/.test(host) ? undefined : host });
    const timer = setTimeout(() => sock.destroy(new Error(`no response from the sync box at ${host}`)), 6000);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const fp = sock.getPeerCertificate()?.fingerprint256 || '';
      if (expected && fp !== expected) {
        sock.destroy();
        reject(new Error('The sync box answered with a different certificate than when you paired it. If you replaced or reset the box, pair it again.'));
        return;
      }
      resolve({ sock, fingerprint: fp });
    });
    sock.once('error', err => { clearTimeout(timer); reject(err.code === 'ECONNREFUSED' ? new Error(`connection refused by ${host}`) : err); });
  });
}

async function request(c, method, path, body, { pin = true } = {}) {
  const [host, port] = String(c.ip || '').split(':');
  if (!host) throw new Error('Enter the sync box\'s IP address first');
  if (pin && !c.certFingerprint) throw new Error('Pair the sync box again (Photon needs to remember its certificate).');
  const { sock, fingerprint } = await connect(host, Number(port) || 443, pin ? c.certFingerprint : null);
  const payload = body !== undefined ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, method, path: `/api/v1${path}`, createConnection: () => sock, timeout: 6000,
      headers: {
        Host: host, Accept: 'application/json', Connection: 'close',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(c.accessToken && pin ? { Authorization: `Bearer ${c.accessToken}` } : {}),
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; if (text.length > 1e6) res.destroy(); });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (res.statusCode >= 400) {
          const err = new Error(data?.message || `the sync box answered ${res.statusCode}`);
          err.status = res.statusCode;
          err.code = data?.code;
          reject(err);
          return;
        }
        resolve({ data, fingerprint });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no response from the sync box at ${host}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  id: 'huesync',
  label: 'Hue Sync Box',
  blurb: 'The Philips Hue Play HDMI Sync Box. Photon starts and stops syncing with playback; pick it in a room under Room settings > TV sync box.',
  fields: [
    { key: 'ip', label: 'Sync box IP address', placeholder: '192.168.1.30' },
    { key: 'accessToken', label: 'Access token', placeholder: 'Filled in when you pair', secret: true },
  ],
  actions: [{ id: 'pair', label: 'Pair (then hold the box\'s button for 3 seconds)' }],
  kind: 'sync',

  configured: c => Boolean(c.ip && c.accessToken),

  async action(id, c) {
    if (id !== 'pair') throw new Error(`unknown action ${id}`);
    if (!c.ip) throw new Error('Enter the sync box\'s IP address first (Hue Sync app > the box > Settings > Device info, or your router\'s device list).');
    const body = { appName: 'photon', instanceName: 'Photon', appSecret: crypto.randomBytes(16).toString('base64') };
    // The box answers with an error until its button has been held, so keep asking for a minute.
    const until = Date.now() + 60e3;
    let last;
    while (Date.now() < until) {
      try {
        const { data, fingerprint } = await request({ ip: c.ip }, 'POST', '/registrations', body, { pin: false });
        if (data?.accessToken) {
          return {
            patch: { accessToken: data.accessToken, registrationId: String(data.registrationId || ''), certFingerprint: fingerprint },
            message: 'Paired with the Hue Sync Box',
          };
        }
      } catch (err) {
        last = err;
        if (!err.status) throw new Error(`Can't reach the sync box at ${c.ip}: ${err.message}`);
      }
      await sleep(2000);
    }
    throw new Error(`The sync box didn't accept pairing${last ? ` (${last.message})` : ''}. Hold its button for about 3 seconds until the light blinks green, within a minute of clicking Pair.`);
  },

  async list(c) {
    const { data } = await request(c, 'GET', '');
    const ex = data?.execution || {};
    return {
      targets: [{
        id: 'box', name: data?.device?.name || 'Hue Sync Box', type: 'sync',
        detail: `${ex.syncActive ? `syncing (${ex.mode})` : 'not syncing'}, input ${String(ex.hdmiSource || '').replace('input', '')}`,
        caps: { modes: MODES, intensities: INTENSITIES, brightness: true },
      }],
      scenes: [],
    };
  },

  // Starts or stops syncing. mode: video | music | game; intensity: subtle..intense;
  // brightness: 0-100 (the box uses 0-200).
  async syncSet(c, id, { on, mode, intensity, brightness }) {
    if (!on) { await request(c, 'PUT', '/execution', { syncActive: false }); return; }
    const body = { syncActive: true };
    if (MODES.includes(mode)) body.mode = mode;
    if (INTENSITIES.includes(intensity)) body.intensity = intensity;
    if (brightness != null) body.brightness = Math.max(0, Math.min(200, Math.round(Number(brightness) * 2)));
    await request(c, 'PUT', '/execution', body);
  },

  async syncState(c) {
    const { data } = await request(c, 'GET', '');
    const ex = data?.execution || {};
    return { on: Boolean(ex.syncActive), mode: ex.mode };
  },

  // The Hue lights the box colors: the lights of its entertainment area on the Hue Bridge.
  async syncLights(c, id, all) {
    const { data } = await request(c, 'GET', '');
    const groupId = data?.hue?.groupId;
    const hue = all?.hue;
    if (!groupId || !hue?.enabled || !hue.bridgeIp || !hue.username) return [];
    const { http } = require('../util');
    if (/^\d+$/.test(String(groupId))) {
      const g = await http('GET', `http://${hue.bridgeIp}/api/${hue.username}/groups/${groupId}`);
      return (g?.lights || []).map(l => `hue::l${l}`);
    }
    // Newer bridges name entertainment areas with an ID from Hue's newer API.
    const g = await http('GET', `http://${hue.bridgeIp}/api/${hue.username}/groups`);
    const match = Object.entries(g || {}).find(([, x]) => x.type === 'Entertainment' && (x.name === data?.hue?.groups?.[groupId]?.name));
    return match ? match[1].lights.map(l => `hue::l${l}`) : [];
  },
};
