'use strict';

// Philips Hue, local bridge API (v1), over HTTPS (see hue-bridge.js).
// Targets: "l<id>" for a light, "g<id>" for a room/zone.

const { http, rgbToXy, clamp, guessShape } = require('../util');
const bridge = require('./hue-bridge');

// path is relative to the app key, like '/lights'.
async function call(c, method, path, body) {
  const data = await bridge.request(c.bridgeIp, method, `/${c.username}${path}`, body);
  if (Array.isArray(data) && data[0]?.error) throw new Error(`Hue: ${data[0].error.description}`);
  return data;
}

function toHue(state) {
  const tt = Math.round((state.transition ?? 0.4) * 10);
  if (!state.on) return { on: false, transitiontime: tt };
  const s = { on: true, transitiontime: tt };
  if (state.brightness != null) s.bri = clamp(Math.round(state.brightness / 100 * 254), 1, 254);
  if (state.kelvin) s.ct = clamp(Math.round(1e6 / state.kelvin), 153, 500);
  if (state.rgb) s.xy = rgbToXy(state.rgb);
  return s;
}

function fromSnapshot(s, transition) {
  const tt = Math.round(transition * 10);
  if (!s.on) return { on: false, transitiontime: tt };
  const out = { on: true, bri: s.bri, transitiontime: tt };
  if (s.colormode === 'ct' && s.ct) out.ct = s.ct;
  else if (s.xy) out.xy = s.xy;
  return out;
}

module.exports = {
  id: 'hue',
  label: 'Philips Hue',
  blurb: 'Talks to your Hue Bridge directly on your network, over an encrypted connection.',
  fields: [
    { key: 'bridgeIp', label: 'Bridge IP address', placeholder: '192.168.1.20' },
    { key: 'username', label: 'App key', placeholder: 'Filled in when you pair', secret: true },
  ],
  actions: [
    { id: 'discover', label: 'Find bridge' },
    { id: 'pair', label: 'Pair (press the bridge button first)' },
  ],

  configured: c => Boolean(c.bridgeIp && c.username),

  async action(id, c) {
    if (id === 'discover') {
      const list = await http('GET', 'https://discovery.meethue.com/');
      if (!list?.length) throw new Error('No bridge found. Enter its IP from the Hue app (Settings > Bridges).');
      return { patch: { bridgeIp: list[0].internalipaddress }, message: `Found bridge at ${list[0].internalipaddress}` };
    }
    if (id === 'pair') {
      if (!c.bridgeIp) throw new Error('Enter the bridge IP first');
      // Pressing the button proves this is the right bridge, so trust its certificate afresh.
      bridge.forget(c.bridgeIp);
      const data = await bridge.request(c.bridgeIp, 'POST', '', { devicetype: 'photon#server' });
      const username = data?.[0]?.success?.username;
      if (!username) throw new Error(data?.[0]?.error?.description || 'Pairing failed. Press the round button on the bridge, then try within 30 seconds.');
      return { patch: { username }, message: 'Paired with the Hue bridge' };
    }
    throw new Error(`unknown action ${id}`);
  },

  async list(c) {
    const [lights, groups, scenes] = await Promise.all([
      call(c, 'GET', `/lights`), call(c, 'GET', `/groups`), call(c, 'GET', `/scenes`),
    ]);
    const targets = [];
    for (const [id, g] of Object.entries(groups)) {
      if (!['Room', 'Zone'].includes(g.type)) continue; // skip Hue's internal and Entertainment groups
      targets.push({
        id: `g${id}`, name: g.name, type: g.type === 'Zone' ? 'zone' : 'room', detail: `${g.lights.length} lights`,
        members: g.lights.map(l => `l${l}`), caps: { dim: true, temp: true, color: true },
      });
    }
    for (const [id, l] of Object.entries(lights)) {
      const product = `${l.productname || ''} ${l.config?.archetype || ''} ${l.name || ''}`;
      targets.push({
        id: `l${id}`, name: l.name, type: 'light', detail: l.productname || l.type,
        shape: guessShape(product),
        reachable: l.state?.reachable !== false,
        caps: { dim: 'bri' in (l.state || {}), temp: 'ct' in (l.state || {}), color: 'xy' in (l.state || {}) },
      });
    }
    const sceneList = Object.entries(scenes).filter(([, s]) => !s.recycle).map(([id, s]) => ({
      id, name: s.name, detail: s.group ? groups[s.group]?.name : 'light scene',
    }));
    return { targets, scenes: sceneList };
  },

  async apply(c, id, state) {
    const body = toHue(state);
    if (id.startsWith('g')) return call(c, 'PUT', `/groups/${id.slice(1)}/action`, body);
    return call(c, 'PUT', `/lights/${id.slice(1)}/state`, body);
  },

  // The individual lights in a room or zone, for giving each its own random color.
  async members(c, id) {
    if (!id.startsWith('g')) return [id];
    return (await call(c, 'GET', `/groups/${id.slice(1)}`)).lights.map(l => `l${l}`);
  },

  async snapshot(c, id) {
    let ids = [id.slice(1)];
    if (id.startsWith('g')) ids = (await call(c, 'GET', `/groups/${id.slice(1)}`)).lights;
    const out = {};
    for (const lid of ids) out[lid] = (await call(c, 'GET', `/lights/${lid}`)).state;
    return out;
  },

  async restore(c, id, snap, transition) {
    for (const [lid, s] of Object.entries(snap)) await call(c, 'PUT', `/lights/${lid}/state`, fromSnapshot(s, transition));
  },

  async scene(c, sceneId, transition) {
    // Group 0 can recall any scene on the bridge.
    return call(c, 'PUT', `/groups/0/action`, { scene: sceneId, transitiontime: Math.round(transition * 10) });
  },
};
