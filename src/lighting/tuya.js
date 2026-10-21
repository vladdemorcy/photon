'use strict';

// Tuya cloud. Treatlife, Gosund, Smart Life and most "Tuya Smart" bulbs, strips, dimmers, switches and
// plugs are Tuya devices underneath. Needs a free cloud project at platform.tuya.com with the
// Smart Life (or Tuya Smart) app account linked to it. Targets: "<device id>".

const crypto = require('crypto');
const { http, clamp, guessShape, rgbToHs } = require('../util');

const REGIONS = {
  us: 'https://openapi.tuyaus.com',
  'us-e': 'https://openapi-ueaz.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  'eu-w': 'https://openapi-weaz.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};
const base = c => process.env.TUYA_BASE_URL || REGIONS[c.region] || REGIONS.us;

// Device kinds Photon can light up. Tuya's category codes: dj bulb, dd strip, xdd ceiling,
// fwd ambient, dc string lights, gyd motion light, tgq/tgkg dimmers, kg switch, cz/pc plugs.
const LIGHTS = new Set(['dj', 'dd', 'xdd', 'fwd', 'dc', 'gyd', 'sxd', 'tyndj', 'tgq', 'tgkg', 'fsd']);
const PLUGS = new Set(['kg', 'cz', 'pc', 'tdq', 'cjkg', 'ckmkzq']);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const tokens = new Map(); // accessId -> { token, expires }

function friendly(json, path) {
  const code = Number(json?.code);
  const msg = json?.msg || 'unknown error';
  if (code === 1004 || code === 1001) return 'Tuya says the Access ID or Access Secret is wrong.';
  if (code === 2009 || /clientid/i.test(msg)) return 'Tuya doesn\'t recognise this Access ID. Check it, and check the data center matches your project.';
  if (/expired/i.test(msg)) return 'Tuya says the cloud project\'s free plan has expired. Extend it at platform.tuya.com (Cloud > Cloud Services > IoT Core).';
  if (code === 28841105 || code === 1106 || /permission/i.test(msg)) return `Tuya refused ${path.split('?')[0]}: ${msg}. Make sure the project has the IoT Core service and the Smart Life app account is linked under Devices > Link App Account.`;
  return `Tuya: ${msg} (${code || 'no code'})`;
}

async function raw(c, method, path, { body, token } = {}) {
  const t = String(Date.now());
  const text = body === undefined ? '' : JSON.stringify(body);
  const stringToSign = [method, sha256(text), '', path].join('\n');
  const sign = crypto.createHmac('sha256', String(c.accessSecret || '').trim())
    .update(`${String(c.accessId || '').trim()}${token || ''}${t}${stringToSign}`).digest('hex').toUpperCase();
  const headers = { client_id: String(c.accessId || '').trim(), sign, t, sign_method: 'HMAC-SHA256', lang: 'en' };
  if (token) headers.access_token = token;
  const json = await http(method, `${base(c)}${path}`, { headers, body, timeout: 8000 });
  return json;
}

async function token(c, fresh) {
  const key = String(c.accessId || '').trim();
  const cur = tokens.get(key);
  if (!fresh && cur && cur.secret === c.accessSecret && cur.expires > Date.now() + 60000) return cur.token;
  const json = await raw(c, 'GET', '/v1.0/token?grant_type=1');
  if (!json?.success) throw new Error(friendly(json, '/v1.0/token'));
  tokens.set(key, { token: json.result.access_token, secret: c.accessSecret, expires: Date.now() + (json.result.expire_time || 3600) * 1000 });
  return json.result.access_token;
}

// A signed call. Query parameters must already be sorted by name, which is how Tuya signs them.
async function api(c, method, path, body) {
  let json = await raw(c, method, path, { body, token: await token(c) });
  if (!json?.success && [1010, 1011].includes(Number(json?.code))) json = await raw(c, method, path, { body, token: await token(c, true) });
  if (!json?.success) throw new Error(friendly(json, path));
  return json.result;
}

// What each device accepts, with value ranges. Kept for the life of the process.
const fnCache = new Map();
async function functions(c, id) {
  if (fnCache.has(id)) return fnCache.get(id);
  const r = await api(c, 'GET', `/v1.0/iot-03/devices/${encodeURIComponent(id)}/functions`);
  const map = {};
  for (const f of r?.functions || []) {
    let values = {};
    try { values = typeof f.values === 'string' ? JSON.parse(f.values) : f.values || {}; } catch { /* leave empty */ }
    map[f.code] = { type: f.type, values };
  }
  fnCache.set(id, map);
  return map;
}

const first = (fns, codes) => codes.find(code => fns[code]);
function codesFor(fns) {
  return {
    power: first(fns, ['switch_led', 'switch_led_1', 'switch_1', 'switch']),
    mode: first(fns, ['work_mode']),
    bright: first(fns, ['bright_value_v2', 'bright_value', 'bright_value_1']),
    temp: first(fns, ['temp_value_v2', 'temp_value']),
    colour: first(fns, ['colour_data_v2', 'colour_data']),
  };
}

// Brightness 0-100 into the device's own range (often 10-1000 or 25-255).
function scaleBright(fn, pct) {
  const min = Number(fn.values?.min ?? 10), max = Number(fn.values?.max ?? 1000);
  return Math.round(min + (max - min) * clamp(pct, 1, 100) / 100);
}
// Tuya temperature runs from warm (min) to cool (max). Most bulbs span about 2700K to 6500K.
function scaleTemp(fn, kelvin) {
  const min = Number(fn.values?.min ?? 0), max = Number(fn.values?.max ?? 1000);
  return Math.round(min + (max - min) * clamp((kelvin - 2700) / (6500 - 2700), 0, 1));
}
function colourValue(code, rgb, pct) {
  const [h, s] = rgbToHs(rgb);
  const top = code === 'colour_data_v2' ? 1000 : 255;
  return { h, s: Math.round(s / 100 * top), v: Math.round(clamp(pct ?? 100, 1, 100) / 100 * top) };
}

async function send(c, id, commands) {
  if (!commands.length) return;
  return api(c, 'POST', `/v1.0/iot-03/devices/${encodeURIComponent(id)}/commands`, { commands });
}

module.exports = {
  id: 'tuya',
  label: 'Smart Life (Treatlife, Gosund)',
  blurb: 'Treatlife, Gosund, Smart Life and other Tuya-based lights, dimmers and plugs, through a free Tuya cloud project linked to your Smart Life app account. Lights set up in the Treatlife or Gosund app need to be added to the Smart Life app first, since those apps can\'t be linked.',
  fields: [
    { key: 'region', label: 'Data center', type: 'select', default: 'us', options: [
      { value: 'us', label: 'Western America' }, { value: 'us-e', label: 'Eastern America' },
      { value: 'eu', label: 'Central Europe' }, { value: 'eu-w', label: 'Western Europe' },
      { value: 'cn', label: 'China' }, { value: 'in', label: 'India' },
    ] },
    { key: 'accessId', label: 'Access ID', placeholder: 'platform.tuya.com > Cloud > your project > Overview' },
    { key: 'accessSecret', label: 'Access Secret', placeholder: 'Shown next to the Access ID', secret: true },
  ],

  configured: c => Boolean(c.accessId && c.accessSecret),

  async list(c) {
    const all = [];
    let lastRowKey = '';
    for (let page = 0; page < 20; page++) {
      const q = lastRowKey ? `last_row_key=${encodeURIComponent(lastRowKey)}&size=50` : 'size=50';
      const r = await api(c, 'GET', `/v1.0/iot-01/associated-users/devices?${q}`);
      all.push(...(r?.devices || r?.list || []));
      if (!r?.has_more || !r.last_row_key) break;
      lastRowKey = r.last_row_key;
    }
    const usable = all.filter(d => LIGHTS.has(d.category) || PLUGS.has(d.category));
    if (all.length && !usable.length) throw new Error('Tuya answered, but none of your devices are lights, dimmers or plugs.');
    const targets = await Promise.all(usable.map(async d => {
      const plug = PLUGS.has(d.category);
      const fns = await functions(c, d.id).catch(() => ({}));
      const k = codesFor(fns);
      return {
        id: d.id, name: d.name || d.product_name || 'Tuya device', type: plug ? 'plug' : 'light',
        detail: d.product_name || d.category, reachable: d.online !== false,
        ...(plug ? {} : { shape: d.category === 'dd' || d.category === 'dc' ? 'strip' : guessShape(`${d.product_name || ''} ${d.name || ''}`) }),
        caps: { dim: Boolean(k.bright || k.colour), temp: Boolean(k.temp), color: Boolean(k.colour) },
      };
    }));
    return { targets, scenes: [] };
  },

  async apply(c, id, state) {
    const fns = await functions(c, id);
    const k = codesFor(fns);
    if (!k.power) throw new Error('Tuya: this device has no on/off control Photon knows');
    if (!state.on) return send(c, id, [{ code: k.power, value: false }]);
    const cmds = [{ code: k.power, value: true }];
    if (state.rgb && k.colour) {
      if (k.mode) cmds.push({ code: k.mode, value: 'colour' });
      cmds.push({ code: k.colour, value: colourValue(k.colour, state.rgb, state.brightness) });
    } else {
      if ((state.kelvin || state.brightness != null) && k.mode) cmds.push({ code: k.mode, value: 'white' });
      if (state.brightness != null && k.bright) cmds.push({ code: k.bright, value: scaleBright(fns[k.bright], state.brightness) });
      const kelvin = state.kelvin || null;
      if (kelvin && k.temp) cmds.push({ code: k.temp, value: scaleTemp(fns[k.temp], kelvin) });
    }
    return send(c, id, cmds);
  },

  async snapshot(c, id) {
    const status = await api(c, 'GET', `/v1.0/iot-03/devices/${encodeURIComponent(id)}/status`);
    return Object.fromEntries((status || []).map(s => [s.code, s.value]));
  },

  async restore(c, id, snap) {
    const fns = await functions(c, id);
    const k = codesFor(fns);
    if (!k.power || !(k.power in snap)) return;
    if (!snap[k.power]) return send(c, id, [{ code: k.power, value: false }]);
    const cmds = [{ code: k.power, value: true }];
    const mode = k.mode ? snap[k.mode] : null;
    if (mode) cmds.push({ code: k.mode, value: mode });
    if (mode === 'colour' && k.colour && snap[k.colour] != null) {
      let v = snap[k.colour];
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
      if (v) cmds.push({ code: k.colour, value: v });
    } else if (!mode || mode === 'white') {
      if (k.bright && snap[k.bright] != null) cmds.push({ code: k.bright, value: snap[k.bright] });
      if (k.temp && snap[k.temp] != null) cmds.push({ code: k.temp, value: snap[k.temp] });
    }
    return send(c, id, cmds);
  },
};
