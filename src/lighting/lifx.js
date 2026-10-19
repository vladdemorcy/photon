'use strict';

// LIFX via the LIFX HTTP API. Targets: "id:<light id>" or "group_id:<group id>".

const { http, rgbToHex, clamp, guessShape } = require('../util');

const API = 'https://api.lifx.com/v1';
const h = c => ({ Authorization: `Bearer ${c.token}` });

function colorString(state) {
  if (state.rgb) return rgbToHex(state.rgb);
  if (state.kelvin) return `kelvin:${clamp(Math.round(state.kelvin), 1500, 9000)}`;
  return undefined;
}

module.exports = {
  id: 'lifx',
  label: 'LIFX',
  blurb: 'Uses the LIFX cloud API with a personal access token.',
  fields: [{ key: 'token', label: 'Personal access token', placeholder: 'cloud.lifx.com > Settings > Personal access tokens', secret: true }],

  configured: c => Boolean(c.token),

  async list(c) {
    const [lights, scenes] = await Promise.all([
      http('GET', `${API}/lights/all`, { headers: h(c) }),
      http('GET', `${API}/scenes`, { headers: h(c) }).catch(() => []),
    ]);
    const groups = new Map();
    const targets = lights.map(l => {
      if (l.group?.id) {
        const g = groups.get(l.group.id) || { name: l.group.name, members: [] };
        g.members.push(`id:${l.id}`);
        groups.set(l.group.id, g);
      }
      const caps = l.product?.capabilities || {};
      return {
        id: `id:${l.id}`, name: l.label, type: 'light', detail: l.product?.name || 'LIFX', reachable: l.connected,
        shape: caps.has_multizone ? 'strip' : caps.has_matrix ? 'panel' : guessShape(l.product?.name),
        caps: { dim: true, temp: caps.has_variable_color_temp !== false, color: Boolean(caps.has_color) },
      };
    });
    for (const [gid, g] of groups) targets.unshift({ id: `group_id:${gid}`, name: g.name, type: 'room', detail: `${g.members.length} lights`, members: g.members, caps: { dim: true, temp: true, color: true } });
    return { targets, scenes: scenes.map(s => ({ id: s.uuid, name: s.name })) };
  },

  async apply(c, id, state) {
    const body = { power: state.on ? 'on' : 'off', duration: state.transition ?? 0.4 };
    if (state.on && state.brightness != null) body.brightness = clamp(state.brightness / 100, 0.01, 1);
    const color = state.on ? colorString(state) : undefined;
    if (color) body.color = color;
    return http('PUT', `${API}/lights/${encodeURIComponent(id)}/state`, { body, headers: h(c) });
  },

  async members(c, id) {
    if (!id.startsWith('group_id:')) return [id];
    const lights = await http('GET', `${API}/lights/${encodeURIComponent(id)}`, { headers: h(c) });
    return lights.map(l => `id:${l.id}`);
  },

  async snapshot(c, id) {
    const lights = await http('GET', `${API}/lights/${encodeURIComponent(id)}`, { headers: h(c) });
    return lights.map(l => ({ id: l.id, power: l.power, brightness: l.brightness, color: l.color }));
  },

  async restore(c, id, snap, transition) {
    const states = snap.map(l => {
      const col = l.color || {};
      const color = col.saturation > 0
        ? `hue:${col.hue} saturation:${col.saturation}`
        : `kelvin:${col.kelvin || 3500}`;
      return { selector: `id:${l.id}`, power: l.power, brightness: l.brightness, color, duration: transition };
    });
    return http('PUT', `${API}/lights/states`, { body: { states }, headers: h(c) });
  },

  async scene(c, sceneId, transition) {
    return http('PUT', `${API}/scenes/scene_id:${sceneId}/activate`, { body: { duration: transition }, headers: h(c) });
  },
};
