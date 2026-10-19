'use strict';

// Shared pieces for Smart TVs and streaming boxes: finding them on the network, and a
// poller that turns "what the TV is doing now" into play / pause / stop through the tracker.

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { http } = require('../../util');

const parseHosts = v => String(v || '').split(/[\s,;]+/).map(s => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);

// ---- SSDP (Roku, LG, Samsung, Vizio and other DIAL devices) ---------------------------
function ssdp(targets, ms = 2500) {
  return new Promise(resolve => {
    const out = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve([]); }
    const done = () => { try { sock.close(); } catch { /* closed */ } resolve([...out.values()]); };
    sock.on('error', done);
    sock.on('message', (buf, rinfo) => {
      const text = buf.toString();
      const h = {};
      for (const line of text.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
      const st = h.st || h.nt || '';
      // Some devices (a Hue bridge, for one) answer every search with their own type; skip those.
      if (!targets.some(t => st.toLowerCase() === t.toLowerCase() || (h.usn || '').toLowerCase().includes(t.toLowerCase()))) return;
      const key = `${rinfo.address}|${st}`;
      if (!out.has(key)) out.set(key, { host: rinfo.address, st: h.st || h.nt || '', location: h.location || '', server: h.server || '', usn: h.usn || '' });
    });
    sock.bind(0, () => {
      for (const st of targets) {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        for (let i = 0; i < 2; i++) setTimeout(() => sock.send(msg, 1900, '239.255.255.250', () => {}), i * 400);
      }
      setTimeout(done, ms);
    });
  });
}

// ---- mDNS (Chromecast and Google Cast devices) ---------------------------------------
function encodeName(name) {
  return Buffer.concat([...name.split('.').filter(Boolean).map(p => Buffer.concat([Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)])), Buffer.from([0])]);
}
function readName(buf, off) {
  const parts = [];
  let jumped = false, end = off, guard = 0;
  while (guard++ < 64) {
    const len = buf[off];
    if (len === undefined) break;
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
    if (len === 0) { if (!jumped) end = off + 1; break; }
    parts.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: parts.join('.'), end };
}
function parseDns(buf) {
  const records = [];
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).end + 4;
  for (let i = 0; i < an + ns + ar && off < buf.length; i++) {
    const { name, end } = readName(buf, off);
    const type = buf.readUInt16BE(end), len = buf.readUInt16BE(end + 8), data = end + 10;
    const r = { name, type };
    if (type === 1) r.a = [...buf.subarray(data, data + 4)].join('.');
    else if (type === 12) r.ptr = readName(buf, data).name;
    else if (type === 33) r.target = readName(buf, data + 6).name;
    else if (type === 16) {
      r.txt = {};
      for (let p = data; p < data + len;) { const l = buf[p]; const s = buf.toString('utf8', p + 1, p + 1 + l); const i = s.indexOf('='); if (i > 0) r.txt[s.slice(0, i)] = s.slice(i + 1); p += 1 + l; }
    }
    records.push(r);
    off = data + len;
  }
  return records;
}
function mdns(service, ms = 2500) {
  return new Promise(resolve => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve([]); }
    const done = () => { try { sock.close(); } catch { /* closed */ } resolve([...found.values()]); };
    sock.on('error', done);
    sock.on('message', (buf, rinfo) => {
      let recs;
      try { recs = parseDns(buf); } catch { return; }
      if (!recs.some(r => r.type === 12 && r.name === service) && !recs.some(r => r.name.endsWith(service))) return;
      const txt = recs.find(r => r.type === 16)?.txt || {};
      const a = recs.find(r => r.type === 1)?.a || rinfo.address;
      found.set(a, { host: a, name: txt.fn || recs.find(r => r.type === 12)?.ptr?.split('.')[0] || a, txt });
    });
    sock.bind(0, () => {
      const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), encodeName(service), Buffer.from([0, 12, 0, 1])]);
      for (let i = 0; i < 2; i++) setTimeout(() => sock.send(q, 5353, '224.0.0.251', () => {}), i * 500);
      setTimeout(done, ms);
    });
  });
}

// Reads a UPnP device description and returns its friendly name, maker and model.
async function describe(location) {
  try {
    const xml = await http('GET', location, { raw: true, timeout: 2500 });
    const tag = t => (new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(xml) || [])[1] || '';
    return { name: tag('friendlyName'), maker: tag('manufacturer'), model: tag('modelName') || tag('modelNumber'), udn: tag('UDN') };
  } catch { return {}; }
}

// Guess whether something is a movie, a show or music, for rooms that only react to some kinds.
const MUSIC_APPS = /spotify|pandora|music|tidal|deezer|iheart|tunein|sirius|soundcloud|audible|radio/i;
function guessType(app, runtimeMs) {
  if (MUSIC_APPS.test(app || '')) return 'music';
  if (runtimeMs >= 60 * 60e3) return 'movie';
  if (runtimeMs >= 12 * 60e3) return 'episode';
  return 'other';
}

// ---- The poller every TV source uses ---------------------------------------------------
//  spec: { id, label, blurb, fields, actions, pollMs, discover(c), probe(c, host, found), describe(c, host, found), action(id, c), close() }
//  probe returns { id, name, product, state: 'playing'|'paused'|'idle'|'off', title, app, mediaType, position, runtime }
// TVs found on the network are remembered, so after a restart Photon doesn't depend on
// network discovery answering right away (it can miss a sleeping TV or a dropped packet).
const FOUND_FILE = path.join(path.dirname(process.env.CONFIG_PATH || path.join(__dirname, '..', '..', '..', 'data', 'config.json')), 'tvs-found.json');
let foundAll = {};
try { foundAll = JSON.parse(fs.readFileSync(FOUND_FILE, 'utf8')) || {}; } catch { /* first run */ }
function saveFound() { try { fs.writeFileSync(FOUND_FILE, JSON.stringify(foundAll, null, 2)); } catch { /* not important */ } }

function makeTv(spec) {
  const found = new Map(Object.entries(foundAll[spec.id] || {})); // host -> what discovery learned
  const status = new Map(); // host -> what the last check saw, for the Connections page
  let timer = null;
  let running = 0;

  const hostsOf = c => [...new Set([...parseHosts(c.hosts), ...(c.autoFind === false ? [] : found.keys())])];

  async function discover(c) {
    if (!spec.discover || c.autoFind === false) return;
    try {
      const list = await spec.discover(c);
      for (const d of list) found.set(d.host, { ...found.get(d.host), ...d });
      if (list.length) { foundAll[spec.id] = Object.fromEntries(found); saveFound(); }
    } catch { /* nothing found */ }
  }

  return {
    id: spec.id,
    label: spec.label,
    group: 'tv',
    blurb: spec.blurb,
    fields: [
      ...(spec.discover ? [{ key: 'autoFind', label: `Find ${spec.short || spec.label} on my network by itself`, type: 'checkbox', default: true }] : []),
      { key: 'hosts', label: spec.discover ? 'Also these IP addresses (optional, comma separated)' : 'IP addresses (comma separated)', placeholder: '192.168.1.50, 192.168.1.51' },
      ...(spec.fields || []),
    ],
    actions: [
      ...(spec.discover ? [{ id: 'find', label: 'Find on my network' }] : []),
      ...(spec.actions || []),
    ],
    webhook: false,
    configured: () => true,

    async action(actionId, c) {
      if (actionId === 'find') {
        await discover(c);
        const list = [...found.values()];
        if (!list.length) throw new Error(`No ${spec.short || spec.label} answered. Make sure it's on and on the same network as Photon, or type its IP address.`);
        return { message: `Found ${list.map(d => `${d.name || d.host} (${d.host})`).join(', ')}.` };
      }
      if (!spec.action) throw new Error(`unknown action ${actionId}`);
      return spec.action(actionId, c, hostsOf(c).length ? hostsOf(c) : (await discover(c), hostsOf(c)));
    },

    async listPlayers(c) {
      await discover(c);
      const out = [];
      await Promise.all(hostsOf(c).map(async host => {
        try {
          const d = await (spec.describe || spec.probe)(c, host, found.get(host));
          out.push({ id: d.id || host, name: d.name || host, product: d.product || spec.label });
        } catch (err) {
          if (err.auth) throw err;
          if (parseHosts(c.hosts).includes(host)) out.push({ id: host, name: `${spec.short || spec.label} at ${host}`, product: `${spec.label} (not answering)` });
        }
      }));
      if (!out.length) throw new Error(`No ${spec.short || spec.label} found. Turn it on, make sure it's on the same network as Photon, or type its IP address.`);
      return out;
    },

    start(c, tracker, onSeen, log) {
      this.stop();
      const run = ++running;
      const every = spec.pollMs || 2500;
      const named = new Map();
      const problems = new Map();
      let lastFind = 0;
      const tick = async () => {
        if (run !== running) return;
        // Look again every 5 minutes (IPs change), or every 30 seconds while nothing has been found.
        if (Date.now() - lastFind > (found.size ? 5 * 60e3 : 30e3)) { lastFind = Date.now(); await discover(c); }
        const active = new Set();
        await Promise.all(hostsOf(c).map(async host => {
          try {
            const s = await spec.probe(c, host, found.get(host));
            if (run !== running) return;
            status.set(host, { at: Date.now(), ok: true, name: s.name || host, state: s.state, title: s.title || s.app || '' });
            const info = {
              source: spec.id, playerId: s.id || host, playerName: s.name || host, product: s.product || spec.label,
              user: '', mediaType: s.mediaType || guessType(s.app || s.title, s.runtime), title: s.title || s.app || spec.label, local: true,
            };
            if (named.get(host) !== info.playerName) { named.set(host, info.playerName); onSeen(info); }
            if (s.state === 'playing' || s.state === 'paused') {
              active.add(info.playerId);
              tracker.observe(info, 'progress', { paused: s.state === 'paused', position: s.position || 0, runtime: s.runtime || 0 });
            }
            if (problems.get(host)) { log('ok', `${spec.label}: ${info.playerName} is answering again`); problems.delete(host); }
          } catch (err) {
            const offline = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|no answer|no response|could not reach|host unreachable|connection refused|socket hang up/i.test(`${err.code || ''} ${err.message}`);
            status.set(host, { at: Date.now(), ok: false, name: found.get(host)?.name || host, error: offline ? 'not answering (off, asleep or unplugged)' : err.message });
            // A TV that's off or asleep simply doesn't answer; anything else is worth a note.
            if (!offline && problems.get(host) !== err.message) log('error', `${spec.label} at ${host}: ${err.message}`);
            problems.set(host, err.message);
          }
        }));
        if (run === running) tracker.sweep(spec.id, active, spec.graceMs ?? every);
      };
      tick();
      timer = setInterval(tick, every);
    },

    // What each TV reported on the last check.
    status: () => [...status.entries()].map(([host, v]) => ({ host, ...v })),

    stop() {
      running++;
      clearInterval(timer);
      timer = null;
      if (spec.close) spec.close();
    },
  };
}

module.exports = { makeTv, ssdp, mdns, describe, parseHosts, guessType, parseDns };
