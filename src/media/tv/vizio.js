'use strict';

// Vizio SmartCast TVs, through the TV's own HTTPS interface (port 7345, or 9000 on older sets).
// It says whether the TV is on and which input or app is showing, but not play or pause, so
// "TV on" counts as playing and "TV off" as stopped. Pairing shows a PIN on the TV.
// (Vizio TVs also have Chromecast built in: anything cast to one reports real play and pause
// under Chromecast.)

const https = require('https');
const { makeTv, ssdp, describe } = require('./common');

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true }); // the TV's certificate is self-signed
const PORTS = process.env.VIZIO_PORT ? [Number(process.env.VIZIO_PORT)] : [7345, 9000];
const portFor = new Map(); // host -> port that answered
const DEVICE_ID = 'photon-lights';
const pending = new Map(); // host -> { token, challenge } while a PIN is on screen

function req(host, method, path, { body, auth, port } = {}) {
  const p = port || portFor.get(host) || PORTS[0];
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = https.request({ host, port: p, method, path, agent, timeout: 3000,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(auth ? { AUTH: auth } : {}) } }, res => {
      let t = '';
      res.on('data', d => { t += d; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(t); } catch { /* not JSON */ }
        const result = String(j.STATUS?.RESULT || '').toUpperCase();
        if (result && result !== 'SUCCESS') {
          const e = new Error(result === 'INVALID_PARAMETER' || /AUTH|PIN|CHALLENGE/.test(result)
            ? 'the TV turned the PIN or Photon\'s key down. Pair again.' : `the TV said ${j.STATUS.RESULT}${j.STATUS.DETAIL ? ` (${j.STATUS.DETAIL})` : ''}`);
          e.auth = /AUTH|PIN|CHALLENGE|BLOCKED|INVALID/.test(result);
          return reject(e);
        }
        portFor.set(host, p);
        resolve(j);
      });
    });
    r.on('timeout', () => r.destroy(new Error('no answer')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function findPort(host) {
  if (portFor.has(host)) return portFor.get(host);
  for (const p of PORTS) {
    try { await req(host, 'GET', '/state/device/deviceinfo', { port: p }); return p; } catch (err) { if (err.auth) { portFor.set(host, p); return p; } }
  }
  throw new Error(`no Vizio SmartCast TV answered at ${host}`);
}

const tokenFor = (c, host) => (c.tokens || {})[host] || '';

async function read(c, host) {
  await findPort(host);
  const auth = tokenFor(c, host);
  const info = await req(host, 'GET', '/state/device/deviceinfo', { auth }).catch(() => ({}));
  const v = info.ITEMS?.[0]?.VALUE || {};
  const model = v.MODEL_NAME || v.SYSTEM_INFO?.MODEL_NAME || '';
  const id = v.SYSTEM_INFO?.SERIAL_NUMBER || v.SERIAL_NUMBER || host;
  return { id, name: v.FRIENDLY_NAME || `Vizio ${model || 'TV'}`.trim(), product: `Vizio${model ? ` ${model}` : ' TV'}`, auth };
}

module.exports = makeTv({
  id: 'vizio',
  label: 'Vizio',
  short: 'Vizio TVs',
  blurb: 'Vizio TVs say whether they are on and which input or app is showing, but not play or pause. Photon treats the TV turning on as "playing" and turning off as "stopped". For real play and pause, cast to it (it has Chromecast built in) or use its Plex app. Click Pair, then type the PIN the TV shows and click Finish pairing.',
  fields: [{ key: 'pin', label: 'PIN shown on the TV', placeholder: 'Click Pair first' }],
  actions: [{ id: 'pair', label: 'Pair (shows a PIN on the TV)' }, { id: 'finish', label: 'Finish pairing' }],
  async discover() {
    const list = await ssdp(['urn:dial-multiscreen-org:device:dial:1']);
    const out = [];
    await Promise.all(list.map(async d => { const x = await describe(d.location); if (/vizio/i.test(`${x.maker} ${x.name}`)) out.push({ host: d.host, name: x.name }); }));
    return out;
  },
  async action(id, c, hosts) {
    const host = hosts.find(h => !tokenFor(c, h)) || hosts[0];
    if (!host) throw new Error('Type the TV\'s IP address first, or click "Find on my network".');
    await findPort(host);
    if (id === 'pair') {
      const r = await req(host, 'PUT', '/pairing/start', { body: { DEVICE_ID: DEVICE_ID, DEVICE_NAME: 'Photon' } });
      pending.set(host, { token: r.ITEM?.PAIRING_REQ_TOKEN, challenge: r.ITEM?.CHALLENGE_TYPE ?? 1 });
      return { message: `The TV at ${host} should be showing a PIN now. Type it above and click Finish pairing.` };
    }
    if (id === 'finish') {
      const p = pending.get(host);
      if (!p) throw new Error('Click Pair first, so the TV shows a PIN.');
      const pin = String(c.pin || '').trim();
      if (!/^\d{3,8}$/.test(pin)) throw new Error('Type the PIN shown on the TV.');
      const r = await req(host, 'PUT', '/pairing/pair', { body: { DEVICE_ID: DEVICE_ID, CHALLENGE_TYPE: p.challenge, RESPONSE_VALUE: pin, PAIRING_REQ_TOKEN: p.token } });
      const token = r.ITEM?.AUTH_TOKEN;
      if (!token) throw new Error('The TV didn\'t accept the PIN. Click Pair to get a new one.');
      pending.delete(host);
      return { patch: { tokens: { ...(c.tokens || {}), [host]: token }, pin: '' }, message: `Paired with the Vizio TV at ${host}.` };
    }
    throw new Error(`unknown action ${id}`);
  },
  describe: (c, host) => read(c, host),
  async probe(c, host) {
    const d = await read(c, host);
    const power = await req(host, 'GET', '/state/device/power_mode', { auth: d.auth });
    const on = Number(power.ITEMS?.[0]?.VALUE) === 1;
    if (!on) return { ...d, state: 'off' };
    let input = '';
    try { input = (await req(host, 'GET', '/menu_native/dynamic/tv_settings/devices/current_input', { auth: d.auth })).ITEMS?.[0]?.VALUE || ''; } catch (err) { if (err.auth && !d.auth) { err.message = 'pair Photon with the TV to see which input is showing (click Pair).'; } }
    const title = !input ? 'Vizio TV on' : /smartcast|cast/i.test(input) ? 'SmartCast apps' : input;
    return { ...d, state: 'playing', title, mediaType: 'other' };
  },
});
