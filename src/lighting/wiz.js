'use strict';

// WiZ (Philips WiZ, and other brands built on WiZ Connected) over local UDP.
// Target id is the bulb MAC; the IP is found by a broadcast scan.

const dgram = require('dgram');
const { clamp } = require('../util');

const PORT = 38899;
const bulbs = new Map(); // mac -> { ip, lastSeen }

function udp(ip, payload, { broadcast = false, wait = 1500, collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const replies = [];
    const finish = () => { try { s.close(); } catch { /* ignore */ } resolve(collect ? replies : replies[0] || null); };
    const t = setTimeout(() => (collect || replies.length ? finish() : (s.close(), reject(new Error(`WiZ bulb at ${ip} did not answer`)))), wait);
    s.on('error', err => { clearTimeout(t); try { s.close(); } catch { /* ignore */ } reject(err); });
    s.on('message', (buf, rinfo) => {
      try { replies.push({ ip: rinfo.address, ...JSON.parse(buf.toString()) }); } catch { return; }
      if (!collect) { clearTimeout(t); finish(); }
    });
    s.bind(() => {
      if (broadcast) s.setBroadcast(true);
      s.send(Buffer.from(JSON.stringify(payload)), PORT, ip);
    });
  });
}

async function scan(c) {
  const targets = [c.broadcast || '255.255.255.255', ...String(c.hosts || '').split(/[\s,]+/).filter(Boolean)];
  for (const ip of targets) {
    const replies = await udp(ip, { method: 'getPilot', params: {} }, { broadcast: true, collect: true, wait: 2000 }).catch(() => []);
    for (const r of replies) if (r.result?.mac) bulbs.set(r.result.mac, { ip: r.ip, lastSeen: Date.now() });
  }
}

async function ipFor(c, mac) {
  if (!bulbs.has(mac)) await scan(c);
  const b = bulbs.get(mac);
  if (!b) throw new Error(`WiZ bulb ${mac} not found on the network`);
  return b.ip;
}

async function pilot(c, mac, params) {
  const ip = await ipFor(c, mac);
  const res = await udp(ip, { method: 'setPilot', params }).catch(async err => {
    bulbs.delete(mac); // IP may have changed, rescan once
    const ip2 = await ipFor(c, mac);
    if (ip2 === ip) throw err;
    return udp(ip2, { method: 'setPilot', params });
  });
  if (res?.error) throw new Error(`WiZ: ${res.error.message}`);
}

module.exports = {
  id: 'wiz',
  label: 'WiZ',
  blurb: 'Local control of WiZ bulbs. Bulbs are found automatically by broadcast on your network.',
  fields: [
    { key: 'broadcast', label: 'Broadcast address', placeholder: '255.255.255.255 (or e.g. 192.168.1.255)' },
    { key: 'hosts', label: 'Bulb IPs (optional, if broadcast doesn\'t reach them)', placeholder: '192.168.1.50, 192.168.1.51' },
  ],
  actions: [{ id: 'scan', label: 'Scan network' }],

  configured: () => true,

  async action(id, c) {
    await scan(c);
    return { message: `Found ${bulbs.size} WiZ bulb(s)` };
  },

  async list(c) {
    await scan(c);
    return {
      targets: [...bulbs].map(([mac, b]) => ({ id: mac, name: `WiZ ${mac.slice(-6)}`, type: 'light', detail: b.ip, caps: { dim: true, temp: true, color: true } })),
      scenes: [],
    };
  },

  async apply(c, id, state) {
    if (!state.on) return pilot(c, id, { state: false });
    const p = { state: true };
    if (state.brightness != null) p.dimming = clamp(Math.round(state.brightness), 10, 100);
    if (state.rgb) [p.r, p.g, p.b] = state.rgb;
    else if (state.kelvin) p.temp = clamp(Math.round(state.kelvin), 2200, 6500);
    return pilot(c, id, p);
  },

  async snapshot(c, id) {
    const res = await udp(await ipFor(c, id), { method: 'getPilot', params: {} });
    return res?.result || null;
  },

  async restore(c, id, s) {
    if (!s) return;
    if (!s.state) return pilot(c, id, { state: false });
    const p = { state: true, dimming: s.dimming };
    if (s.sceneId) p.sceneId = s.sceneId;
    else if (s.temp) p.temp = s.temp;
    else if (s.r != null) Object.assign(p, { r: s.r, g: s.g, b: s.b });
    return pilot(c, id, p);
  },
};
