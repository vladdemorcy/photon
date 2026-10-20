'use strict';

// Kodi (and Kodi-based players like LibreELEC, OSMC and CoreELEC boxes), through Kodi's
// JSON-RPC web interface. Photon asks every couple of seconds what's playing, the same way it
// follows TVs, so play, pause, resume and stop all work, whatever add-on is playing.
//
// In Kodi: Settings > Services > Control > "Allow remote control via HTTP" on, with a username
// and password (Kodi 19 and newer require one). Port 8080 unless you changed it there.

const { http } = require('../../util');
const { makeTv, mdns } = require('./common');

const defaultPort = c => Number(c.port) || Number(process.env.KODI_PORT) || 8080;
const base = (c, host) => (host.includes(':') ? `http://${host}` : `http://${host}:${defaultPort(c)}`);

let rpcId = 0;
async function rpc(c, host, method, params) {
  const headers = {};
  if (c.username || c.password) headers.Authorization = `Basic ${Buffer.from(`${c.username || 'kodi'}:${c.password || ''}`).toString('base64')}`;
  let res;
  try {
    res = await http('POST', `${base(c, host)}/jsonrpc`, { body: { jsonrpc: '2.0', id: ++rpcId, method, params }, headers, timeout: 2500 });
  } catch (err) {
    if (err.status === 401) {
      throw Object.assign(new Error('Kodi wants a username and password. Use the ones in Kodi under Settings > Services > Control > Web server.'), { auth: true });
    }
    throw err;
  }
  if (res?.error) throw new Error(`Kodi: ${res.error.message || 'request refused'}`);
  return res?.result;
}

// The name set in Kodi (Settings > Services > General > Device name), cached for a while.
const names = new Map();
async function deviceName(c, host) {
  const hit = names.get(host);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.name;
  let name = '';
  try {
    const r = await rpc(c, host, 'XBMC.GetInfoLabels', { labels: ['System.FriendlyName'] });
    name = String(r?.['System.FriendlyName'] || '').replace(/^Kodi \((.+)\)$/, '$1');
  } catch (err) { if (err.auth) throw err; }
  name = name || `Kodi at ${host}`;
  names.set(host, { at: Date.now(), name });
  return name;
}

const TYPE = { movie: 'movie', episode: 'episode', song: 'music', musicvideo: 'music', channel: 'other' };
const msOf = t => (t ? ((t.hours || 0) * 3600 + (t.minutes || 0) * 60 + (t.seconds || 0)) * 1000 + (t.milliseconds || 0) : 0);

async function probe(c, host) {
  const name = await deviceName(c, host);
  const info = { id: host, name, product: 'Kodi' };
  const players = await rpc(c, host, 'Player.GetActivePlayers');
  // Video first: a slideshow or music playing alongside a video shouldn't hide the video.
  const player = (players || []).find(p => p.type === 'video') || (players || []).find(p => p.type === 'audio');
  if (!player) return { ...info, state: 'idle' };
  const [props, item] = await Promise.all([
    rpc(c, host, 'Player.GetProperties', { playerid: player.playerid, properties: ['speed', 'time', 'totaltime'] }),
    rpc(c, host, 'Player.GetItem', { playerid: player.playerid, properties: ['title', 'showtitle', 'season', 'episode'] }),
  ]);
  const it = item?.item || {};
  const title = it.showtitle && it.type === 'episode'
    ? `${it.showtitle}${it.season > 0 ? ` S${it.season}E${it.episode}` : ''}${it.title ? `: ${it.title}` : ''}`
    : it.title || it.label || 'Kodi';
  const mediaType = player.type === 'audio' ? 'music' : TYPE[it.type];
  return {
    ...info, state: props?.speed === 0 ? 'paused' : 'playing', title, app: 'Kodi', mediaType,
    position: msOf(props?.time), runtime: msOf(props?.totaltime),
  };
}

module.exports = makeTv({
  id: 'kodi',
  label: 'Kodi',
  short: 'Kodi players',
  blurb: 'Kodi, and boxes that run it (LibreELEC, OSMC, CoreELEC, Shield with Kodi). Photon reads play, pause and stop for anything Kodi plays, from your library or any add-on. In Kodi, turn on Settings > Services > Control > "Allow remote control via HTTP" and set a username and password there. To be found by itself, also turn on "Announce services to other systems" under Settings > Services > General.',
  fields: [
    { key: 'port', label: 'Web server port (from Kodi\'s Settings > Services > Control)', placeholder: '8080', default: '8080' },
    { key: 'username', label: 'Username', placeholder: 'kodi', default: 'kodi' },
    { key: 'password', label: 'Password', placeholder: 'The one set in Kodi', secret: true },
  ],
  pollMs: 2000,
  async discover(c) {
    const list = await mdns('_xbmc-jsonrpc-h._tcp.local');
    // Kodi announces its web server port; only keep it in the address when it isn't the usual one.
    return list.map(d => ({ host: d.port && d.port !== defaultPort(c) ? `${d.host}:${d.port}` : d.host, name: d.name }));
  },
  // A real request each time, so a wrong password shows up even when the name is cached.
  async describe(c, host) {
    await rpc(c, host, 'JSONRPC.Ping');
    return { id: host, name: await deviceName(c, host), product: 'Kodi' };
  },
  probe,
});
