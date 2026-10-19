'use strict';

// The rule engine: takes normalized playback events from any media server and
// drives the lights assigned to the matching room, on any lighting system.
//
// Event shape: { source, event, playerId, playerName, product, user, mediaType, title }

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const lighting = require('./lighting');
const schedule = require('./schedule');
const { hexToRgb } = require('./util');

const roomState = new Map();   // roomId -> { snapshot, stopTimer, status, title, player }
const seenPlayers = new Map(); // "source:playerId" -> info, kept in data/players.json
const PLAYERS_PATH = path.join(path.dirname(cfg.CONFIG_PATH), 'players.json');
try {
  // Older versions kept every player that ever played, from any network. Keep only ones
  // known to be on this network; the rest come back if they play here.
  for (const p of JSON.parse(fs.readFileSync(PLAYERS_PATH, 'utf8'))) if (p.local === true) seenPlayers.set(p.key, p);
} catch { /* first run */ }
let playersTimer = null;
function savePlayers() {
  clearTimeout(playersTimer);
  playersTimer = setTimeout(() => {
    try { fs.writeFileSync(PLAYERS_PATH, JSON.stringify([...seenPlayers.values()], null, 2)); } catch (err) { console.error(`Could not save players: ${err.message}`); }
  }, 2000);
}
const log = [];

function addLog(level, msg, extra = {}) {
  log.unshift({ time: new Date().toISOString(), level, msg, ...extra });
  if (log.length > 400) log.length = 400;
  (level === 'error' ? console.error : console.log)(`[${level}] ${msg}`);
}

function stateFor(id) {
  if (!roomState.has(id)) roomState.set(id, { snapshot: null, stopTimer: null, status: 'idle', title: '', player: '', active: new Set() });
  return roomState.get(id);
}

function provider(pid) {
  const p = lighting.byId[pid];
  if (!p) throw new Error(`unknown lighting system "${pid}"`);
  const c = cfg.get().lighting[pid] || {};
  if (!c.enabled) throw new Error(`${p.label} is turned off in Connections`);
  if (!p.configured(c)) throw new Error(`${p.label} is not set up yet`);
  return { p, c };
}

// Run fn for every target. Different lighting systems run in parallel; targets
// on the same system run one after another so bridges aren't flooded.
async function eachTarget(keys, fn) {
  const byProvider = new Map();
  for (const key of keys) {
    const [pid, tid] = lighting.splitKey(key);
    if (!byProvider.has(pid)) byProvider.set(pid, []);
    byProvider.get(pid).push([key, tid]);
  }
  const errors = [];
  let ok = 0;
  await Promise.all([...byProvider].map(async ([pid, list]) => {
    let prov;
    try { prov = provider(pid); } catch (err) { errors.push(err.message); return; }
    for (const [key, tid] of list) {
      try { await fn(prov, tid, key); ok++; } catch (err) { errors.push(`${prov.p.label} ${tid}: ${err.message}`); }
    }
  }));
  return { ok, errors };
}

// A vivid random color, or a random pick from the behavior's palette.
// Avoids repeating the previous pick so a new color is always visible.
let lastRandom = null;
function randomColor(palette = []) {
  if (palette.length) {
    const choices = palette.length > 1 ? palette.filter(c => c !== lastRandom) : palette;
    lastRandom = choices[Math.floor(Math.random() * choices.length)];
    return hexToRgb(lastRandom);
  }
  const h = Math.random() * 360;
  const s = 0.8 + Math.random() * 0.2;
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}

function lightState(action) {
  const s = { on: action.type !== 'off', transition: Math.max(0, Number(action.transition) || 0) };
  if (!s.on) return s;
  s.brightness = Math.min(100, Math.max(1, Number(action.brightness) || 1));
  if (action.colorMode === 'temp') s.kelvin = Number(action.kelvin) || 2700;
  if (action.colorMode === 'color') s.rgb = hexToRgb(action.color) || undefined;
  if (action.colorMode === 'random') s.rgb = randomColor(action.palette);
  return s;
}

const hex = rgb => `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`;

async function takeSnapshot(room) {
  const snap = {};
  const { errors } = await eachTarget(room.targets, async ({ p, c }, tid, key) => { snap[key] = await p.snapshot(c, tid); });
  for (const e of errors) addLog('error', `${room.name}: could not save light state (${e})`, { room: room.name });
  return snap;
}

async function applyAction(room, action, snapshot) {
  const transition = Math.max(0, Number(action.transition) || 0);
  switch (action.type) {
    case 'none':
      return { summary: 'left the lights alone', ok: 0, errors: [] };

    case 'scene': {
      if (!action.scene) throw new Error('no scene selected');
      const [pid, sid] = lighting.splitKey(action.scene);
      const { p, c } = provider(pid);
      if (!p.scene) throw new Error(`${p.label} does not support scenes`);
      await p.scene(c, sid, transition);
      return { summary: `activated scene`, ok: 1, errors: [] };
    }

    case 'restore': {
      const keys = Object.keys(snapshot || {});
      if (!keys.length) return { summary: 'nothing to restore (no saved state)', ok: 0, errors: [] };
      const r = await eachTarget(keys, ({ p, c }, tid, key) => p.restore(c, tid, snapshot[key], transition));
      return { summary: `restored ${r.ok} light(s) to how they were`, ...r };
    }

    case 'off':
    case 'state': {
      const s = lightState(action);
      const each = action.colorMode === 'random' && action.randomEach;
      const r = await eachTarget(room.targets, async ({ p, c }, tid) => {
        if (!each) return p.apply(c, tid, s);
        // Own color per light: split groups into their lights when the system allows it.
        const ids = p.members ? await p.members(c, tid).catch(() => [tid]) : [tid];
        for (const id of ids) await p.apply(c, id, lightState(action));
      });
      const color = action.colorMode === 'random' ? (each ? ' random colors' : ` random color ${hex(s.rgb)}`) : s.rgb ? ` ${action.color}` : '';
      const what = !s.on ? 'off' : `${s.brightness}%${s.kelvin ? ` ${s.kelvin}K` : ''}${color}`;
      return { summary: `set ${r.ok} light(s) ${what}`, ...r };
    }

    default:
      throw new Error(`unknown action "${action.type}"`);
  }
}

function pickRule(room, event, now = new Date()) {
  const loc = cfg.get().location;
  return room.rules.find(r => r.enabled && r.events.includes(event) && schedule.isActive(r.schedule, now, loc));
}

async function runRule(room, event, ev) {
  const st = stateFor(room.id);
  const rule = pickRule(room, event);
  if (!rule) {
    addLog('info', `${room.name}: ${event}, no behavior matches right now`, { room: room.name, event });
    return;
  }
  try {
    const r = await applyAction(room, rule.action, st.snapshot);
    const level = r.errors.length ? (r.ok ? 'warn' : 'error') : 'ok';
    addLog(level, `${room.name}: ${event} → "${rule.name}": ${r.summary}${r.errors.length ? `. Problems: ${r.errors.join('; ')}` : ''}`,
      { room: room.name, event, rule: rule.name, title: ev?.title });
  } catch (err) {
    addLog('error', `${room.name}: ${event} → "${rule.name}" failed: ${err.message}`, { room: room.name, event, rule: rule.name });
  }
}

// A player matches a room by its ID or, failing that, by name. Cast receivers (a TV
// you cast to from your phone) can show up under a different ID than the one listed.
function playerInRoom(r, ev) {
  const key = `${ev.source}:${ev.playerId}`;
  if (r.players.includes(key)) return true;
  const name = String(ev.playerName || '').trim().toLowerCase();
  if (!name) return false;
  return r.players.some(k => k.startsWith(`${ev.source}:`) &&
    String(r.playerNames?.[k] || seenPlayers.get(k)?.name || '').trim().toLowerCase() === name);
}

function roomsFor(ev) {
  return cfg.get().rooms.filter(r =>
    r.enabled && playerInRoom(r, ev) &&
    (!r.users.length || r.users.some(u => u.toLowerCase() === String(ev.user).toLowerCase())) &&
    (!r.mediaTypes.length || r.mediaTypes.includes(ev.mediaType)));
}

function notePlayer(info) {
  if (!info?.playerId) return;
  const key = `${info.source}:${info.playerId}`;
  const prev = seenPlayers.get(key);
  if (info.local === false) return; // only players on this network are listed
  seenPlayers.set(key, { key, source: info.source, id: info.playerId, name: info.playerName, product: info.product || prev?.product || '', user: info.user, local: true, lastSeen: new Date().toISOString() });
  if (!prev || prev.name !== info.playerName || Date.now() - Date.parse(prev.lastSeen) > 3600e3) savePlayers();
}

async function handle(ev) {
  notePlayer(ev);
  const rooms = roomsFor(ev);
  const who = `"${ev.playerName}"${ev.user ? ` (${ev.user})` : ''}`;
  if (!rooms.length) {
    const home = cfg.get().rooms.find(r => r.enabled && playerInRoom(r, ev));
    if (home) {
      const why = home.users.length && !home.users.some(u => u.toLowerCase() === String(ev.user).toLowerCase())
        ? `${home.name} only reacts to ${home.users.join(', ')}`
        : `${home.name} doesn't react to ${ev.mediaType === 'other' ? 'this kind of media' : `${ev.mediaType}s`}`;
      if (ev.event === 'play') addLog('info', `${ev.source} ${ev.event} on ${who}: ignored, ${why}`, { event: ev.event });
      return { rooms: [] };
    }
    addLog('info', `${ev.source} ${ev.event} on ${who}: this player isn't in a room yet`, { event: ev.event, playerKey: `${ev.source}:${ev.playerId}`, playerName: ev.playerName });
    return { rooms: [] };
  }

  await Promise.all(rooms.map(async room => {
    const st = stateFor(room.id);

    const playerKey = `${ev.source}:${ev.playerId}`;
    if (ev.event === 'stop') {
      st.active.delete(playerKey);
      if (st.active.size) {
        addLog('info', `${room.name}: ${who} stopped, but another player in this room is still going, so lights stay`, { room: room.name, event: 'stop' });
        return;
      }
      // Players send stop between episodes, so wait a little before acting on it.
      clearTimeout(st.stopTimer);
      st.status = 'stopping';
      const delay = Math.max(0, Number(room.stopDelaySeconds) || 0);
      addLog('info', `${room.name}: stop on ${who}${delay ? `, waiting ${delay}s in case playback continues` : ''}`, { room: room.name, event: 'stop' });
      st.stopTimer = setTimeout(async () => {
        st.stopTimer = null;
        await runRule(room, 'stop', ev);
        Object.assign(st, { snapshot: null, status: 'idle', title: '', player: '' });
      }, delay * 1000);
      return;
    }

    st.active.add(playerKey);
    const continuing = Boolean(st.stopTimer);
    clearTimeout(st.stopTimer);
    st.stopTimer = null;

    if (ev.event === 'play' && room.snapshotOnPlay && !st.snapshot) st.snapshot = await takeSnapshot(room);
    if (ev.event === 'play' || ev.event === 'resume') Object.assign(st, { status: 'playing', title: ev.title, player: ev.playerName });
    if (ev.event === 'pause') st.status = 'paused';

    if (ev.event === 'play' && continuing) {
      addLog('info', `${room.name}: next item started (${ev.title}), keeping current lighting`, { room: room.name, event: 'play' });
      return;
    }
    await runRule(room, ev.event, ev);
  }));
  return { rooms: rooms.map(r => r.name) };
}

function status() {
  return cfg.get().rooms.map(r => {
    const st = stateFor(r.id);
    return { id: r.id, status: st.status, title: st.title, player: st.player, hasSnapshot: Boolean(st.snapshot) };
  });
}

module.exports = {
  handle, status, applyAction, pickRule, addLog, notePlayer,
  log: () => log,
  seenPlayers: () => [...seenPlayers.values()],
};
