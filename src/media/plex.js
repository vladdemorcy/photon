'use strict';

// Plex. Playback reaches Photon two ways, and both go through the tracker so nothing
// is counted twice:
//  - Photon watches the server's live sessions (needs sign-in, no Plex Pass). This sees
//    every playback on your server however it started, including casting from a phone.
//  - Plex webhooks (needs Plex Pass), which arrive instantly.
// Signing in uses Plex's PIN flow: the person signs in on plex.tv itself and Photon only
// receives the resulting token, never the password. With the token Photon knows which
// server is yours and who is in your Plex Home, and ignores everything else.

const crypto = require('crypto');
const { http, isPrivateIp } = require('../util');
const { mediaType } = require('./tracker');

const PLEX_TV = process.env.PLEX_TV_URL || 'https://plex.tv';
const PRODUCT = 'Photon';

// Webhook events, as tracker observations.
const KINDS = {
  'media.play': 'start',
  'media.pause': 'pause',
  'media.resume': 'resume',
  'media.stop': 'stop',
  'media.scrobble': 'scrobble',
};

let pollTimer = null;
let lastPollError = null;
let workingUrl = null; // the server address that answered last

// Cached account details, refreshed on start and every 30 minutes.
let cache = { at: 0, token: '', homeUsers: [], servers: [], account: null };

function title(md = {}) {
  if (md.type === 'episode') return `${md.grandparentTitle || ''} S${md.parentIndex ?? '?'}E${md.index ?? '?'} ${md.title || ''}`.trim();
  if (md.type === 'track') return `${md.grandparentTitle || ''} - ${md.title || ''}`;
  return md.title || 'Unknown';
}

function headers(c, token = c.token) {
  return {
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': c.clientId || 'photon-server',
    'X-Plex-Device-Name': 'Photon',
    ...(token ? { 'X-Plex-Token': token } : {}),
  };
}

// plex.tv sometimes answers in XML even when asked for JSON (home users does).
function xmlUsers(text) {
  const users = [];
  for (const m of String(text).matchAll(/<User\s([^>]*?)\/?>/g)) {
    const a = {};
    for (const [, k, v] of m[1].matchAll(/(\w+)="([^"]*)"/g)) a[k] = v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    users.push(a);
  }
  return users;
}

async function fetchAccount(c) {
  if (!c.token) return { account: null, servers: [], homeUsers: [] };
  const h = headers(c);
  const [user, resources, home] = await Promise.all([
    http('GET', `${PLEX_TV}/api/v2/user`, { headers: h }),
    http('GET', `${PLEX_TV}/api/v2/resources?includeHttps=1`, { headers: h }),
    http('GET', `${PLEX_TV}/api/home/users`, { headers: h, raw: true }).catch(() => ''),
  ]);
  let homeUsers;
  try { const j = JSON.parse(home); homeUsers = j.users || j.MediaContainer?.User || j; } catch { homeUsers = xmlUsers(home); }
  homeUsers = (Array.isArray(homeUsers) ? homeUsers : []).map(u => ({
    id: String(u.id), title: u.title || u.username || '', username: u.username || '', admin: u.admin === true || u.admin === '1',
  }));
  // A Plex account that isn't in a Plex Home is a home of one.
  if (!homeUsers.length && user) homeUsers = [{ id: String(user.id), title: user.title || user.username, username: user.username || '', admin: true }];
  const servers = (resources || [])
    .filter(r => String(r.provides || '').includes('server') && r.owned !== false)
    .map(r => ({
      id: r.clientIdentifier, name: r.name, version: r.productVersion || '',
      connections: (r.connections || r.connection || []).map(x => ({ uri: x.uri, address: x.address, port: x.port, protocol: x.protocol, local: Boolean(x.local), relay: Boolean(x.relay) })),
    }));
  // Only players on this network: plex.tv marks devices whose internet address matches ours.
  // Devices from other homes, old phones at work and friends' devices are left out.
  const players = (resources || [])
    .filter(r => /player|client/.test(String(r.provides || '')) && r.publicAddressMatches === true)
    .map(r => ({ id: r.clientIdentifier, name: r.name, product: [r.product, r.platform].filter(Boolean).join(', '), local: true }));
  return { account: user ? { id: String(user.id), name: user.title || user.username, email: user.email || '' } : null, servers, homeUsers, players };
}

async function info(c, force = false) {
  if (!c.token) return { account: null, servers: [], homeUsers: [], players: [] };
  if (!force && cache.token === c.token && Date.now() - cache.at < 30 * 60 * 1000) return cache;
  const data = await fetchAccount(c);
  cache = { ...data, at: Date.now(), token: c.token };
  return cache;
}

// Addresses to try for your server, best first: the one you typed, then local, then remote.
function serverUrls(c) {
  const out = [];
  if (c.serverUrl) out.push(String(c.serverUrl).replace(/\/+$/, ''));
  if (workingUrl) out.push(workingUrl);
  const srv = cache.servers.find(x => x.id === c.serverId) || (cache.servers.length === 1 ? cache.servers[0] : null);
  const conns = (srv?.connections || []).filter(x => !x.relay).sort((a, b) => Number(b.local) - Number(a.local));
  for (const x of conns) {
    out.push(x.uri);
    if (x.local && x.address && x.port) out.push(`http://${x.address}:${x.port}`);
  }
  return [...new Set(out.filter(Boolean))];
}

async function pms(c, path) {
  let lastErr = new Error('No address for your Plex server. Pick your server, or type its address.');
  for (const base of serverUrls(c)) {
    try {
      const res = await http('GET', `${base}${path}`, { headers: headers(c), timeout: 4000 });
      workingUrl = base;
      return res;
    } catch (err) { lastErr = err; if (base === workingUrl) workingUrl = null; }
  }
  throw lastErr;
}

function sessionInfo(m) {
  const pl = m.Player || {};
  return {
    info: {
      source: 'plex',
      playerId: pl.machineIdentifier,
      playerName: pl.title || pl.product || pl.machineIdentifier,
      product: [pl.product, pl.platform].filter(Boolean).join(', '),
      user: m.User?.title || '',
      mediaType: mediaType(m.type),
      title: title(m),
      local: pl.local === true || pl.local === '1' || isPrivateIp(pl.address) === true,
    },
    state: { paused: pl.state === 'paused', position: Number(m.viewOffset) || 0, runtime: Number(m.duration) || 0 },
    stopped: pl.state === 'stopped',
    userRef: { id: m.User?.id, title: m.User?.title },
  };
}

function isHomeUser(account) {
  if (!account) return false;
  const name = String(account.title || '').toLowerCase();
  const id = String(account.id ?? '');
  return cache.homeUsers.some(u =>
    (u.title && u.title.toLowerCase() === name) || (u.username && u.username.toLowerCase() === name) || (id && u.id === id));
}

// ---- Webhooks on the Plex account (Plex Pass) --------------------------------
// plex.tv keeps one list of webhook addresses per account. Saving replaces the whole list,
// so Photon reads it, swaps out any older Photon address, keeps everything else, and saves.
const PHOTON_HOOK = /\/webhook\/plex\/[A-Za-z0-9]+\/?$/;

async function plexTv(c, method, path, form) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${PLEX_TV}${path}`, {
      method, signal: ctrl.signal,
      headers: { ...headers(c), Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'Plex no longer accepts the sign-in. Sign in again.'
        : res.status === 403 ? 'Plex only allows webhooks on accounts with Plex Pass. Photon still works without one, it just checks your server every couple of seconds instead.'
        : `plex.tv answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('plex.tv did not answer');
    throw err;
  } finally { clearTimeout(t); }
}

async function listWebhooks(c) {
  const r = await plexTv(c, 'GET', '/api/v2/user/webhooks');
  return (Array.isArray(r) ? r : []).map(w => (typeof w === 'string' ? w : w?.url)).filter(Boolean);
}

// Make sure `url` is on the account and no older Photon address is. Returns what changed.
async function syncWebhook(c, url) {
  const current = await listWebhooks(c);
  const stale = current.filter(u => u !== url && PHOTON_HOOK.test(u));
  if (current.includes(url) && !stale.length) return { changed: false, removed: [] };
  const keep = current.filter(u => u !== url && !PHOTON_HOOK.test(u));
  const list = [...keep, url];
  const form = list.map(u => `urls[]=${encodeURIComponent(u)}`).join('&');
  await plexTv(c, 'POST', '/api/v2/user/webhooks', form);
  const after = await listWebhooks(c).catch(() => list);
  if (!after.includes(url)) throw new Error('plex.tv accepted the change but the address is not on the list. Webhooks need Plex Pass.');
  return { changed: true, removed: stale };
}

// The server's own addresses on your network, so Photon can pick the one Plex can reach.
function serverLanAddresses(c) {
  const srv = cache.servers.find(x => x.id === c.serverId) || (cache.servers.length === 1 ? cache.servers[0] : null);
  const out = (srv?.connections || []).filter(x => x.local && x.address).map(x => x.address);
  if (c.serverUrl) { try { out.unshift(new URL(c.serverUrl).hostname); } catch { /* ignore */ } }
  return out;
}

module.exports = {
  id: 'plex',
  label: 'Plex',
  blurb: 'Sign in with your Plex account so Photon knows your server and who is in your Plex Home. Photon watches what is playing on your server, including anything cast from a phone. A Plex webhook (needs Plex Pass) makes it react a little faster. No Plex Media Server of your own, just a free Plex account? Then there\'s no server for Photon to watch: turn on your TV under TVs and players and use it as the room\'s player instead.',
  fields: [
    { key: 'homeOnly', label: 'Only react to people in my Plex Home', type: 'checkbox', default: true },
    { key: 'poll', label: 'Watch playback on my server (catches casting, no Plex Pass needed)', type: 'checkbox', default: true },
    { key: 'autoWebhook', label: 'Add Photon\'s webhook to my Plex account and keep it up to date (needs Plex Pass)', type: 'checkbox', default: true },
    { key: 'serverUrl', label: 'Server address (only if Photon can\'t reach it on its own)', placeholder: 'http://192.168.1.10:32400' },
  ],
  webhookHelp: 'Photon adds this address to your Plex account for you while you\'re signed in, and updates it if it changes. To add it by hand instead: in Plex Web open Settings, then under your account choose Webhooks > Add Webhook.',
  signIn: true,

  configured: () => true,

  async start(c, tracker, onSeen, log) {
    this.stop();
    if (!c.token) return;
    await info(c).catch(() => {});
    if (c.poll === false || !tracker) return;
    const every = 2500;
    const tick = async () => {
      try {
        const res = await pms(c, '/status/sessions');
        const active = new Set();
        for (const m of res?.MediaContainer?.Metadata || []) {
          const { info: i, state, stopped, userRef } = sessionInfo(m);
          if (!i.playerId || stopped) continue;
          if (c.homeOnly !== false && cache.homeUsers.length && !isHomeUser(userRef)) continue;
          active.add(i.playerId);
          if (i.local) onSeen(i);
          tracker.observe(i, 'progress', state);
        }
        tracker.sweep('plex', active, every * 3);
        if (lastPollError) { log('ok', 'Reconnected to your Plex server'); lastPollError = null; }
      } catch (err) {
        if (lastPollError !== err.message) log('error', `Can't read playback from your Plex server: ${err.message}. If this keeps happening, type the server address under Connections > Plex.`);
        lastPollError = err.message;
      }
    };
    tick();
    pollTimer = setInterval(tick, every);
  },

  stop() { clearInterval(pollTimer); pollTimer = null; },

  info,
  syncWebhook,
  listWebhooks,
  serverLanAddresses,

  // Step 1 of sign-in: ask plex.tv for a PIN and the page where the person approves it.
  async createPin(c) {
    const pin = await http('POST', `${PLEX_TV}/api/v2/pins?strong=true`, { headers: headers(c, '') });
    const q = new URLSearchParams({ clientID: c.clientId, code: pin.code, 'context[device][product]': PRODUCT });
    return { id: pin.id, code: pin.code, url: `https://app.plex.tv/auth#?${q}` };
  },

  // Step 2: check whether the person approved it. Returns the token once they have.
  async checkPin(c, id) {
    const pin = await http('GET', `${PLEX_TV}/api/v2/pins/${encodeURIComponent(id)}`, { headers: headers(c, '') });
    if (pin.expiresIn != null && pin.expiresIn <= 0 && !pin.authToken) throw new Error('The sign-in code expired. Start again.');
    return pin.authToken || null;
  },

  parseWebhook(req, tracker, c = {}) {
    let p;
    try { p = JSON.parse(req.body?.payload || '{}'); } catch { throw new Error('payload is not JSON'); }

    // One server, one household: drop anything from another server or outside the Plex Home.
    if (c.serverId && p.Server?.uuid && p.Server.uuid !== c.serverId) return { ignored: true, raw: p.event };
    if (c.homeOnly !== false && cache.homeUsers.length && !isHomeUser(p.Account)) return { ignored: true, raw: p.event };

    const pl = p.Player || {};
    const info = {
      source: 'plex',
      playerId: pl.uuid,
      playerName: pl.title || pl.uuid,
      product: '',
      user: p.Account?.title || '',
      mediaType: mediaType(p.Metadata?.type),
      title: title(p.Metadata),
      local: pl.local === true || isPrivateIp(pl.publicAddress) === true,
    };
    const kind = KINDS[p.event];
    if (kind && pl.uuid) tracker.observe(info, kind);
    // Only players on this network go into the player list.
    return { seen: pl.uuid && info.local ? info : null, raw: p.event };
  },

  // Players on this network: ones Plex lists for your account at this address, plus
  // ones your server can see on the local network right now.
  async listPlayers(c) {
    if (!c.token) return [];
    const fromAccount = (await info(c)).players || [];
    let nearby = [];
    try {
      const res = await pms(c, '/clients');
      nearby = (res?.MediaContainer?.Server || []).map(x => ({ id: x.machineIdentifier, name: x.name, product: [x.product, x.deviceClass].filter(Boolean).join(', '), local: true }));
    } catch { /* server not reachable right now */ }
    const byId = new Map([...fromAccount, ...nearby].map(x => [x.id, x]));
    return [...byId.values()];
  },

  newClientId: () => crypto.randomUUID(),
};
