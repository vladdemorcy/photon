'use strict';

// Finding other copies of Photon on the home network.
//
// Two Photons on the same network usually means two of them reacting to the same player and
// setting the same lights, so the lights flicker between what each one decides. Each Photon
// says "I'm here" with a small UDP broadcast every 30 seconds and listens for others. Photon
// shows a warning while it hears another one.
//
// The message has no keys, tokens or settings in it: an ID (random, kept with the settings so
// it stays the same across restarts), the computer's name, the kind of device, the version,
// and which lighting systems are turned on (so the warning can say whether they overlap).

const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 47883;
const EVERY_MS = 30e3;
const GONE_MS = 100e3;   // forgotten after missing three announcements
const MAX_PEERS = 20;

function create({ dataDir, version, onPhone, lights, log }) {
  let id;
  const idFile = path.join(dataDir, 'instance-id');
  try { id = fs.readFileSync(idFile, 'utf8').trim(); } catch { /* new */ }
  if (!/^[a-f0-9]{32}$/.test(id || '')) {
    id = crypto.randomBytes(16).toString('hex');
    try { fs.writeFileSync(idFile, `${id}\n`); } catch { /* still works, just not across restarts */ }
  }
  const platform = onPhone ? 'android' : { win32: 'windows', darwin: 'mac' }[process.platform] || process.platform;
  const peers = new Map(); // id -> details
  let sock = null;
  let timer = null;

  // Each network's broadcast address (from its address and mask), plus the general one.
  function targets() {
    const out = new Set(['255.255.255.255']);
    for (const i of Object.values(os.networkInterfaces()).flat()) {
      if (!i || i.internal || !(i.family === 'IPv4' || i.family === 4) || !i.netmask) continue;
      const a = i.address.split('.').map(Number);
      const m = i.netmask.split('.').map(Number);
      if (a.length === 4 && m.length === 4) out.add(a.map((x, k) => (x & m[k]) | (~m[k] & 255)).join('.'));
    }
    return [...out];
  }

  function announce() {
    if (!sock) return;
    const msg = Buffer.from(JSON.stringify({
      photon: 1, id, name: os.hostname().slice(0, 64), platform, version, lights: lights().slice(0, 20),
    }));
    for (const t of targets()) sock.send(msg, PORT, t, () => {});
  }

  const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);

  function heard(buf, rinfo) {
    if (buf.length > 2048) return;
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (m?.photon !== 1 || typeof m.id !== 'string' || !/^[a-f0-9]{32}$/.test(m.id) || m.id === id) return;
    const isNew = !peers.has(m.id);
    if (isNew && peers.size >= MAX_PEERS) return;
    const peer = {
      id: m.id, name: clean(m.name, 64) || 'another device', platform: clean(m.platform, 16),
      version: clean(m.version, 20), address: rinfo.address,
      lights: Array.isArray(m.lights) ? m.lights.slice(0, 20).map(x => clean(x, 24)) : [],
      seen: Date.now(),
    };
    peers.set(m.id, peer);
    if (isNew) {
      log?.('warn', `Another Photon is running on this network: ${peer.name} (${peer.address}). If both control the same lights, they'll undo each other. Keep one of them running.`);
      announce(); // let the new one know about us straight away
    }
  }

  function start() {
    if (sock) return;
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', err => { log?.('info', `Can't look for other Photons on the network (${err.code || err.message}).`); stop(); });
    sock.on('message', heard);
    sock.bind(PORT, () => {
      try { sock.setBroadcast(true); } catch { /* sending may fail, listening still works */ }
      announce();
      timer = setInterval(announce, EVERY_MS);
      timer.unref();
    });
  }

  function stop() {
    clearInterval(timer);
    try { sock?.close(); } catch { /* closed */ }
    sock = null;
  }

  // The others heard recently, with which lighting systems both of us use.
  function list() {
    const now = Date.now();
    const mine = new Set(lights());
    const out = [];
    for (const [k, p] of peers) {
      if (now - p.seen > GONE_MS) { peers.delete(k); continue; }
      out.push({ ...p, shared: p.lights.filter(x => mine.has(x)) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { start, stop, list, id, _heard: heard, _announce: announce };
}

module.exports = { create, PORT };
