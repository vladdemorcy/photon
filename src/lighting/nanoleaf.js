'use strict';

// Nanoleaf (Shapes, Canvas, Elements, Lines, Light Panels) via the local OpenAPI.
// Target id is the device host/IP. Effects are offered as scenes ("host|effect name").

const { http, clamp, rgbToHs } = require('../util');

const hostsOf = c => String(c.hosts || '').split(/[\s,]+/).filter(Boolean);
const url = (c, host, path = '') => {
  const token = c.tokens?.[host];
  if (!token) throw new Error(`Nanoleaf at ${host} is not paired yet`);
  return `http://${host}:16021/api/v1/${token}${path}`;
};

module.exports = {
  id: 'nanoleaf',
  label: 'Nanoleaf',
  blurb: 'Local control of Nanoleaf panels. Effects show up as scenes.',
  fields: [{ key: 'hosts', label: 'Device IPs', placeholder: '192.168.1.60, 192.168.1.61' }],
  actions: [{ id: 'pair', label: 'Pair (hold power button 5-7 s first)' }],

  configured: c => hostsOf(c).some(h => c.tokens?.[h]),

  async action(id, c) {
    const tokens = { ...(c.tokens || {}) };
    const paired = [];
    const errors = [];
    for (const host of hostsOf(c)) {
      if (tokens[host]) continue;
      try {
        const res = await http('POST', `http://${host}:16021/api/v1/new`);
        tokens[host] = res.auth_token;
        paired.push(host);
      } catch (err) {
        errors.push(`${host}: ${err.status === 403 ? 'not in pairing mode' : err.message}`);
      }
    }
    if (!paired.length && errors.length) throw new Error(`Pairing failed. ${errors.join('; ')}`);
    return { patch: { tokens }, message: paired.length ? `Paired ${paired.join(', ')}` : 'All devices already paired' };
  },

  async list(c) {
    const targets = [];
    const scenes = [];
    for (const host of hostsOf(c)) {
      if (!c.tokens?.[host]) continue;
      const info = await http('GET', url(c, host));
      targets.push({ id: host, name: info.name || `Nanoleaf ${host}`, type: 'light', shape: /lines/i.test(info.model || info.name || '') ? 'strip' : 'panel', detail: `${info.model || ''} ${host}`.trim(), caps: { dim: true, temp: true, color: true } });
      for (const e of info.effects?.effectsList || []) scenes.push({ id: `${host}|${e}`, name: e, detail: info.name });
    }
    return { targets, scenes };
  },

  async apply(c, id, state) {
    const duration = Math.round(state.transition ?? 0.4);
    if (!state.on) return http('PUT', url(c, id, '/state'), { body: { on: { value: false } } });
    const body = { on: { value: true } };
    if (state.brightness != null) body.brightness = { value: clamp(Math.round(state.brightness), 0, 100), duration };
    if (state.rgb) { const [hue, sat] = rgbToHs(state.rgb); body.hue = { value: hue }; body.sat = { value: sat }; }
    else if (state.kelvin) body.ct = { value: clamp(Math.round(state.kelvin), 1200, 6500) };
    return http('PUT', url(c, id, '/state'), { body });
  },

  async snapshot(c, id) {
    const info = await http('GET', url(c, id));
    return { state: info.state, effect: info.effects?.select };
  },

  async restore(c, id, snap, transition) {
    const s = snap.state || {};
    if (!s.on?.value) return http('PUT', url(c, id, '/state'), { body: { on: { value: false } } });
    if (s.colorMode === 'effect' && snap.effect && !snap.effect.startsWith('*')) {
      await http('PUT', url(c, id, '/effects'), { body: { select: snap.effect } });
      return http('PUT', url(c, id, '/state'), { body: { brightness: { value: s.brightness?.value ?? 100, duration: Math.round(transition) } } });
    }
    const body = { on: { value: true }, brightness: { value: s.brightness?.value ?? 100, duration: Math.round(transition) } };
    if (s.colorMode === 'ct') body.ct = { value: s.ct?.value };
    else { body.hue = { value: s.hue?.value ?? 0 }; body.sat = { value: s.sat?.value ?? 0 }; }
    return http('PUT', url(c, id, '/state'), { body });
  },

  async scene(c, sceneId) {
    const [host, ...rest] = sceneId.split('|');
    return http('PUT', url(c, host, '/effects'), { body: { select: rest.join('|') } });
  },
};
