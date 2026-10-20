'use strict';

// Wyze bulbs, color bulbs and light strips, through Wyze's cloud (the same service the Wyze app
// uses). Wyze has no local interface Photon can use, so every change goes through the internet
// and takes about a second. Signing in needs the Wyze account's email and password plus a free
// API key from developer-api-console.wyze.com. Targets: "<MAC>".
//
// Light types Wyze reports: Light (the original white bulb), MeshLight (Bulb Color and newer
// bulbs), LightStrip (Light Strip and Light Strip Pro). Properties: P3 power, P1501 brightness
// 1-100, P1502 color temperature in kelvin, P1507 color as RRGGBB, P1508 1 = color, 2 = white.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { http, clamp, rgbToHex, guessShape } = require('../util');

const AUTH = () => process.env.WYZE_AUTH_URL || 'https://auth-prod.api.wyze.com';
const API = () => process.env.WYZE_API_URL || 'https://api.wyzecam.com';
const APP_KEY = 'WMXHYf79Nr5gIlt3r0r7p9Tcw5bvs6BB4U8O8nGJ';
const APP = { app_name: 'com.hualai.WyzeCam', app_version: '2.18.43', app_ver: 'com.hualai.WyzeCam___2.18.43', phone_system_type: '1', sc: '9f275790cab94a72bd206c8876429f3c', sv: '9d74946e652647e9b6c9d59326aef104' };
// The bulk endpoint the original white bulb needs for on/off is signed with a different pair.
const APP_BULK = { ...APP, sc: 'a626948714654991afd3c0dbd7cdb901', sv: 'ddb9baef0d7f44379cd6bfaa8698e682' };

const LIGHT_TYPES = { Light: 'white', MeshLight: 'mesh', LightStrip: 'strip', Plug: 'plug', OutdoorPlug: 'plug' };
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const hashPassword = p => md5(md5(md5(String(p || ''))));

// The signed-in session lives next to Photon's settings, readable only by Photon, so it lasts
// through restarts and token refreshes without writing to the settings file.
const SESSION_FILE = () => path.join(path.dirname(process.env.CONFIG_PATH || path.join(__dirname, '..', '..', 'data', 'config.json')), 'wyze-session.json');
let session = null;
function loadSession() {
  if (session) return session;
  try { session = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8')); } catch { session = {}; }
  if (!session.phoneId) session.phoneId = crypto.randomUUID();
  return session;
}
function saveSession(patch) {
  session = { ...loadSession(), ...patch };
  try { fs.writeFileSync(SESSION_FILE(), JSON.stringify(session, null, 2), { mode: 0o600 }); } catch { /* kept in memory */ }
}
const sameAccount = c => loadSession().email && loadSession().email === String(c.email || '').trim().toLowerCase();

// A pending two-step sign-in, waiting for the code (kept in memory only).
let pendingMfa = null;

const SIGN_IN_AGAIN = 'Wyze needs you to sign in again: click "Sign in to Wyze".';

async function login(c) {
  const email = String(c.email || '').trim().toLowerCase();
  if (!email || !c.password) throw new Error('Enter your Wyze email and password first.');
  if (!c.keyId || !c.apiKey) throw new Error('Enter your Wyze API key and its key ID (from developer-api-console.wyze.com).');
  const code = String(c.code || '').replace(/\s/g, '');
  let r;
  try {
    if (code && pendingMfa && pendingMfa.email === email) {
      r = await http('POST', `${AUTH()}/user/login`, {
        headers: { 'X-API-Key': APP_KEY, 'Phone-Id': loadSession().phoneId, 'User-Agent': 'wyze_android_2.19.14' },
        body: { email, password: hashPassword(c.password), mfa_type: pendingMfa.type, verification_id: pendingMfa.id, verification_code: code },
        timeout: 10000,
      });
    } else {
      r = await http('POST', `${AUTH()}/api/user/login`, {
        headers: { 'X-API-Key': APP_KEY, keyid: String(c.keyId).trim(), apikey: String(c.apiKey).trim(), 'User-Agent': 'photon' },
        body: { email, password: hashPassword(c.password) },
        timeout: 10000,
      });
    }
  } catch (err) {
    if (code && pendingMfa && err.status >= 400 && err.status < 500) throw new Error('Wyze didn\'t accept that code. Check it and try again, or clear the code and click "Sign in to Wyze" to get a new one.');
    if (err.status === 400 || err.status === 401 || err.status === 403) throw new Error(`Wyze refused the sign-in. Check the email, password, API key and key ID. (${err.message})`);
    throw new Error(`Couldn't reach Wyze: ${err.message}`);
  }
  if (r?.errorCode != null) {
    if (Number(r.errorCode) === 1000) throw new Error('Wyze says the email or password is wrong.');
    throw new Error(`Wyze refused the sign-in: ${r.description || r.msg || r.errorCode}. Check the API key and key ID.`);
  }
  if (r?.mfa_options && !r.access_token) {
    // Remember that this account needs a code, so Photon never starts a sign-in (and with
    // text messages, sends a text) on its own in the background.
    saveSession({ mfaEmail: email });
    if (r.mfa_options.includes('TotpVerificationCode')) {
      pendingMfa = { email, type: 'TotpVerificationCode', id: r.mfa_details?.totp_apps?.[0]?.app_id };
      return { needsCode: 'Your Wyze account uses two-step verification. Type the 6-digit code from your authenticator app in "Verification code" and click "Sign in to Wyze" again.' };
    }
    if (r.mfa_options.includes('PrimaryPhone')) {
      // Wyze takes this one as a form, not JSON.
      const res = await fetch(`${AUTH()}/user/login/sendSmsCode`, {
        method: 'POST',
        headers: { 'X-API-Key': APP_KEY, keyid: String(c.keyId).trim(), apikey: String(c.apiKey).trim(), 'User-Agent': 'photon', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ mfaPhoneType: 'Primary', sessionId: r.sms_session_id || '', userId: r.user_id || '' }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      const sms = await res.json().catch(() => ({}));
      pendingMfa = { email, type: 'PrimaryPhone', id: sms?.session_id };
      return { needsCode: 'Wyze texted a code to your phone. Type it in "Verification code" and click "Sign in to Wyze" again.' };
    }
    throw new Error('Wyze asked for a kind of two-step verification Photon doesn\'t support. Use an authenticator app or text messages in the Wyze app\'s account security settings.');
  }
  if (!r?.access_token) throw new Error('Wyze didn\'t sign in. Check the email, password, API key and key ID.');
  pendingMfa = null;
  saveSession({ email, access: r.access_token, refresh: r.refresh_token, at: Date.now() });
  return { ok: true };
}

async function refresh() {
  const s = loadSession();
  if (!s.refresh) return false;
  try {
    const r = await http('POST', `${API()}/app/user/refresh_token`, { body: { ...APP, phone_id: s.phoneId, ts: Date.now(), refresh_token: s.refresh }, timeout: 10000 });
    if (String(r?.code) !== '1' || !r.data?.access_token) return false;
    saveSession({ access: r.data.access_token, refresh: r.data.refresh_token || s.refresh, at: Date.now() });
    return true;
  } catch { return false; }
}

// A call to Wyze's app API, signing in or refreshing the session when needed.
// Signs in again by itself, unless the account needs a code (then the person has to click).
async function autoLogin(c) {
  if (loadSession().mfaEmail === String(c.email || '').trim().toLowerCase()) throw new Error(SIGN_IN_AGAIN);
  return login({ ...c, code: '' });
}

async function api(c, endpoint, body = {}, app = APP) {
  if (!sameAccount(c) || !loadSession().access) {
    const r = await autoLogin(c);
    if (r.needsCode) throw new Error(SIGN_IN_AGAIN);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = loadSession();
    const r = await http('POST', `${API()}${endpoint}`, { body: { ...app, phone_id: s.phoneId, ts: Date.now(), access_token: s.access, ...body }, timeout: 10000 });
    const code = String(r?.code ?? '');
    if (code === '1') return r.data;
    if (code === '2001' && attempt === 0) {
      if (await refresh()) continue;
      const again = await autoLogin(c).catch(() => ({ needsCode: true }));
      if (again.needsCode) throw new Error(SIGN_IN_AGAIN);
      continue;
    }
    if (code === '3019') throw Object.assign(new Error('this Wyze light is offline'), { offline: true });
    if (code === '1001') throw new Error(`Wyze didn't accept the request: ${r.msg || 'parameter error'}`);
    throw new Error(`Wyze: ${r?.msg || r?.description || 'unknown error'} (${code || 'no code'})`);
  }
  throw new Error(SIGN_IN_AGAIN);
}

// The device list changes rarely and Wyze limits how often it can be asked, so keep it a minute.
let devCache = { at: 0, list: [] };
async function devices(c, fresh) {
  if (!fresh && Date.now() - devCache.at < 60e3 && devCache.email === loadSession().email) return devCache.list;
  const data = await api(c, '/app/v2/home_page/get_object_list');
  const list = (data?.device_list || []).filter(d => LIGHT_TYPES[d.product_type]);
  devCache = { at: Date.now(), list, email: loadSession().email };
  return list;
}
async function device(c, mac) {
  let d = (await devices(c)).find(x => x.mac === mac);
  if (!d) d = (await devices(c, true)).find(x => x.mac === mac);
  if (!d) throw new Error(`Wyze doesn't list a light with MAC ${mac} on this account anymore`);
  return d;
}

const pid = (p, v) => ({ pid: p, pvalue: String(v) });
const kelvinRange = kind => (kind === 'white' ? [2700, 6500] : [1800, 6500]);

// Sends a list of properties the way each kind of Wyze light takes them.
async function send(c, d, plist) {
  const kind = LIGHT_TYPES[d.product_type];
  if (kind === 'mesh' || kind === 'strip') {
    return api(c, '/app/v2/auto/run_action_list', {
      action_list: [{ instance_id: d.mac, provider_key: d.product_model, action_key: 'set_mesh_property', action_params: { list: [{ mac: d.mac, plist }] } }],
    });
  }
  // The original white bulb and plugs: on/off only works through the bulk endpoint; the rest
  // goes through the single-device one.
  const power = plist.filter(p => p.pid === 'P3');
  const rest = plist.filter(p => p.pid !== 'P3');
  if (rest.length) await api(c, '/app/v2/device/set_property_list', { device_mac: d.mac, device_model: d.product_model, property_list: rest });
  if (power.length) await api(c, '/app/v2/device_list/set_property_list', { device_list: [{ device_mac: d.mac, device_model: d.product_model, property_list: power }] }, APP_BULK);
}

module.exports = {
  id: 'wyze',
  label: 'Wyze',
  blurb: 'Wyze Bulb, Bulb Color, Light Strip and Light Strip Pro (and Wyze plugs), through your Wyze account. Wyze lights only take commands through Wyze\'s cloud, so changes land about a second later than with lights Photon controls on your network. You need a free API key: sign in at developer-api-console.wyze.com with your Wyze account, create a key, and copy the API key and its key ID here.',
  fields: [
    { key: 'email', label: 'Wyze email', placeholder: 'The email you sign in to the Wyze app with' },
    { key: 'password', label: 'Wyze password', placeholder: 'Your Wyze account password', secret: true },
    { key: 'keyId', label: 'Key ID', placeholder: 'developer-api-console.wyze.com > your key > Key ID' },
    { key: 'apiKey', label: 'API key', placeholder: 'Shown once when you create the key', secret: true },
    { key: 'code', label: 'Verification code (only if Wyze asks for one)', placeholder: 'From your authenticator app or a text' },
  ],
  actions: [{ id: 'signin', label: 'Sign in to Wyze' }],

  configured: c => Boolean(c.email && c.password && c.keyId && c.apiKey),

  async action(id, c) {
    if (id !== 'signin') throw new Error(`unknown action ${id}`);
    const r = await login(c);
    if (r.needsCode) return { message: r.needsCode };
    const list = await devices(c, true);
    return { message: `Signed in to Wyze. Found ${list.length} light(s) and plug(s).`, patch: { code: '' } };
  },

  async list(c) {
    const list = await devices(c, true);
    return {
      targets: list.map(d => {
        const kind = LIGHT_TYPES[d.product_type];
        const plug = kind === 'plug';
        return {
          id: d.mac, name: d.nickname || d.product_model, type: plug ? 'plug' : 'light',
          detail: `Wyze ${d.product_model}`, reachable: d.conn_state !== 0,
          ...(plug ? {} : { shape: kind === 'strip' ? 'strip' : guessShape(d.nickname || '') }),
          caps: plug ? {} : { dim: true, temp: true, color: kind !== 'white', kelvin: kelvinRange(kind) },
        };
      }),
      scenes: [],
    };
  },

  async apply(c, mac, state) {
    const d = await device(c, mac);
    const kind = LIGHT_TYPES[d.product_type];
    if (!state.on) return send(c, d, [pid('P3', 0)]);
    const plist = [pid('P3', 1)];
    if (kind !== 'plug') {
      if (state.brightness != null) plist.push(pid('P1501', Math.round(clamp(state.brightness, 1, 100))));
      if (state.rgb && kind !== 'white') {
        plist.push(pid('P1507', rgbToHex(state.rgb).replace('#', '').toUpperCase()), pid('P1508', 1));
      } else if (state.kelvin) {
        const [lo, hi] = kelvinRange(kind);
        plist.push(pid('P1502', Math.round(clamp(state.kelvin, lo, hi))));
        if (kind !== 'white') plist.push(pid('P1508', 2));
      }
    }
    return send(c, d, plist);
  },

  async snapshot(c, mac) {
    const d = await device(c, mac);
    const data = await api(c, '/app/v2/device/get_property_list', { device_mac: d.mac, device_model: d.product_model, target_pid_list: [] });
    const props = Object.fromEntries((data?.property_list || []).map(p => [p.pid, p.value]));
    return { P3: props.P3, P1501: props.P1501, P1502: props.P1502, P1507: props.P1507, P1508: props.P1508 };
  },

  async restore(c, mac, snap) {
    if (!snap || snap.P3 == null) return;
    const d = await device(c, mac);
    const kind = LIGHT_TYPES[d.product_type];
    if (String(snap.P3) !== '1') return send(c, d, [pid('P3', 0)]);
    const plist = [pid('P3', 1)];
    if (kind !== 'plug') {
      if (snap.P1501 != null) plist.push(pid('P1501', snap.P1501));
      if (kind !== 'white' && String(snap.P1508) === '1' && snap.P1507) plist.push(pid('P1507', snap.P1507), pid('P1508', 1));
      else if (snap.P1502 != null) { plist.push(pid('P1502', snap.P1502)); if (kind !== 'white') plist.push(pid('P1508', 2)); }
    }
    return send(c, d, plist);
  },

  // For tests.
  _reset() { session = null; pendingMfa = null; devCache = { at: 0, list: [] }; },
};

