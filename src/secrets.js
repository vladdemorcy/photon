'use strict';

// Keys and tokens Photon keeps for your lights, TVs and media servers stay on the server.
// What the browser gets has each saved one replaced with SAVED, and when the browser sends
// settings back, SAVED means "keep what's saved". So a page (or anything else that manages to
// read Photon's settings) never sees the actual keys.

const SAVED = '__photon_saved__';

// Saved by pairing or sign-in rather than typed into a field.
const EXTRA = {
  lighting: { hue: ['username'], dirigera: ['token'], nanoleaf: ['tokens'], lutron: ['key'] },
  media: { plex: ['token'], androidtv: ['adbKey'], lg: ['keys'], vizio: ['tokens'] },
};

function secretKeys(kind, sys) {
  const fromFields = (sys.fields || []).filter(f => f.secret).map(f => f.key);
  return [...new Set([...fromFields, ...(EXTRA[kind]?.[sys.id] || [])])];
}

const filled = v => v != null && v !== '' && !(typeof v === 'object' && !Object.keys(v).length);

function create(lighting, media) {
  const kinds = { lighting: lighting.providers, media: media.sources };

  // One integration's settings with saved secrets hidden.
  function redactOne(kind, id, conf) {
    const sys = kinds[kind].find(s => s.id === id);
    if (!sys || !conf || typeof conf !== 'object') return conf;
    const out = { ...conf };
    for (const k of secretKeys(kind, sys)) if (filled(out[k])) out[k] = SAVED;
    return out;
  }

  // The whole settings object, as the browser may see it.
  function redact(config) {
    if (!config || typeof config !== 'object') return config;
    const out = { ...config };
    for (const kind of Object.keys(kinds)) {
      if (!out[kind]) continue;
      out[kind] = Object.fromEntries(Object.entries(out[kind]).map(([id, c]) => [id, redactOne(kind, id, c)]));
    }
    return out;
  }

  // Settings from the browser for one integration, with SAVED swapped back for the real values.
  function restoreOne(kind, id, conf, current) {
    if (!conf || typeof conf !== 'object') return conf;
    const out = { ...conf };
    for (const [k, v] of Object.entries(out)) if (v === SAVED) out[k] = current?.[k];
    return out;
  }

  function restore(next, current) {
    const out = { ...next };
    for (const kind of Object.keys(kinds)) {
      if (!out[kind] || typeof out[kind] !== 'object') continue;
      out[kind] = Object.fromEntries(Object.entries(out[kind]).map(([id, c]) => [id, restoreOne(kind, id, c, current?.[kind]?.[id])]));
    }
    return out;
  }

  return { SAVED, redact, redactOne, restore, restoreOne };
}

module.exports = { create, SAVED };
