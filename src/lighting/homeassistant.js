'use strict';

// Home Assistant. Covers anything HA can control: Zigbee/Z-Wave bulbs, TP-Link Kasa,
// Lutron, Sengled, Yeelight, smart plugs with lamps, and more. Targets are entity ids.

const { http, clamp, guessShape } = require('../util');

// HA areas become room groups. The template API is the only REST way to read them.
const AREA_TEMPLATE = `{% set ns = namespace(out=[]) %}{% for a in areas() %}{% set ents = (area_entities(a) + (area_devices(a) | map('device_entities') | sum(start=[]))) | unique | select('match', '(light|switch)\\.') | list %}{% if ents %}{% set ns.out = ns.out + [{'id': a, 'name': area_name(a), 'entities': ents}] %}{% endif %}{% endfor %}{{ ns.out | tojson }}`;
const areaMembers = new Map(); // "area:<id>" -> [entity ids]

async function areas(c) {
  try {
    const text = await http('POST', `${base(c)}/api/template`, { body: { template: AREA_TEMPLATE }, headers: h(c), raw: true });
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch { return []; } // older HA or no areas: fall back to a flat list
}

async function membersOf(c, id) {
  if (!areaMembers.has(id)) await module.exports.list(c);
  return areaMembers.get(id) || [];
}

const h = c => ({ Authorization: `Bearer ${c.token}` });
const base = c => String(c.url || '').replace(/\/+$/, '');

function service(c, domain, svc, body) {
  return http('POST', `${base(c)}/api/services/${domain}/${svc}`, { body, headers: h(c) });
}

module.exports = {
  id: 'homeassistant',
  label: 'Home Assistant',
  blurb: 'Use any light, light group, smart plug or scene from your Home Assistant.',
  fields: [
    { key: 'url', label: 'Home Assistant URL', placeholder: 'http://homeassistant.local:8123' },
    { key: 'token', label: 'Long-lived access token', placeholder: 'HA profile > Security > Long-lived access tokens', secret: true },
  ],

  configured: c => Boolean(c.url && c.token),

  async list(c) {
    const [states, areaList] = await Promise.all([http('GET', `${base(c)}/api/states`, { headers: h(c) }), areas(c)]);
    const targets = [];
    const scenes = [];
    for (const a of areaList) {
      const id = `area:${a.id}`;
      areaMembers.set(id, a.entities);
      targets.push({ id, name: a.name, type: 'room', detail: `${a.entities.length} lights`, members: a.entities, caps: { dim: true, temp: true, color: true } });
    }
    for (const s of states) {
      const [domain] = s.entity_id.split('.');
      const name = s.attributes?.friendly_name || s.entity_id;
      if (domain === 'light') {
        const modes = s.attributes?.supported_color_modes || [];
        const isGroup = Array.isArray(s.attributes?.entity_id);
        targets.push({
          id: s.entity_id, name, type: isGroup ? 'zone' : 'light', detail: s.entity_id, reachable: s.state !== 'unavailable',
          ...(isGroup ? { members: s.attributes.entity_id } : { shape: guessShape(`${name} ${s.entity_id}`) }),
          caps: {
            dim: !modes.includes('onoff') || modes.length > 1,
            temp: modes.includes('color_temp'),
            color: modes.some(m => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m)),
          },
        });
      } else if (domain === 'switch') {
        targets.push({ id: s.entity_id, name, type: 'plug', detail: s.entity_id, reachable: s.state !== 'unavailable', caps: { dim: false, temp: false, color: false } });
      } else if (domain === 'scene') {
        scenes.push({ id: s.entity_id, name, detail: s.entity_id });
      }
    }
    return { targets, scenes };
  },

  async apply(c, id, state) {
    if (id.startsWith('area:')) {
      const members = await membersOf(c, id);
      const lights = members.filter(e => e.startsWith('light.'));
      const switches = members.filter(e => e.startsWith('switch.'));
      if (switches.length) await service(c, 'switch', state.on ? 'turn_on' : 'turn_off', { entity_id: switches });
      if (lights.length) return module.exports.apply(c, lights, state);
      return;
    }
    const [domain] = String(id).split('.');
    if (domain === 'switch') return service(c, 'switch', state.on ? 'turn_on' : 'turn_off', { entity_id: id });
    const transition = state.transition ?? 0.4;
    if (!state.on) return service(c, 'light', 'turn_off', { entity_id: id, transition });
    const body = { entity_id: id, transition };
    if (state.brightness != null) body.brightness_pct = clamp(Math.round(state.brightness), 1, 100);
    if (state.rgb) body.rgb_color = state.rgb;
    else if (state.kelvin) body.color_temp_kelvin = Math.round(state.kelvin);
    return service(c, 'light', 'turn_on', body);
  },

  async members(c, id) {
    if (id.startsWith('area:')) return membersOf(c, id);
    const st = await http('GET', `${base(c)}/api/states/${id}`, { headers: h(c) });
    return Array.isArray(st?.attributes?.entity_id) ? st.attributes.entity_id : [id];
  },

  async snapshot(c, id) {
    if (id.startsWith('area:')) {
      const out = {};
      for (const e of await membersOf(c, id)) out[e] = await http('GET', `${base(c)}/api/states/${e}`, { headers: h(c) });
      return { area: out };
    }
    return http('GET', `${base(c)}/api/states/${id}`, { headers: h(c) });
  },

  async restore(c, id, s, transition) {
    if (s?.area) {
      for (const [e, st] of Object.entries(s.area)) await module.exports.restore(c, e, st, transition);
      return;
    }
    const [domain] = id.split('.');
    const on = s.state === 'on';
    if (domain === 'switch') return service(c, 'switch', on ? 'turn_on' : 'turn_off', { entity_id: id });
    if (!on) return service(c, 'light', 'turn_off', { entity_id: id, transition });
    const a = s.attributes || {};
    const body = { entity_id: id, transition };
    if (a.brightness != null) body.brightness = a.brightness;
    if (a.color_mode === 'color_temp' && a.color_temp_kelvin) body.color_temp_kelvin = a.color_temp_kelvin;
    else if (a.rgb_color && a.color_mode && a.color_mode !== 'brightness' && a.color_mode !== 'onoff') body.rgb_color = a.rgb_color;
    return service(c, 'light', 'turn_on', body);
  },

  async scene(c, sceneId, transition) {
    return service(c, 'scene', 'turn_on', { entity_id: sceneId, transition });
  },
};
