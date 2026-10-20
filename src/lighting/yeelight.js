'use strict';

// Yeelight bulbs, light strips, lamps and ceiling lights, over Yeelight's local LAN protocol.
// Each light must have "LAN Control" turned on in the Yeelight app (or the Mi Home app).
// Lights are found by a multicast search on port 1982 and controlled over TCP (port 55443)
// with one JSON command per line. Targets: the light's Yeelight id (like "0x0000000002dfb19a").

const dgram = require('dgram');
const net = require('net');
const { clamp } = require('../util');

const SEARCH = () => {
  const [host, port] = String(process.env.YEELIGHT_SEARCH || '239.255.255.250:1982').split(':');
  return { host, port: Number(port) || 1982 };
};
const lights = new Map(); // id -> { ip, port, model, support: Set, name }

const LAN_HELP = 'Turn on "LAN Control" for each light in the Yeelight app (open the light, then the settings icon, then LAN Control), and make sure Photon is on the same network.';

function parseReply(text, fromIp) {
  const h = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const loc = /yeelight:\/\/([^:/]+):(\d+)/.exec(h.location || '');
  if (!h.id || !loc) return null;
  return {
    id: h.id, ip: loc[1] || fromIp, port: Number(loc[2]) || 55443, model: h.model || 'light',
    support: new Set(String(h.support || '').split(/\s+/).filter(Boolean)), name: h.name || '',
  };
}

// Asks every Yeelight on the network (and any typed addresses) to answer.
function search(c, wait = 2000) {
  return new Promise(resolve => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: "ssdp:discover"\r\nST: wifi_bulb\r\n');
    const finish = () => { try { s.close(); } catch { /* closed */ } resolve(); };
    s.on('error', finish);
    s.on('message', (buf, rinfo) => {
      const l = parseReply(buf.toString(), rinfo.address);
      if (l) lights.set(l.id, { ...lights.get(l.id), ...l, seen: Date.now() });
    });
    s.bind(0, () => {
      const { host, port } = SEARCH();
      const send = h => s.send(msg, port, h, () => {});
      send(host);
      for (const h of String(c.hosts || '').split(/[\s,]+/).filter(Boolean)) send(h.replace(/:\d+$/, ''));
      setTimeout(() => send(host), 400); // a second try, since UDP can drop
      setTimeout(finish, wait);
    });
  });
}

async function find(c, id) {
  if (!lights.has(id)) await search(c);
  const l = lights.get(id);
  if (!l) throw new Error(`Yeelight ${id} didn't answer. ${LAN_HELP}`);
  return l;
}

// Sends commands in order on one connection and waits for each answer. Yeelight also pushes
// "props" notices on the same connection; those are skipped.
function commands(l, list) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: l.ip, port: l.port });
    let buf = '';
    let i = 0;
    const results = [];
    const done = err => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(results); };
    const timer = setTimeout(() => done(new Error(`Yeelight at ${l.ip} stopped answering`)), 4000 + list.length * 500);
    const next = () => {
      if (i >= list.length) return done();
      const [method, params] = list[i];
      sock.write(`${JSON.stringify({ id: i + 1, method, params })}\r\n`);
    };
    sock.on('connect', next);
    sock.on('error', err => done(err.code === 'ECONNREFUSED'
      ? new Error(`Yeelight at ${l.ip} refused the connection. ${LAN_HELP}`)
      : new Error(`Couldn't reach the Yeelight at ${l.ip}: ${err.code || err.message}`)));
    sock.on('data', d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== i + 1) continue;
        if (msg.error) {
          const m = String(msg.error.message || 'error');
          return done(new Error(/quota/i.test(m)
            ? 'the Yeelight is getting too many commands (it allows about one a second). Try again in a minute.'
            : `Yeelight: ${m}`));
        }
        results.push(msg.result);
        i++;
        next();
      }
    });
  });
}

const can = (l, method) => !l.support.size || l.support.has(method);
// Color lights go down to 1700K; white-only ones start at 2700K.
const kelvinRange = l => (can(l, 'set_rgb') ? [1700, 6500] : [2700, 6500]);
function effect(transition) {
  const ms = Math.round((transition ?? 0.4) * 1000);
  return ms >= 30 ? ['smooth', ms] : ['sudden', 0];
}
const toInt = ([r, g, b]) => (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b);

module.exports = {
  id: 'yeelight',
  label: 'Yeelight',
  blurb: 'Yeelight bulbs, light strips, lamps and ceiling lights, controlled directly on your network with no cloud. Turn on "LAN Control" for each light in the Yeelight app first (open the light, tap the settings icon, then LAN Control). Photon then finds them by itself.',
  fields: [
    { key: 'hosts', label: 'Light IPs (optional, if they aren\'t found by themselves)', placeholder: '192.168.1.60, 192.168.1.61' },
  ],
  actions: [{ id: 'scan', label: 'Find Yeelights' }],

  configured: () => true,

  async action(id, c) {
    if (id !== 'scan') throw new Error(`unknown action ${id}`);
    await search(c);
    if (!lights.size) throw new Error(`No Yeelights answered. ${LAN_HELP}`);
    return { message: `Found ${lights.size} Yeelight(s): ${[...lights.values()].map(l => l.name || l.model).join(', ')}.` };
  },

  async list(c) {
    await search(c);
    return {
      targets: [...lights.values()].map(l => ({
        id: l.id, name: l.name || `Yeelight ${l.model} (${l.ip})`, type: 'light', detail: `Yeelight ${l.model}, ${l.ip}`,
        shape: /strip/i.test(l.model) ? 'strip' : /ceil|panel/i.test(l.model) ? 'panel' : /lamp|desk|bslamp/i.test(l.model) ? 'lamp' : 'bulb',
        caps: { dim: true, temp: can(l, 'set_ct_abx'), color: can(l, 'set_rgb') },
      })),
      scenes: [],
    };
  },

  async apply(c, id, state) {
    const l = await find(c, id);
    const [fx, ms] = effect(state.transition);
    if (!state.on) return commands(l, [['set_power', ['off', fx, ms]]]);
    // Power first: a light that's off refuses brightness and color changes.
    const list = [['set_power', ['on', fx, ms]]];
    if (state.rgb && can(l, 'set_rgb')) list.push(['set_rgb', [toInt(state.rgb), fx, ms]]);
    else if (state.kelvin && can(l, 'set_ct_abx')) {
      const [lo, hi] = kelvinRange(l);
      list.push(['set_ct_abx', [Math.round(clamp(state.kelvin, lo, hi)), fx, ms]]);
    }
    if (state.brightness != null) list.push(['set_bright', [Math.round(clamp(state.brightness, 1, 100)), fx, ms]]);
    return commands(l, list);
  },

  async snapshot(c, id) {
    const l = await find(c, id);
    const [r] = await commands(l, [['get_prop', ['power', 'bright', 'ct', 'rgb', 'hue', 'sat', 'color_mode']]]);
    const [power, bright, ct, rgb, hue, sat, mode] = r || [];
    return { power, bright: Number(bright), ct: Number(ct), rgb: Number(rgb), hue: Number(hue), sat: Number(sat), mode: Number(mode) };
  },

  async restore(c, id, s, transition) {
    if (!s?.power) return;
    const l = await find(c, id);
    const [fx, ms] = effect(transition);
    if (s.power !== 'on') return commands(l, [['set_power', ['off', fx, ms]]]);
    const list = [['set_power', ['on', fx, ms]]];
    if (s.mode === 1 && s.rgb && can(l, 'set_rgb')) list.push(['set_rgb', [s.rgb, fx, ms]]);
    else if (s.mode === 3 && can(l, 'set_hsv')) list.push(['set_hsv', [s.hue, s.sat, fx, ms]]);
    else if (s.ct && can(l, 'set_ct_abx')) list.push(['set_ct_abx', [s.ct, fx, ms]]);
    if (s.bright) list.push(['set_bright', [s.bright, fx, ms]]);
    return commands(l, list);
  },
};
