'use strict';

// LG webOS TVs, through the TV's own websocket interface (ws port 3000, or wss 3001 on newer
// firmware). Once Photon is approved on the TV, it reports play and pause for apps that use the
// TV's media player, which covers Netflix, YouTube, Prime Video, Disney+ and most others.
// The registration manifest is the one used by aiowebostv (Apache License 2.0).

const WebSocket = require('ws');
const { makeTv, ssdp } = require('./common');

const WS_PORT = Number(process.env.LG_WS_PORT || 3000);
const WSS_PORT = Number(process.env.LG_WSS_PORT || 3001);
const PERMISSIONS = ['APP_TO_APP', 'CLOSE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TEXT', 'CONTROL_INPUT_TV', 'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'CONTROL_TV_SCREEN',
  'LAUNCH', 'LAUNCH_WEBAPP', 'READ_APP_STATUS', 'READ_COUNTRY_INFO', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS',
  'READ_LGE_SDX', 'READ_LGE_TV_INPUT_EVENTS', 'READ_NETWORK_STATE', 'READ_NOTIFICATIONS', 'READ_POWER_STATE', 'READ_RUNNING_APPS', 'READ_SETTINGS',
  'READ_TV_CHANNEL_LIST', 'READ_TV_CURRENT_TIME', 'READ_UPDATE_INFO', 'SEARCH', 'TEST_OPEN', 'TEST_PROTECTED', 'TEST_SECURE',
  'UPDATE_FROM_REMOTE_APP', 'WRITE_NOTIFICATION_ALERT', 'WRITE_NOTIFICATION_TOAST', 'WRITE_SETTINGS'];

const APP_NAMES = {
  netflix: 'Netflix', 'youtube.leanback.v4': 'YouTube', amazon: 'Prime Video', 'com.disney.disneyplus-prod': 'Disney+',
  'com.hbo.hbomax': 'Max', 'cdp-30': 'Plex', 'com.apple.appletv': 'Apple TV', hulu: 'Hulu', 'com.webos.app.livetv': 'Live TV',
  'com.webos.app.hdmi1': 'HDMI 1', 'com.webos.app.hdmi2': 'HDMI 2', 'com.webos.app.hdmi3': 'HDMI 3', 'com.webos.app.hdmi4': 'HDMI 4',
  spotify: 'Spotify', 'spotify-beehive': 'Spotify', 'com.webos.app.home': 'Home',
};
const appName = id => APP_NAMES[id] || (id ? id.replace(/^com\.[^.]+\./, '').replace(/[.-]/g, ' ') : '');

const clients = new Map(); // host -> { ws, ready, media, app, name, error }

function open(host, secure) {
  return new WebSocket(secure ? `wss://${host}:${WSS_PORT}` : `ws://${host}:${WS_PORT}`, { rejectUnauthorized: false, handshakeTimeout: 4000 });
}

// Connects, registers (showing a prompt on the TV the first time) and subscribes to playback.
// onKey is called with a new client key when the TV approves Photon.
function connect(host, key, onKey, { waitForApproval = 0 } = {}) {
  const cur = clients.get(host);
  if (cur && cur.ws.readyState <= 1) return cur.ready;
  const st = { media: [], app: '', name: '', id: host };
  st.ready = new Promise((resolve, reject) => {
    let secure = false;
    const start = () => {
      const ws = open(host, secure);
      st.ws = ws;
      let seq = 0;
      const send = (type, uri, payload, id = `p${++seq}`) => { ws.send(JSON.stringify({ id, type, uri, payload: payload || {} })); return id; };
      const timer = setTimeout(() => { ws.terminate(); reject(Object.assign(new Error(waitForApproval ? "the TV wasn't approved in time. Click Pair again and choose Accept on the TV." : 'no answer'), { auth: Boolean(waitForApproval) })); }, 6000 + waitForApproval);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register', id: 'register_0', payload: { forcePairing: false, pairingType: 'PROMPT', manifest: { appVersion: '1.1', manifestVersion: 1, permissions: PERMISSIONS }, ...(key ? { 'client-key': key } : {}) } }));
      });
      ws.on('unexpected-response', () => { if (!secure) { secure = true; ws.terminate(); clearTimeout(timer); start(); } });
      ws.on('error', err => {
        if (!secure && /ECONNREFUSED|unexpected|socket hang up|ECONNRESET/i.test(err.message)) { secure = true; clearTimeout(timer); start(); return; }
        clearTimeout(timer); reject(err);
      });
      ws.on('close', () => { clients.delete(host); });
      ws.on('message', raw => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.id === 'register_0') {
          if (m.type === 'response' && m.payload?.pairingType === 'PROMPT' && !waitForApproval) {
            clearTimeout(timer); ws.close();
            return reject(Object.assign(new Error('Photon isn\'t approved on this TV yet. Click Pair and choose Accept on the TV.'), { auth: true }));
          }
          if (m.type === 'error') { clearTimeout(timer); ws.close(); return reject(Object.assign(new Error(`the TV said no (${m.error || 'rejected'}). Click Pair and choose Accept on the TV.`), { auth: true })); }
          if (m.type === 'registered') {
            clearTimeout(timer);
            if (m.payload?.['client-key'] && m.payload['client-key'] !== key) onKey?.(m.payload['client-key']);
            st.key = m.payload?.['client-key'] || key;
            send('subscribe', 'ssap://com.webos.media/getForegroundAppInfo', {}, 'media');
            send('subscribe', 'ssap://com.webos.applicationManager/getForegroundAppInfo', {}, 'app');
            send('request', 'ssap://system/getSystemInfo', {}, 'sys');
            resolve(st);
          }
          return;
        }
        if (m.id === 'media' && m.payload?.foregroundAppInfo) st.media = m.payload.foregroundAppInfo;
        else if (m.id === 'app' && m.payload) st.app = m.payload.appId || '';
        else if (m.id === 'sys' && m.payload) { st.name = m.payload.modelName ? `LG ${m.payload.modelName}` : ''; st.id = m.payload.serialNumber || host; }
      });
    };
    start();
  });
  st.ready.catch(() => clients.delete(host));
  clients.set(host, st);
  return st.ready;
}

module.exports = makeTv({
  id: 'lg',
  label: 'LG webOS TV',
  short: 'LG TVs',
  blurb: 'LG TVs report play and pause for most apps once Photon is approved on the TV: click Pair, then choose Accept on the TV screen. On the TV, turn on Settings > General > Devices > External Devices > "TV On With Mobile" (or "Mobile TV On") so Photon can reach it.',
  actions: [{ id: 'pair', label: 'Pair (then accept on the TV)' }],
  async discover() {
    const list = await ssdp(['urn:lge-com:service:webos-second-screen:1']);
    return [...new Map(list.map(d => [d.host, { host: d.host }])).values()];
  },
  async action(id, c, hosts) {
    if (id !== 'pair') throw new Error(`unknown action ${id}`);
    if (!hosts.length) throw new Error('Type the TV\'s IP address first, or click "Find on my network".');
    const keys = { ...(c.keys || {}) };
    const done = [];
    for (const host of hosts) {
      clients.get(host)?.ws.terminate();
      clients.delete(host);
      const st = await connect(host, keys[host], k => { keys[host] = k; }, { waitForApproval: 60000 });
      keys[host] = st.key || keys[host];
      done.push(host);
    }
    return { patch: { keys }, message: `Approved on ${done.join(', ')}.` };
  },
  async probe(c, host) {
    const key = (c.keys || {})[host];
    // Without a key the TV would show its approval prompt on every check, so wait for Pair.
    if (!key) throw Object.assign(new Error('not approved on this TV yet. Click Pair and choose Accept on the TV.'), { auth: true });
    const st = await connect(host, key);
    const media = (st.media || []).find(x => ['playing', 'paused'].includes(x.playState)) || null;
    const app = media?.appId || st.app;
    const state = media ? (media.playState === 'playing' ? 'playing' : 'paused') : 'idle';
    return { id: st.id, name: st.name || `LG TV at ${host}`, product: 'LG webOS TV', state, app: appName(app), title: appName(app) || 'LG TV' };
  },
  close() { for (const st of clients.values()) st.ws?.terminate(); clients.clear(); },
});
