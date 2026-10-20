'use strict';
// Stand-ins for Smart TVs, for trying the Smart TVs section without real TVs.
// Run Photon with: ROKU (host 127.0.0.1:18060), SAMSUNG (127.0.0.1:18001), VIZIO_PORT=17345,
// Kodi (127.0.0.1:18080, user kodi, password kodipass), LG_WS_PORT=13000, CAST_PORT=18009, ADB_PORT=15555, all on host 127.0.0.1.
// Change what they report with POST http://127.0.0.1:18099/set {"tv":"roku","state":"play"}.
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const state = { kodi: 'stop', roku: 'stop', samsung: 'on', vizio: 1, lg: 'unloaded', cast: 'IDLE', adb: 0 };
const log = [];
const key = fs.readFileSync(path.join(__dirname, 'fixtures/dirigera-key.pem'));
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/dirigera-cert.pem'));

http.createServer((q, s) => {
  let b = ''; q.on('data', d => { b += d; }); q.on('end', () => {
    if (q.url === '/set') { const j = JSON.parse(b); state[j.tv] = j.state; s.end('ok'); return; }
    s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify({ state, log }));
  });
}).listen(18099);

// Kodi JSON-RPC (Basic auth kodi / kodipass). state.kodi: stop, play, pause or music.
http.createServer((q, s) => {
  let b = ''; q.on('data', d => { b += d; }); q.on('end', () => {
    if (q.headers.authorization !== `Basic ${Buffer.from('kodi:kodipass').toString('base64')}`) { s.statusCode = 401; return s.end(); }
    if (q.method !== 'POST' || q.url !== '/jsonrpc') { s.statusCode = 404; return s.end(); }
    const { id, method } = JSON.parse(b);
    const st = state.kodi;
    const reply = result => { s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
    if (method === 'JSONRPC.Ping') return reply('pong');
    if (method === 'XBMC.GetInfoLabels') return reply({ 'System.FriendlyName': 'Kodi (Den LibreELEC)' });
    if (method === 'Player.GetActivePlayers') return reply(st === 'stop' ? [] : st === 'music' ? [{ playerid: 0, type: 'audio' }] : [{ playerid: 1, type: 'video' }, { playerid: 2, type: 'picture' }]);
    if (method === 'Player.GetProperties') return reply({ speed: st === 'pause' ? 0 : 1, time: { hours: 0, minutes: 2, seconds: 5, milliseconds: 0 }, totaltime: { hours: 0, minutes: 44, seconds: 0, milliseconds: 0 } });
    if (method === 'Player.GetItem') return reply({ item: st === 'music' ? { type: 'song', label: 'Song', title: 'Clair de Lune' } : { type: 'episode', label: 'Pilot', title: 'Pilot', showtitle: 'The Expanse', season: 1, episode: 1 } });
    s.setHeader('Content-Type', 'application/json'); s.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } }));
  });
}).listen(18080);

// Roku ECP
http.createServer((q, s) => {
  s.setHeader('Content-Type', 'text/xml');
  if (q.url === '/query/device-info') return s.end('<?xml version="1.0"?><device-info><serial-number>X01234ROKU</serial-number><user-device-name>Bedroom Roku</user-device-name><model-name>Roku Ultra</model-name><is-tv>false</is-tv><power-mode>PowerOn</power-mode></device-info>');
  if (q.url === '/query/media-player') {
    const st = state.roku;
    if (st === 'stop') return s.end('<?xml version="1.0"?><player error="false" state="close"/>');
    return s.end(`<?xml version="1.0"?><player error="false" state="${st}"><plugin bandwidth="10000000 bps" id="12" name="Netflix"/><format audio="eac3" video="hevc"/><position>125000 ms</position><duration>6800000 ms</duration><is_live>false</is_live></player>`);
  }
  s.statusCode = 404; s.end();
}).listen(18060);

// Samsung
http.createServer((q, s) => {
  if (state.samsung === 'gone') { q.socket.destroy(); return; }
  s.setHeader('Content-Type', 'application/json');
  s.end(JSON.stringify({ name: 'Samsung Q80', device: { id: 'uuid:samsung-1', name: 'Family Room Samsung', modelName: 'QN65Q80', PowerState: state.samsung } }));
}).listen(18001);

// Vizio SmartCast
let vizioPair = null;
https.createServer({ key, cert }, (q, s) => {
  let b = ''; q.on('data', d => { b += d; }); q.on('end', () => {
    const ok = ITEM => s.end(JSON.stringify({ STATUS: { RESULT: 'SUCCESS' }, ...ITEM }));
    const authed = q.headers.auth === 'vizio-token-1';
    if (q.url === '/pairing/start') { vizioPair = 4242; log.push('vizio pin shown 1234'); return ok({ ITEM: { PAIRING_REQ_TOKEN: vizioPair, CHALLENGE_TYPE: 1 } }); }
    if (q.url === '/pairing/pair') { const j = JSON.parse(b); if (j.RESPONSE_VALUE === '1234' && j.PAIRING_REQ_TOKEN === vizioPair) return ok({ ITEM: { AUTH_TOKEN: 'vizio-token-1' } }); return s.end(JSON.stringify({ STATUS: { RESULT: 'INVALID_PIN' } })); }
    if (q.url === '/state/device/deviceinfo') return ok({ ITEMS: [{ VALUE: { MODEL_NAME: 'M65Q7-J01', SYSTEM_INFO: { SERIAL_NUMBER: 'VIZ123' } } }] });
    if (q.url === '/state/device/power_mode') return ok({ ITEMS: [{ VALUE: state.vizio }] });
    if (q.url === '/menu_native/dynamic/tv_settings/devices/current_input') return authed ? ok({ ITEMS: [{ VALUE: 'SMARTCAST' }] }) : s.end(JSON.stringify({ STATUS: { RESULT: 'URI_NOT_FOUND' } }));
    s.end(JSON.stringify({ STATUS: { RESULT: 'URI_NOT_FOUND' } }));
  });
}).listen(17345);

// LG webOS
const lgKeys = new Set();
const lgSubs = new Set();
new WebSocketServer({ port: 13000 }).on('connection', ws => {
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'register') {
      if (m.payload['client-key'] && lgKeys.has(m.payload['client-key'])) return ws.send(JSON.stringify({ type: 'registered', id: m.id, payload: { 'client-key': m.payload['client-key'] } }));
      ws.send(JSON.stringify({ type: 'response', id: m.id, payload: { pairingType: 'PROMPT', returnValue: true } }));
      log.push('lg prompt shown');
      setTimeout(() => { const k = 'lg-key-' + crypto.randomBytes(4).toString('hex'); lgKeys.add(k); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'registered', id: m.id, payload: { 'client-key': k } })); }, 1200);
      return;
    }
    if (m.uri === 'ssap://com.webos.media/getForegroundAppInfo') { lgSubs.add({ ws, id: m.id }); ws.send(JSON.stringify({ type: 'response', id: m.id, payload: { subscribed: true, foregroundAppInfo: lgMedia() } })); }
    else if (m.uri === 'ssap://com.webos.applicationManager/getForegroundAppInfo') ws.send(JSON.stringify({ type: 'response', id: m.id, payload: { appId: 'netflix' } }));
    else if (m.uri === 'ssap://system/getSystemInfo') ws.send(JSON.stringify({ type: 'response', id: m.id, payload: { modelName: 'OLED65C3PUA', serialNumber: 'LG-SERIAL-9' } }));
  });
  ws.on('close', () => { for (const s of lgSubs) if (s.ws === ws) lgSubs.delete(s); });
});
const lgMedia = () => (state.lg === 'unloaded' ? [] : [{ appId: 'netflix', playState: state.lg, type: 'media' }]);
let lastLg = state.lg;
setInterval(() => { if (state.lg !== lastLg) { lastLg = state.lg; for (const s of lgSubs) s.ws.send(JSON.stringify({ type: 'response', id: s.id, payload: { subscribed: true, foregroundAppInfo: lgMedia() } })); } }, 200);

// Chromecast
const { _test: castCodec } = require('../src/media/tv/cast.js');
tls.createServer({ key, cert }, sock => {
  let buf = Buffer.alloc(0);
  const send = (src, dst, ns, p) => sock.write(castCodec.encode(src, dst, ns, p));
  sock.on('error', () => {});
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const len = buf.readUInt32BE(0); const m = castCodec.decode(buf.subarray(4, 4 + len)); buf = buf.subarray(4 + len);
      const p = JSON.parse(m.payload);
      if (p.type === 'GET_STATUS' && m.ns.endsWith('receiver')) {
        const apps = state.cast === 'NONE' ? [] : [{ appId: '233637DE', displayName: 'YouTube', transportId: 'web-5', sessionId: 's1', isIdleScreen: false, namespaces: [{ name: 'urn:x-cast:com.google.cast.media' }] }];
        send('receiver-0', m.src, m.ns, { type: 'RECEIVER_STATUS', requestId: p.requestId, status: { applications: apps } });
      } else if (p.type === 'GET_STATUS' && m.ns.endsWith('media')) {
        send(m.dst, m.src, m.ns, { type: 'MEDIA_STATUS', requestId: p.requestId, status: state.cast === 'IDLE' ? [] : [{ playerState: state.cast, currentTime: 61, media: { duration: 5400, metadata: { metadataType: 1, title: 'Big Buck Bunny' } } }] });
      }
    }
  });
}).listen(18009);

// ADB
const approved = [];
function adbPub(b64) {
  const buf = Buffer.from(b64.split(' ')[0], 'base64');
  const words = buf.readUInt32LE(0);
  let n = 0n; for (let i = words - 1; i >= 0; i--) n = (n << 32n) | BigInt(buf.readUInt32LE(8 + i * 4));
  const e = buf.readUInt32LE(8 + words * 8);
  const hex = n.toString(16); const nb = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  return crypto.createPublicKey({ key: { kty: 'RSA', n: nb.toString('base64url'), e: Buffer.from([0, 1, 0, 1].slice(e === 65537 ? 1 : 0)).toString('base64url') }, format: 'jwk' });
}
const { packet, CMD } = require('../src/media/tv/androidtv.js')._test;
const sessions = () => `MEDIA SESSION SERVICE (dumpsys media_session)
Sessions Stack - have 1 sessions:
    NetflixSession com.netflix.ninja/NetflixSession (userId=0)
      ownerPid=1234, ownerUid=10085, userId=0
      package=com.netflix.ninja
      launchIntent=null
      active=${state.adb ? 'true' : 'false'}
      state=PlaybackState {state=${state.adb}, position=1234000, buffered position=0, speed=1.0, updated=1, actions=0, custom actions=[], active item id=-1, error=null}
      metadata: size=3, description=Stranger Things, Chapter One, null
`;
net.createServer(sock => {
  let buf = Buffer.alloc(0); let token; let authed = false;
  sock.on('error', () => {});
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 24 && buf.length >= 24 + buf.readUInt32LE(12)) {
      const cmd = buf.readUInt32LE(0), a0 = buf.readUInt32LE(4), a1 = buf.readUInt32LE(8), len = buf.readUInt32LE(12);
      const data = buf.subarray(24, 24 + len); buf = buf.subarray(24 + len);
      if (cmd === CMD.CNXN) { token = crypto.randomBytes(20); sock.write(packet(CMD.AUTH, 1, 0, token)); }
      else if (cmd === CMD.AUTH && a0 === 2) {
        const okKey = approved.find(k => { try { return crypto.publicDecrypt({ key: k, padding: crypto.constants.RSA_PKCS1_PADDING }, data).subarray(-20).equals(token); } catch { return false; } });
        if (okKey) { authed = true; sock.write(packet(CMD.CNXN, 0x01000000, 4096, Buffer.from('device::ro.product.name=sabrina;ro.product.model=Chromecast;ro.product.manufacturer=Google;\0'))); }
        else { token = crypto.randomBytes(20); sock.write(packet(CMD.AUTH, 1, 0, token)); }
      } else if (cmd === CMD.AUTH && a0 === 3) {
        log.push('adb allow prompt shown');
        setTimeout(() => { approved.push(adbPub(data.toString().replace(/\0$/, ''))); authed = true; sock.write(packet(CMD.CNXN, 0x01000000, 4096, Buffer.from('device::ro.product.model=Chromecast;\0'))); }, 1000);
      } else if (cmd === CMD.OPEN && authed) {
        const c = data.toString().replace(/\0$/, '');
        const remote = 1000 + a0;
        sock.write(packet(CMD.OKAY, remote, a0));
        const out = c === 'shell:dumpsys media_session' ? sessions() : c === 'shell:settings get global device_name' ? 'Living Room Google TV\n' : '';
        sock.write(packet(CMD.WRTE, remote, a0, Buffer.from(out)));
        setTimeout(() => sock.write(packet(CMD.CLSE, remote, a0)), 30);
      }
    }
  });
}).listen(15555);

console.log('tv mocks up');
