'use strict';

// Lutron Caseta (and RadioRA 3) through the Smart Bridge's local LEAP interface: newline-separated
// JSON over TLS on port 8081, using a client certificate the bridge signs during pairing (port 8083,
// after the small button on the back of the bridge is pressed).
// Targets: "a<area id>" for a room from the Lutron app, "z<zone id>" for a dimmer or switch.
// Caseta has no color, so only on/off, brightness and fades are used.

const tls = require('tls');
const os = require('os');
const forge = require('node-forge');
const { clamp, sleep } = require('../util');
const certs = require('./lutron-certs');

// Tests point these at a stand-in bridge.
const PAIR_PORT = Number(process.env.LUTRON_PAIR_PORT || 8083);
const LEAP_PORT = Number(process.env.LUTRON_LEAP_PORT || 8081);
const extraCa = process.env.LUTRON_EXTRA_CA ? [require('fs').readFileSync(process.env.LUTRON_EXTRA_CA, 'utf8')] : [];

const DIMMERS = new Set(['WallDimmer', 'PlugInDimmer', 'InLineDimmer', 'SunnataDimmer', 'TempInWallPaddleDimmer',
  'WallDimmerWithPreset', 'Dimmed', 'DivaSmartDimmer', 'PowPak0-10V', 'SpectrumTune', 'WhiteTune', 'ColorTune']);
const SWITCHES = new Set(['WallSwitch', 'OutdoorPlugInSwitch', 'PlugInSwitch', 'InLineSwitch', 'PowPakSwitch',
  'SunnataSwitch', 'TempInWallPaddleSwitch', 'Switched', 'DivaSmartSwitch']);
const PLUGS = new Set(['PlugInDimmer', 'PlugInSwitch', 'OutdoorPlugInSwitch']);

const hostOf = c => String(c.bridgeIp || '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
const idOf = href => String(href || '').split('/').pop();
const tlsBase = { minVersion: 'TLSv1.2', checkServerIdentity: () => undefined, ciphers: 'DEFAULT:@SECLEVEL=0' };

function friendlyNetError(err, host) {
  const code = err.code;
  if (code === 'ECONNREFUSED') return `the Lutron bridge at ${host} refused the connection`;
  if (code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' || code === 'ENETUNREACH') return `can't reach the Lutron bridge at ${host}`;
  if (/certificate|SSL|alert|handshake/i.test(err.message) || code === 'EPROTO') return `the Lutron bridge at ${host} didn't accept Photon's certificate. Pair again.`;
  return err.message;
}

// Reads newline-separated JSON messages from a socket.
function onMessages(sock, fn) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { fn(JSON.parse(line)); } catch { /* not JSON, skip */ }
    }
  });
}

// ---- One kept-open LEAP connection per bridge ------------------------------------
const conns = new Map(); // key -> { sock, pending, ready }
let tagSeq = 0;

function connection(c) {
  const host = hostOf(c);
  const key = `${host}|${String(c.cert || '').slice(-60)}`;
  const cur = conns.get(key);
  if (cur && !cur.sock.destroyed) return cur.ready;
  const state = { pending: new Map() };
  state.ready = new Promise((resolve, reject) => {
    const sock = tls.connect({
      ...tlsBase, host, port: LEAP_PORT, servername: '',
      key: c.key, cert: c.cert, ca: [c.ca, certs.LUTRON_ROOT_CA, ...extraCa].filter(Boolean),
    });
    state.sock = sock;
    sock.setTimeout(8000, () => sock.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    sock.once('secureConnect', () => { sock.setTimeout(0); sock.setKeepAlive(true, 30000); resolve(state); });
    sock.on('error', err => {
      const e = new Error(`Lutron: ${friendlyNetError(err, host)}`);
      reject(e);
      for (const p of state.pending.values()) p.reject(e);
      state.pending.clear();
    });
    sock.on('close', () => {
      conns.delete(key);
      for (const p of state.pending.values()) p.reject(new Error('Lutron: the bridge closed the connection. If this keeps happening, pair again.'));
      state.pending.clear();
    });
    onMessages(sock, msg => {
      const tag = msg.Header?.ClientTag;
      const p = tag && state.pending.get(tag);
      if (!p) return; // status updates the bridge sends on its own
      state.pending.delete(tag);
      clearTimeout(p.timer);
      const status = String(msg.Header?.StatusCode || '');
      if (/^[45]/.test(status)) p.reject(new Error(`Lutron: ${status}${msg.Body?.Message ? ` (${msg.Body.Message})` : ''}`));
      else p.resolve(msg.Body || {});
    });
  });
  state.ready.catch(() => conns.delete(key));
  conns.set(key, state);
  return state.ready;
}

async function leap(c, type, url, body) {
  const state = await connection(c);
  const tag = `photon-${++tagSeq}`;
  const msg = { CommuniqueType: type, Header: { ClientTag: tag, Url: url } };
  if (body) msg.Body = body;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.pending.delete(tag); reject(new Error(`Lutron: no answer for ${url}`)); }, 6000);
    state.pending.set(tag, { resolve, reject, timer });
    state.sock.write(`${JSON.stringify(msg)}\r\n`);
  });
}

// ---- What's on the bridge, cached briefly so a room change doesn't reload it per light ----
let cache = { at: 0, key: '', data: null };
async function inventory(c, fresh = false) {
  const key = `${hostOf(c)}|${String(c.cert || '').slice(-40)}`;
  if (!fresh && cache.data && cache.key === key && Date.now() - cache.at < 60000) return cache.data;
  const [areas, devices] = await Promise.all([leap(c, 'ReadRequest', '/area'), leap(c, 'ReadRequest', '/device')]);
  const zones = new Map(); // zone id -> { id, name, type, area, dim }
  for (const d of devices.Devices || []) {
    const zoneHref = d.LocalZones?.[0]?.href;
    if (!zoneHref || !(DIMMERS.has(d.DeviceType) || SWITCHES.has(d.DeviceType))) continue;
    const name = Array.isArray(d.FullyQualifiedName) ? d.FullyQualifiedName.slice(-1)[0] : d.Name;
    zones.set(idOf(zoneHref), {
      id: idOf(zoneHref), name: name || d.Name || 'Lutron light', type: d.DeviceType, model: d.ModelNumber || '',
      area: idOf(d.AssociatedArea?.href), dim: DIMMERS.has(d.DeviceType), plug: PLUGS.has(d.DeviceType),
    });
  }
  const areaList = (areas.Areas || []).map(a => ({ id: idOf(a.href), name: a.Name, members: [...zones.values()].filter(z => z.area === idOf(a.href)).map(z => `z${z.id}`) }))
    .filter(a => a.members.length);
  const data = { zones, areas: areaList };
  cache = { at: Date.now(), key, data };
  return data;
}

async function zoneIds(c, id) {
  if (id.startsWith('z')) return [id.slice(1)];
  const inv = await inventory(c);
  return inv.areas.find(a => `a${a.id}` === id)?.members.map(m => m.slice(1)) || [];
}

const fade = s => { const t = Math.max(0, Math.round(s)); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

function setLevel(c, zone, level, transition) {
  const url = `/zone/${zone.id}/commandprocessor`;
  if (zone.dim && transition >= 1) {
    return leap(c, 'CreateRequest', url, { Command: { CommandType: 'GoToDimmedLevel', DimmedLevelParameters: { Level: level, FadeTime: fade(transition) } } });
  }
  return leap(c, 'CreateRequest', url, { Command: { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: zone.dim ? level : (level > 0 ? 100 : 0) }] } });
}

const levelOf = async (c, zoneId) => Number((await leap(c, 'ReadRequest', `/zone/${zoneId}/status`)).ZoneStatus?.Level ?? 0);

module.exports = {
  id: 'lutron',
  label: 'Lutron Caseta',
  blurb: 'Talks to your Lutron Caseta Smart Bridge (or RadioRA 3) on your network. Rooms from the Lutron app show up as groups. Caseta dims and switches but has no color, so color settings are skipped for these lights.',
  fields: [
    { key: 'bridgeIp', label: 'Smart Bridge IP address', placeholder: '192.168.1.40 (Lutron app > Settings > Advanced > Integration)' },
  ],
  actions: [
    { id: 'pair', label: 'Pair (click, then press the small button on the back of the bridge)' },
  ],

  configured: c => Boolean(hostOf(c) && c.cert && c.key),

  async action(id, c) {
    if (id !== 'pair') throw new Error(`unknown action ${id}`);
    const host = hostOf(c);
    if (!host) throw new Error("Enter the bridge's IP first. It's in the Lutron app, or in your router's list of devices.");

    // A key and a certificate request for Photon; the bridge signs it once its button is pressed.
    const pair = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const keys = { privateKey: forge.pki.privateKeyFromPem(pair.privateKey), publicKey: forge.pki.publicKeyFromPem(pair.publicKey) };
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'photon' }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());

    const result = await new Promise((resolve, reject) => {
      const sock = tls.connect({ ...tlsBase, host, port: PAIR_PORT, servername: '', key: certs.LAP_KEY, cert: certs.LAP_CERT, ca: [certs.LAP_CA, certs.LUTRON_ROOT_CA, ...extraCa] });
      const done = (err, val) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
      const timer = setTimeout(() => done(new Error("The bridge button wasn't pressed in time. Click Pair again, then press the small button on the back of the bridge within 3 minutes.")), 180000);
      sock.setTimeout(10000, () => done(new Error(`Lutron: ${friendlyNetError({ code: 'ETIMEDOUT', message: '' }, host)}`)));
      sock.once('secureConnect', () => sock.setTimeout(0));
      sock.on('error', err => done(new Error(`Lutron: ${friendlyNetError(err, host)}`)));
      onMessages(sock, msg => {
        const perms = msg.Body?.Status?.Permissions || [];
        if (String(msg.Header?.ContentType || '').startsWith('status;') && perms.includes('PhysicalAccess')) {
          sock.write(`${JSON.stringify({
            Header: { RequestType: 'Execute', Url: '/pair', ClientTag: 'get-cert' },
            Body: { CommandType: 'CSR', Parameters: { CSR: forge.pki.certificationRequestToPem(csr), DisplayName: `Photon on ${os.hostname()}`, DeviceUID: '000000000000', Role: 'Admin' } },
          })}\r\n`);
        } else if (msg.Header?.ClientTag === 'get-cert') {
          const r = msg.Body?.SigningResult;
          if (r?.Certificate) done(null, r);
          else done(new Error(`Lutron: the bridge didn't sign Photon's certificate (${msg.Header?.StatusCode || 'no reason given'})`));
        }
      });
    });

    const paired = { cert: result.Certificate, key: pair.privateKey, ca: result.RootCertificate || '' };
    // Check the new certificate works before saving it.
    await leap({ ...c, ...paired }, 'ReadRequest', '/server/1/status/ping').catch(async () => {
      await sleep(1000);
      return leap({ ...c, ...paired }, 'ReadRequest', '/server/1/status/ping');
    });
    return { patch: paired, message: 'Paired with the Lutron bridge' };
  },

  async list(c) {
    const inv = await inventory(c, true);
    const scenes = await leap(c, 'ReadRequest', '/virtualbutton').catch(() => ({}));
    const targets = inv.areas.map(a => ({
      id: `a${a.id}`, name: a.name, type: 'room', detail: `${a.members.length} light${a.members.length === 1 ? '' : 's'}`,
      members: a.members, caps: { dim: true, temp: false, color: false },
    }));
    for (const z of inv.zones.values()) {
      targets.push({
        id: `z${z.id}`, name: z.name, type: z.plug && !z.dim ? 'plug' : 'light',
        detail: z.dim ? (z.plug ? 'Plug-in lamp dimmer' : 'Dimmer') : (z.plug ? 'Plug-in switch' : 'Switch'),
        shape: z.plug ? 'lamp' : 'bulb', caps: { dim: z.dim, temp: false, color: false },
      });
    }
    const sceneList = (scenes.VirtualButtons || []).filter(s => s.IsProgrammed && s.Name).map(s => ({ id: idOf(s.href), name: s.Name }));
    return { targets, scenes: sceneList };
  },

  async apply(c, id, state) {
    const inv = await inventory(c);
    const ids = await zoneIds(c, id);
    if (!ids.length) throw new Error('Lutron: that light or room was not found. It may have been removed in the Lutron app.');
    const t = state.transition ?? 0.4;
    await Promise.all(ids.map(async zid => {
      const z = inv.zones.get(zid) || { id: zid, dim: true };
      if (!state.on) return setLevel(c, z, 0, t);
      let level = state.brightness;
      if (level == null) { // a color-only behavior: just make sure it's on
        if (await levelOf(c, zid) > 0) return;
        level = 100;
      }
      return setLevel(c, z, clamp(Math.round(level), 1, 100), t);
    }));
  },

  members: (c, id) => zoneIds(c, id).then(ids => ids.map(z => `z${z}`)),

  async snapshot(c, id) {
    const out = {};
    for (const zid of await zoneIds(c, id)) out[zid] = await levelOf(c, zid);
    return out;
  },

  async restore(c, id, snap, transition) {
    const inv = await inventory(c);
    await Promise.all(Object.entries(snap || {}).map(([zid, level]) =>
      setLevel(c, inv.zones.get(zid) || { id: zid, dim: true }, clamp(Math.round(level), 0, 100), transition ?? 0.4)));
  },

  async scene(c, sceneId) {
    return leap(c, 'CreateRequest', `/virtualbutton/${sceneId}/commandprocessor`, { Command: { CommandType: 'PressAndRelease' } });
  },
};
