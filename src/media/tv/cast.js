'use strict';

// Chromecast, Google TV and anything with Chromecast built in (many Vizio, Sony, TCL, Hisense
// and Philips TVs, and Nest speakers and displays). Speaks the Cast protocol on port 8009 and
// reports play and pause for anything cast to the device from a phone or computer. Apps opened
// directly on a Google TV aren't casts; for those use "Android TV / Fire TV".

const tls = require('tls');
const { makeTv, mdns } = require('./common');

const PORT = Number(process.env.CAST_PORT || 8009);
const NS = {
  conn: 'urn:x-cast:com.google.cast.tp.connection',
  beat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  recv: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};

// ---- CastMessage protobuf, by hand (only six fields) ----
function varint(n) { const b = []; while (n > 127) { b.push((n & 127) | 128); n >>>= 7; } b.push(n); return Buffer.from(b); }
function field(no, str) { const v = Buffer.from(str); return Buffer.concat([Buffer.from([(no << 3) | 2]), varint(v.length), v]); }
function encode(src, dst, ns, payload) {
  const body = Buffer.concat([Buffer.from([0x08, 0]), field(2, src), field(3, dst), field(4, ns), Buffer.from([0x28, 0]), field(6, JSON.stringify(payload))]);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}
function decode(buf) {
  const out = {};
  let i = 0;
  const readVar = () => { let n = 0, s = 0, b; do { b = buf[i++]; n |= (b & 127) << s; s += 7; } while (b & 128); return n >>> 0; };
  while (i < buf.length) {
    const key = readVar(), no = key >> 3, wt = key & 7;
    if (wt === 0) { out[no] = readVar(); continue; }
    if (wt === 2) { const len = readVar(); out[no] = buf.subarray(i, i + len); i += len; continue; }
    break;
  }
  return { src: String(out[2] || ''), dst: String(out[3] || ''), ns: String(out[4] || ''), payload: out[6] ? String(out[6]) : '' };
}

const conns = new Map(); // host -> state

function connect(host) {
  const cur = conns.get(host);
  if (cur && !cur.sock.destroyed) return cur.ready;
  const st = { apps: [], media: null, transports: new Set(), reqId: 1 };
  st.ready = new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: PORT, rejectUnauthorized: false, timeout: 4000 }); // Cast devices use self-signed certificates
    st.sock = sock;
    st.send = (dst, ns, payload) => sock.write(encode('sender-0', dst, ns, payload));
    let buf = Buffer.alloc(0);
    sock.on('timeout', () => sock.destroy(new Error('no answer')));
    sock.on('secureConnect', () => {
      sock.setTimeout(0);
      st.send('receiver-0', NS.conn, { type: 'CONNECT' });
      st.beat = setInterval(() => st.send('receiver-0', NS.beat, { type: 'PING' }), 5000);
      resolve(st);
    });
    sock.on('error', reject);
    sock.on('close', () => { clearInterval(st.beat); conns.delete(host); });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0);
        const msg = decode(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
        let p = {};
        try { p = JSON.parse(msg.payload); } catch { continue; }
        if (msg.ns === NS.beat && p.type === 'PING') st.send(msg.src, NS.beat, { type: 'PONG' });
        else if (p.type === 'RECEIVER_STATUS') {
          st.apps = p.status?.applications || [];
          const app = st.apps.find(a => !a.isIdleScreen && (a.namespaces || []).some(n => n.name === NS.media));
          if (!app) st.media = null;
          else if (!st.transports.has(app.transportId)) { st.transports.add(app.transportId); st.send(app.transportId, NS.conn, { type: 'CONNECT' }); }
        } else if (p.type === 'MEDIA_STATUS') st.media = (p.status || [])[0] || null;
      }
    });
  });
  st.ready.catch(() => conns.delete(host));
  conns.set(host, st);
  return st.ready;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

module.exports = makeTv({
  id: 'cast',
  label: 'Chromecast',
  short: 'Cast devices',
  blurb: 'Chromecast, Google TV and TVs with Chromecast built in (including most Vizio TVs) report play and pause for anything you cast to them from a phone, tablet or computer. Nothing to pair.',
  async discover() {
    const list = await mdns('_googlecast._tcp.local');
    return list.map(d => ({ host: d.host, name: d.txt.fn || d.name, id: d.txt.id, model: d.txt.md }));
  },
  async describe(c, host, f) {
    await connect(host);
    return { id: f?.id || host, name: f?.name || `Cast device at ${host}`, product: f?.model ? `Chromecast, ${f.model}` : 'Chromecast' };
  },
  async probe(c, host, f) {
    const st = await connect(host);
    st.send('receiver-0', NS.recv, { type: 'GET_STATUS', requestId: st.reqId++ });
    const app = st.apps.find(a => !a.isIdleScreen && (a.namespaces || []).some(n => n.name === NS.media));
    if (app) st.send(app.transportId, NS.media, { type: 'GET_STATUS', requestId: st.reqId++ });
    await wait(400);
    const m = st.media;
    const ps = m?.playerState;
    const state = !app || !m ? 'idle' : ps === 'PAUSED' ? 'paused' : ['PLAYING', 'BUFFERING'].includes(ps) ? 'playing' : 'idle';
    const md = m?.media?.metadata || {};
    const type = { 1: 'movie', 2: 'episode', 3: 'music' }[md.metadataType];
    const title = md.seriesTitle ? `${md.seriesTitle} ${md.title || ''}`.trim() : md.title || app?.displayName || 'Cast';
    return {
      id: f?.id || host, name: f?.name || `Cast device at ${host}`, product: f?.model ? `Chromecast, ${f.model}` : 'Chromecast',
      state, app: app?.displayName || '', title, mediaType: type, position: (m?.currentTime || 0) * 1000, runtime: (m?.media?.duration || 0) * 1000,
    };
  },
  close() { for (const st of conns.values()) st.sock.destroy(); conns.clear(); },
});

module.exports._test = { encode, decode };
