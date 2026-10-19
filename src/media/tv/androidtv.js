'use strict';

// Android TV, Google TV, Fire TV, NVIDIA Shield and Android-based TVs (Sony, TCL, Hisense, Philips),
// through Android's debugging bridge (ADB) over the network on port 5555. Android's own media
// sessions say what is playing in every app, so play and pause work everywhere.
// One-time setup on the TV: turn on developer options and network/ADB debugging, then approve
// Photon when the TV asks "Allow debugging?" (tick "Always allow").

const net = require('net');
const crypto = require('crypto');
const os = require('os');
const { makeTv } = require('./common');

const PORT = Number(process.env.ADB_PORT || 5555);
const CMD = { CNXN: 0x4e584e43, AUTH: 0x48545541, OPEN: 0x4e45504f, OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257 };
const VERSION = 0x01000000;
const MAXDATA = 256 * 1024;
const SHA1_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');

function packet(cmd, a0, a1, data = Buffer.alloc(0)) {
  const h = Buffer.alloc(24);
  let sum = 0; for (const b of data) sum = (sum + b) >>> 0;
  h.writeUInt32LE(cmd, 0); h.writeUInt32LE(a0 >>> 0, 4); h.writeUInt32LE(a1 >>> 0, 8);
  h.writeUInt32LE(data.length, 12); h.writeUInt32LE(sum, 16); h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, data]);
}

// Android's own public key format: the RSA modulus and Montgomery helpers as little-endian words.
function androidPublicKey(pem) {
  const jwk = crypto.createPublicKey(pem).export({ format: 'jwk' });
  const n = BigInt(`0x${Buffer.from(jwk.n, 'base64url').toString('hex')}`);
  const e = Number(BigInt(`0x${Buffer.from(jwk.e, 'base64url').toString('hex')}`));
  const words = 64;
  const b32 = 1n << 32n;
  const modInv = (a, m) => { let [r0, r1, s0, s1] = [a % m, m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return ((s0 % m) + m) % m; };
  const n0inv = (b32 - modInv(n % b32, b32)) % b32;
  const rr = (1n << BigInt(words * 32 * 2)) % n;
  const buf = Buffer.alloc(4 + 4 + words * 4 * 2 + 4);
  let o = 0;
  buf.writeUInt32LE(words, o); o += 4;
  buf.writeUInt32LE(Number(n0inv), o); o += 4;
  for (let i = 0, x = n; i < words; i++, x >>= 32n) { buf.writeUInt32LE(Number(x & 0xffffffffn), o); o += 4; }
  for (let i = 0, x = rr; i < words; i++, x >>= 32n) { buf.writeUInt32LE(Number(x & 0xffffffffn), o); o += 4; }
  buf.writeUInt32LE(e, o);
  return Buffer.from(`${buf.toString('base64')} photon@${os.hostname()}\0`);
}

// One ADB connection per device, kept open. Each check runs one shell command over it.
const conns = new Map();

function connect(host, keyPem, { approvalMs = 0 } = {}) {
  const cur = conns.get(host);
  if (cur && !cur.sock.destroyed) return cur.ready;
  const st = { streams: new Map(), nextId: 1 };
  st.ready = new Promise((resolve, reject) => {
    const [h, p] = host.includes(':') ? host.split(':') : [host, PORT];
    const sock = net.connect({ host: h, port: Number(p) });
    st.sock = sock;
    let buf = Buffer.alloc(0);
    let signed = false;
    const fail = err => { clearTimeout(timer); sock.destroy(); reject(err); };
    const timer = setTimeout(() => fail(Object.assign(new Error(approvalMs
      ? 'the TV didn\'t approve Photon in time. Click Pair again and choose Allow (tick "Always allow") on the TV.'
      : 'Photon isn\'t approved on this TV yet. Click Pair and choose Allow on the TV.'), { auth: true })), 6000 + approvalMs);
    sock.setNoDelay(true);
    sock.on('connect', () => sock.write(packet(CMD.CNXN, VERSION, MAXDATA, Buffer.from('host::\0'))));
    sock.on('error', err => fail(err));
    sock.on('close', () => {
      conns.delete(host);
      for (const s of st.streams.values()) s.done(new Error('connection closed'));
      st.streams.clear();
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 24) {
        const len = buf.readUInt32LE(12);
        if (buf.length < 24 + len) break;
        const cmd = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4), a1 = buf.readUInt32LE(8);
        const data = buf.subarray(24, 24 + len);
        buf = buf.subarray(24 + len);
        if (cmd === CMD.AUTH && a0 === 1) { // the device sent a token to sign
          if (!signed) {
            signed = true;
            const sig = crypto.privateEncrypt({ key: keyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_PREFIX, data]));
            sock.write(packet(CMD.AUTH, 2, 0, sig));
          } else {
            if (!approvalMs) return fail(Object.assign(new Error('Photon isn\'t approved on this TV yet. Click Pair and choose Allow on the TV.'), { auth: true }));
            sock.write(packet(CMD.AUTH, 3, 0, androidPublicKey(crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'pem' })))); // shows "Allow debugging?"
          }
        } else if (cmd === CMD.CNXN) {
          clearTimeout(timer);
          st.banner = data.toString();
          resolve(st);
        } else if (cmd === CMD.OKAY) {
          const s = st.streams.get(a1); if (s) s.remote = a0;
        } else if (cmd === CMD.WRTE) {
          const s = st.streams.get(a1);
          if (s) { s.out.push(Buffer.from(data)); sock.write(packet(CMD.OKAY, a1, a0)); }
        } else if (cmd === CMD.CLSE) {
          const s = st.streams.get(a1);
          if (s) { sock.write(packet(CMD.CLSE, a1, a0)); s.done(null, Buffer.concat(s.out).toString()); }
        }
      }
    });
  });
  st.ready.catch(() => conns.delete(host));
  conns.set(host, st);
  return st.ready;
}

async function shell(host, keyPem, command) {
  const st = await connect(host, keyPem);
  const local = st.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { st.streams.delete(local); reject(new Error('no answer')); }, 6000);
    st.streams.set(local, { out: [], done: (err, text) => { clearTimeout(timer); st.streams.delete(local); err ? reject(err) : resolve(text); } });
    st.sock.write(packet(CMD.OPEN, local, 0, Buffer.from(`shell:${command}\0`)));
  });
}

const APPS = {
  'com.netflix.ninja': 'Netflix', 'com.netflix.mediaclient': 'Netflix', 'com.google.android.youtube.tv': 'YouTube', 'com.amazon.firetv.youtube': 'YouTube',
  'com.amazon.amazonvideo.livingroom': 'Prime Video', 'com.amazon.avod': 'Prime Video', 'com.disney.disneyplus': 'Disney+', 'com.hbo.hbonow': 'Max',
  'com.wbd.stream': 'Max', 'com.hulu.livingroomplus': 'Hulu', 'com.plexapp.android': 'Plex', 'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.spotify.tv.android': 'Spotify', 'com.peacocktv.peacockandroid': 'Peacock', 'com.cbs.ott': 'Paramount+', 'tv.pluto.android': 'Pluto TV',
  'org.jellyfin.androidtv': 'Jellyfin', 'org.xbmc.kodi': 'Kodi', 'com.google.android.apps.youtube.music': 'YouTube Music',
};
const appName = pkg => APPS[pkg] || (pkg ? pkg.split('.').filter(p => !/^(com|org|tv|android|app|apps)$/.test(p)).slice(0, 2).join(' ') : '');

// Reads `dumpsys media_session`: each session has its app (package=), whether it's active, and
// a PlaybackState (3 playing, 2 paused, 6 buffering).
function parseSessions(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const pkg = /^\s*package=(\S+)/.exec(line);
    if (pkg) { cur = { pkg: pkg[1], active: false, state: 0, title: '', duration: 0, position: 0 }; out.push(cur); continue; }
    if (!cur) continue;
    let m;
    if ((m = /^\s*active=(true|false)/.exec(line))) cur.active = m[1] === 'true';
    else if ((m = /state=PlaybackState \{state=(\d+), position=(-?\d+)/.exec(line))) { cur.state = Number(m[1]); cur.position = Number(m[2]); }
    else if ((m = /metadata:.*description=([^,]+)/.exec(line))) cur.title = m[1].trim() === 'null' ? '' : m[1].trim();
    else if ((m = /android\.media\.metadata\.DURATION=(\d+)/.exec(line))) cur.duration = Number(m[1]);
  }
  return out;
}

module.exports = makeTv({
  id: 'androidtv',
  label: 'Android TV / Fire TV',
  short: 'Android and Fire TVs',
  blurb: 'Google TV, Android TV, Fire TV, NVIDIA Shield and Android-based TVs report play and pause for every app. One-time setup on the TV: turn on developer options and ADB or network debugging (Fire TV: Settings > My Fire TV > Developer options > ADB debugging; Google TV: tap Build 7 times under Settings > System > About, then turn on USB debugging). Then click Pair and choose Allow on the TV, ticking "Always allow".',
  actions: [{ id: 'pair', label: 'Pair (then allow on the TV)' }],
  async action(id, c, hosts) {
    if (id !== 'pair') throw new Error(`unknown action ${id}`);
    if (!hosts.length) throw new Error('Type the TV\'s IP address first.');
    const patch = {};
    let key = c.adbKey;
    if (!key) { key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey; patch.adbKey = key; }
    const ok = [];
    for (const host of hosts) {
      conns.get(host)?.sock.destroy();
      conns.delete(host);
      await connect(host, key, { approvalMs: 60000 }).catch(err => { throw new Error(`${host}: ${err.message}`); });
      ok.push(host);
    }
    return { patch, message: `Approved on ${ok.join(', ')}.` };
  },
  async describe(c, host) {
    if (!c.adbKey) throw Object.assign(new Error('click Pair first'), { auth: true });
    const st = await connect(host, c.adbKey);
    const props = Object.fromEntries((/::(.*)$/.exec(st.banner || '')?.[1] || '').split(';').map(x => x.split('=')).filter(x => x.length === 2));
    const name = (await shell(host, c.adbKey, 'settings get global device_name').catch(() => '')).trim();
    return { id: host, name: name && name !== 'null' ? name : props['ro.product.model'] || `Android TV at ${host}`, product: [props['ro.product.manufacturer'] || props['ro.product.name'], props['ro.product.model']].filter(Boolean).join(' ') || 'Android TV' };
  },
  async probe(c, host) {
    if (!c.adbKey) throw Object.assign(new Error('click Pair first'), { auth: true });
    const st = await connect(host, c.adbKey);
    const sessions = parseSessions(await shell(host, c.adbKey, 'dumpsys media_session'));
    const live = sessions.filter(s => s.active && [2, 3, 6].includes(s.state));
    const s = live.find(x => x.state === 3 || x.state === 6) || live[0];
    const name = st.name || (st.name = await shell(host, c.adbKey, 'settings get global device_name').then(t => t.trim()).catch(() => '')) || '';
    const base = { id: host, name: name && name !== 'null' ? name : `Android TV at ${host}`, product: 'Android TV' };
    if (!s) return { ...base, state: 'idle' };
    const app = appName(s.pkg);
    return { ...base, state: s.state === 2 ? 'paused' : 'playing', app, title: s.title ? `${app}: ${s.title}` : app, position: s.position, runtime: s.duration };
  },
  close() { for (const st of conns.values()) st.sock.destroy(); conns.clear(); },
});

module.exports._test = { parseSessions, androidPublicKey, packet, CMD };
