'use strict';

// Govee. Prefers the local LAN API (fast, no rate limit) for devices that have
// "LAN Control" switched on in the Govee app, and falls back to the Govee cloud
// API (needs an API key) for everything else. Target id is the device id (MAC-like).

const dgram = require('dgram');
const crypto = require('crypto');
const { http, sleep, clamp, kelvinToRgb, guessShape } = require('../util');

// Most Govee strip and rope lights have SKUs starting H61 or H70 (outdoor strips).
const goveeShape = (sku, name) => (/^H6(1|7)|^H70[0-5]|^H80/i.test(sku || '') ? 'strip' : guessShape(name));

const MULTICAST = '239.255.255.250';
const SCAN_PORT = 4001;
const LISTEN_PORT = 4002;
const CONTROL_PORT = 4003;
const CLOUD = 'https://openapi.api.govee.com/router/api/v1';

const lan = new Map();     // device -> { ip, sku, lastSeen }
const waiters = new Map(); // ip -> resolve fn for devStatus replies
let cloudCache = { at: 0, devices: [] };
let sock = null;
let sockError = null;
let rescanTimer = null;

function socket() {
  if (sock || sockError) return sock;
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', err => { sockError = err; try { sock.close(); } catch { /* ignore */ } sock = null; });
  sock.on('message', (buf, rinfo) => {
    let m;
    try { m = JSON.parse(buf.toString()).msg; } catch { return; }
    if (m?.cmd === 'scan' && m.data?.device) {
      lan.set(m.data.device, { ip: m.data.ip || rinfo.address, sku: m.data.sku, lastSeen: Date.now() });
    } else if (m?.cmd === 'devStatus') {
      const w = waiters.get(rinfo.address);
      if (w) { waiters.delete(rinfo.address); w(m.data); }
    }
  });
  sock.bind(LISTEN_PORT, () => {
    try { sock.addMembership(MULTICAST); } catch { /* not fatal, scan replies are unicast */ }
  });
  return sock;
}

async function scan() {
  const s = socket();
  if (!s) throw new Error(`Govee LAN unavailable: ${sockError?.message}`);
  const msg = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
  await sleep(150); // let bind finish on first use
  s.send(msg, SCAN_PORT, MULTICAST);
  await sleep(1800);
}

function lanSend(ip, cmd, data) {
  const s = socket();
  if (!s) throw new Error('Govee LAN socket is not available');
  s.send(Buffer.from(JSON.stringify({ msg: { cmd, data } })), CONTROL_PORT, ip);
}

function lanStatus(ip) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiters.delete(ip); reject(new Error(`Govee device at ${ip} did not answer`)); }, 2500);
    waiters.set(ip, d => { clearTimeout(t); resolve(d); });
    lanSend(ip, 'devStatus', {});
  });
}

async function cloud(c, method, path, body) {
  if (!c.apiKey) throw new Error('This Govee device is not on LAN control and no API key is set');
  return http(method, `${CLOUD}${path}`, { body, headers: { 'Govee-API-Key': c.apiKey } });
}

async function cloudDevices(c, force = false) {
  if (!c.apiKey) return [];
  if (!force && Date.now() - cloudCache.at < 10 * 60 * 1000) return cloudCache.devices;
  const res = await cloud(c, 'GET', '/user/devices');
  cloudCache = { at: Date.now(), devices: res?.data || [] };
  return cloudCache.devices;
}

async function cloudControl(c, device, sku, type, instance, value) {
  await cloud(c, 'POST', '/device/control', {
    requestId: crypto.randomUUID(),
    payload: { sku, device, capability: { type, instance, value } },
  });
  await sleep(550); // Govee allows about 2 commands per second per device
}

async function skuFor(c, device) {
  const l = lan.get(device);
  if (l?.sku) return l.sku;
  const d = (await cloudDevices(c)).find(x => x.device === device);
  if (!d) throw new Error(`Govee device ${device} not found`);
  return d.sku;
}

const rgbInt = ([r, g, b]) => (r << 16) + (g << 8) + b;

module.exports = {
  id: 'govee',
  label: 'Govee',
  blurb: 'Local LAN control for devices with "LAN Control" on in the Govee app. Add an API key to also reach devices that don\'t support LAN.',
  fields: [
    { key: 'lan', label: 'Use LAN control', type: 'checkbox', default: true },
    { key: 'apiKey', label: 'Cloud API key (optional)', placeholder: 'Govee app > Profile > Settings > Apply for API Key', secret: true },
  ],
  actions: [{ id: 'scan', label: 'Scan network' }],

  configured: c => Boolean(c.lan !== false || c.apiKey),

  start(c) {
    if (c.lan === false) return;
    scan().catch(() => {});
    clearInterval(rescanTimer);
    rescanTimer = setInterval(() => scan().catch(() => {}), 5 * 60 * 1000); // IPs can change
    rescanTimer.unref();
  },

  async action(id, c) {
    if (id === 'scan') {
      await scan();
      return { message: `Found ${lan.size} Govee device(s) with LAN control` };
    }
    throw new Error(`unknown action ${id}`);
  },

  async list(c) {
    if (c.lan !== false) await scan().catch(() => {});
    const byId = new Map();
    for (const d of await cloudDevices(c, true).catch(() => [])) {
      if (d.type && !String(d.type).includes('light')) continue;
      const caps = (d.capabilities || []).map(x => x.instance);
      byId.set(d.device, {
        id: d.device, name: d.deviceName || d.sku, type: 'light', detail: `${d.sku}, cloud`, shape: goveeShape(d.sku, d.deviceName),
        caps: { dim: caps.includes('brightness'), temp: caps.includes('colorTemperatureK'), color: caps.includes('colorRgb') },
      });
    }
    for (const [device, l] of lan) {
      const prev = byId.get(device);
      byId.set(device, {
        id: device, name: prev?.name || `Govee ${l.sku}`, type: 'light', detail: `${l.sku}, LAN ${l.ip}`, shape: goveeShape(l.sku, prev?.name),
        caps: { dim: true, temp: true, color: true },
      });
    }
    return { targets: [...byId.values()], scenes: [] };
  },

  async apply(c, id, state) {
    const l = c.lan !== false ? lan.get(id) : null;
    if (l) {
      if (!state.on) return lanSend(l.ip, 'turn', { value: 0 });
      lanSend(l.ip, 'turn', { value: 1 });
      await sleep(60);
      if (state.brightness != null) { lanSend(l.ip, 'brightness', { value: clamp(Math.round(state.brightness), 1, 100) }); await sleep(60); }
      if (state.rgb) lanSend(l.ip, 'colorwc', { color: { r: state.rgb[0], g: state.rgb[1], b: state.rgb[2] }, colorTemInKelvin: 0 });
      else if (state.kelvin) {
        const [r, g, b] = kelvinToRgb(state.kelvin);
        lanSend(l.ip, 'colorwc', { color: { r, g, b }, colorTemInKelvin: clamp(state.kelvin, 2000, 9000) });
      }
      return;
    }
    const sku = await skuFor(c, id);
    if (!state.on) return cloudControl(c, id, sku, 'devices.capabilities.on_off', 'powerSwitch', 0);
    await cloudControl(c, id, sku, 'devices.capabilities.on_off', 'powerSwitch', 1);
    if (state.brightness != null) await cloudControl(c, id, sku, 'devices.capabilities.range', 'brightness', clamp(Math.round(state.brightness), 1, 100));
    if (state.rgb) await cloudControl(c, id, sku, 'devices.capabilities.color_setting', 'colorRgb', rgbInt(state.rgb));
    else if (state.kelvin) await cloudControl(c, id, sku, 'devices.capabilities.color_setting', 'colorTemperatureK', clamp(state.kelvin, 2000, 9000));
  },

  async snapshot(c, id) {
    const l = c.lan !== false ? lan.get(id) : null;
    if (l) {
      const d = await lanStatus(l.ip);
      return { on: d.onOff === 1, brightness: d.brightness, kelvin: d.colorTemInKelvin || null, rgb: d.colorTemInKelvin ? null : [d.color?.r ?? 255, d.color?.g ?? 255, d.color?.b ?? 255] };
    }
    const sku = await skuFor(c, id);
    const res = await cloud(c, 'POST', '/device/state', { requestId: crypto.randomUUID(), payload: { sku, device: id } });
    const v = inst => (res?.payload?.capabilities || []).find(x => x.instance === inst)?.state?.value;
    const rgb = v('colorRgb');
    const k = v('colorTemperatureK');
    return {
      on: v('powerSwitch') === 1, brightness: v('brightness'),
      kelvin: k || null, rgb: !k && rgb != null ? [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255] : null,
    };
  },

  async restore(c, id, snap, transition) {
    return module.exports.apply(c, id, { ...snap, transition });
  },
};
