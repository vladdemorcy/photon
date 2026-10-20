'use strict';

// Registry of lighting systems. Every provider exposes the same shape:
//   id, label, blurb, fields[], actions[]?, configured(cfg), start(cfg)?, action(id, cfg)?,
//   list(cfg) -> { targets: [{ id, name, type, detail, caps }], scenes: [{ id, name }] }
//   apply(cfg, targetId, { on, brightness, kelvin, rgb, transition })
//   snapshot(cfg, targetId) -> opaque, restore(cfg, targetId, snapshot, transition)
//   scene?(cfg, sceneId, transition)
// TV sync boxes (targets of type 'sync') also have:
//   syncSet(cfg, targetId, { on, mode, intensity, brightness }), syncState(cfg, targetId) -> { on },
//   syncLights(cfg, targetId, allLightingCfg) -> the light keys the box colors while it syncs
// A target key used in rooms is "<providerId>::<targetId>".

const providers = [
  require('./hue'),
  require('./huesync'),
  require('./govee'),
  require('./lifx'),
  require('./wiz'),
  require('./nanoleaf'),
  require('./dirigera'),
  require('./tuya'),
  require('./wyze'),
  require('./lutron'),
  require('./homeassistant'),
];

const byId = Object.fromEntries(providers.map(p => [p.id, p]));
const SEP = '::';

function splitKey(key) {
  const i = String(key).indexOf(SEP);
  if (i < 0) throw new Error(`bad target key "${key}"`);
  return [key.slice(0, i), key.slice(i + SEP.length)];
}

const makeKey = (providerId, id) => `${providerId}${SEP}${id}`;

module.exports = { providers, byId, splitKey, makeKey };
