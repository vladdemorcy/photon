'use strict';

// Turns "this is what the player looks like now" observations into clean
// play / pause / resume / stop / scrobble events, and drops duplicates.
// Every media server goes through here, so a webhook and the session poller seeing
// the same playback produce one set of events, not two.

const SCROBBLE_AT = 0.9;
const sessions = new Map(); // "source:playerId" -> { status, itemKey, scrobbled, info, seenAt }
const stopped = new Map();  // "source:playerId" -> { itemKey, at }, to ignore stale polls right after a stop
const STALE_AFTER_STOP_MS = 15000;

function create(emit) {
  function send(event, info) { emit({ ...info, event }); }

  function observe(info, kind, { paused, position, runtime } = {}) {
    const key = `${info.source}:${info.playerId}`;
    const s = sessions.get(key);
    const itemKey = `${info.title}|${info.mediaType}`;

    if (kind === 'stop') {
      stopped.set(key, { itemKey, at: Date.now() });
      if (s) { sessions.delete(key); send('stop', { ...s.info, ...info }); }
      return;
    }
    // A poll can still list a session for a moment after the player stopped.
    const st = stopped.get(key);
    if (!s && kind === 'progress' && st && st.itemKey === itemKey && Date.now() - st.at < STALE_AFTER_STOP_MS) return;
    if (kind === 'scrobble') {
      if (s && !s.scrobbled) { s.scrobbled = true; s.seenAt = Date.now(); send('scrobble', info); }
      return;
    }

    if (!s || s.itemKey !== itemKey) {
      if (s && kind !== 'start') send('stop', s.info); // item changed without a stop
      stopped.delete(key);
      sessions.set(key, { status: 'playing', itemKey, scrobbled: false, info, seenAt: Date.now() });
      send('play', info);
      if (paused === true || kind === 'pause') { sessions.get(key).status = 'paused'; send('pause', info); }
    } else {
      s.info = info;
      s.seenAt = Date.now();
      const wantPaused = kind === 'pause' ? true : kind === 'resume' ? false : paused;
      if (wantPaused === true && s.status !== 'paused') { s.status = 'paused'; send('pause', info); }
      else if (wantPaused === false && s.status === 'paused') { s.status = 'playing'; send('resume', info); }
    }

    const cur = sessions.get(key);
    if (cur && !cur.scrobbled && position > 0 && runtime > 0 && position / runtime >= SCROBBLE_AT) {
      cur.scrobbled = true;
      send('scrobble', info);
    }
  }

  // Report a stop for every tracked player of `source` not in `activeIds`. Sessions
  // seen in the last `graceMs` are kept, since a webhook can beat the server's own list.
  function sweep(source, activeIds, graceMs = 0) {
    for (const [key, s] of sessions) {
      if (s.info.source === source && !activeIds.has(s.info.playerId) && Date.now() - (s.seenAt || 0) > graceMs) {
        sessions.delete(key);
        send('stop', s.info);
      }
    }
  }

  return { observe, sweep };
}

function mediaType(t) {
  const v = String(t || '').toLowerCase();
  if (v === 'movie') return 'movie';
  if (v === 'episode') return 'episode';
  if (['audio', 'track', 'musicvideo', 'audiobook'].includes(v)) return 'music';
  return 'other';
}

const truthy = v => v === true || String(v).toLowerCase() === 'true';
const num = v => (v === '' || v == null ? 0 : Number(v) || 0);

module.exports = { create, mediaType, truthy, num };
