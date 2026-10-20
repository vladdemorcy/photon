'use strict';
// Fake Hue bridge (port 8099) and Home Assistant (port 8123) for testing Photon without hardware.
const express = require('express');
const calls = [];

const hue = express(); hue.use(express.json());
const lights = {
  1: { name: 'TV backlight', productname: 'Hue Play gradient', state: { on: true, bri: 200, colormode: 'ct', ct: 366, xy: [0.45, 0.41], reachable: true } },
  2: { name: 'Floor lamp', productname: 'Hue color lamp', state: { on: true, bri: 254, colormode: 'xy', ct: 300, xy: [0.3, 0.3], reachable: true } },
  3: { name: 'Ceiling', productname: 'Hue white ambiance', state: { on: false, bri: 100, colormode: 'ct', ct: 250, reachable: true } },
  4: { name: 'Behind TV strip', productname: 'Hue lightstrip plus', config: { archetype: 'huelightstrip' }, state: { on: true, bri: 150, colormode: 'xy', xy: [0.2, 0.3], reachable: true } },
  5: { name: 'Garage bulb', productname: 'Hue white lamp', state: { on: false, bri: 254, reachable: true } },
  6: { name: 'Couch lamp', productname: 'Hue Go', state: { on: true, bri: 120, colormode: 'xy', xy: [0.5, 0.4], reachable: true } },
};
const groups = {
  1: { name: 'Living room', type: 'Room', lights: ['1', '2', '4', '6'] },
  2: { name: 'Bedroom', type: 'Room', lights: ['3'] },
  3: { name: 'TV zone', type: 'Zone', lights: ['1', '4'] },
  4: { name: 'Entertainment area', type: 'Entertainment', lights: ['1', '4'] },
};
hue.post('/api', (q, s) => s.json([{ success: { username: 'testkey' } }]));
hue.get('/api/:u/lights', (q, s) => s.json(lights));
hue.get('/api/:u/lights/:id', (q, s) => s.json(lights[q.params.id]));
hue.get('/api/:u/groups', (q, s) => s.json(groups));
hue.get('/api/:u/groups/:id', (q, s) => s.json(groups[q.params.id]));
hue.get('/api/:u/scenes', (q, s) => s.json({ abc: { name: 'Movie time', group: '1' } }));
hue.put('/api/:u/lights/:id/state', (q, s) => { calls.push(['hue-light', q.params.id, q.body]); Object.assign(lights[q.params.id].state, q.body); s.json([{ success: {} }]); });
hue.put('/api/:u/groups/:id/action', (q, s) => {
  calls.push(['hue-group', q.params.id, q.body]);
  for (const l of groups[q.params.id]?.lights || []) Object.assign(lights[l].state, q.body);
  s.json([{ success: {} }]);
});
hue.get('/calls', (q, s) => s.json(calls));
hue.get('/state', (q, s) => s.json(Object.fromEntries(Object.entries(lights).map(([k, v]) => [k, v.state]))));
hue.listen(8099);

const ha = express(); ha.use(express.json());
const st = { 'light.lamp': { entity_id: 'light.lamp', state: 'on', attributes: { friendly_name: 'Kasa lamp', brightness: 180, color_mode: 'color_temp', color_temp_kelvin: 3000, supported_color_modes: ['color_temp'] } } };
ha.use((q, s, n) => q.headers.authorization === 'Bearer hatoken' ? n() : s.status(401).json({ message: 'unauthorized' }));
ha.get('/api/states', (q, s) => s.json([...Object.values(st), { entity_id: 'scene.cinema', state: 'x', attributes: { friendly_name: 'Cinema' } }, { entity_id: 'switch.popcorn', state: 'off', attributes: { friendly_name: 'Popcorn machine' } }]));
ha.post('/api/template', (q, s) => s.type('text/plain').send(JSON.stringify([{ id: 'den', name: 'Den', entities: ['light.lamp', 'switch.popcorn'] }])));
ha.get('/api/states/:id', (q, s) => s.json(st[q.params.id]));
ha.post('/api/services/:d/:svc', (q, s) => { calls.push(['ha', `${q.params.d}.${q.params.svc}`, q.body]); s.json([]); });
ha.listen(8123);

// Fake plex.tv: the sign-in PIN is approved on the second check.
const plex = express();
let checks = 0;
plex.post('/api/v2/pins', (q, s) => { checks = 0; s.json({ id: 4242, code: 'abcd1234', expiresIn: 900 }); });
plex.get('/api/v2/pins/:id', (q, s) => { checks++; s.json({ id: 4242, code: 'abcd1234', expiresIn: 880, authToken: checks >= 2 ? 'plextoken123' : null }); });
const auth = (q, s, n) => q.headers['x-plex-token'] === 'plextoken123' ? n() : s.status(401).json({ error: 'unauthorized' });
plex.get('/api/v2/user', auth, (q, s) => s.json({ id: 1001, username: 'vladimr', title: 'Vladimr', email: 'v@example.com' }));
plex.get('/api/v2/resources', auth, (q, s) => s.json([
  { name: 'Basement NAS', clientIdentifier: 'srv-1', provides: 'server', owned: true, productVersion: '1.41',
    connections: [{ protocol: 'http', address: '127.0.0.1', port: 32400, uri: 'http://127.0.0.1:32400', local: true, relay: false }] },
  { name: 'Living Room Shield', clientIdentifier: 'abc123', provides: 'player,pubsub-player', product: 'Plex for Android (TV)', platform: 'Android', publicAddressMatches: true },
  { name: 'Bedroom Roku', clientIdentifier: 'roku-9', provides: 'player', product: 'Plex for Roku', platform: 'Roku', publicAddressMatches: true },
  { name: "Friend's Fire TV", clientIdentifier: 'far-away-1', provides: 'player', product: 'Plex for Fire TV', platform: 'Android', publicAddressMatches: false },
  { name: 'Old work laptop', clientIdentifier: 'work-2', provides: 'client,player', product: 'Plex Web', platform: 'Chrome', publicAddressMatches: false },
]));
plex.get('/api/home/users', auth, (q, s) => s.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" size="3">
<User id="1001" uuid="a" admin="1" guest="0" restricted="0" title="Vladimr" username="vladimr" email="v@example.com"/>
<User id="1002" uuid="b" admin="0" guest="0" restricted="0" title="Ana" username="ana_k"/>
<User id="1003" uuid="c" admin="0" guest="0" restricted="1" title="Kids" username=""/>
</MediaContainer>`));
let hooks = ['http://192.168.1.50:8123/api/webhook/plex-ha', 'http://192.168.1.60:8787/webhook/plex/oldtoken999'];
plex.get('/api/v2/user/webhooks', auth, (q, s) => s.json(hooks.map(url => ({ url }))));
plex.post('/api/v2/user/webhooks', auth, express.urlencoded({ extended: true }), (q, s) => {
  const u = q.body['urls[]'] ?? q.body.urls ?? [];
  hooks = (Array.isArray(u) ? u : [u]).filter(Boolean);
  calls.push(['plex-webhooks', hooks]);
  s.status(201).json({});
});
plex.get('/mock/webhooks', (q, s) => s.json(hooks));
plex.listen(8124);

// Fake Plex Media Server: /status/sessions is whatever the test sets through /mock/sessions.
const pms = express(); pms.use(express.json());
let sessions = [];
pms.post('/mock/sessions', (q, s) => { sessions = q.body; s.json({ ok: true }); });
pms.get('/status/sessions', auth, (q, s) => s.json({ MediaContainer: { size: sessions.length, Metadata: sessions } }));
pms.get('/clients', auth, (q, s) => s.json({ MediaContainer: { Server: [{ name: 'Kitchen Chromecast', machineIdentifier: 'cc-kitchen', product: 'Plex for Chromecast', deviceClass: 'stb' }] } }));
pms.listen(32400);

// Fake IKEA DIRIGERA hub (https 8443). Run Photon with DIRIGERA_EXTRA_CA=test/fixtures/dirigera-cert.pem.
const https = require('https');
const fs = require('fs');
const path = require('path');
const ikea = express(); ikea.use(express.json()); ikea.use(express.urlencoded({ extended: false }));
let ikeaPolls = 0;
const ikeaDevices = [
  { id: 'bulb-1', type: 'light', deviceType: 'light', isReachable: true, room: { id: 'room-a', name: 'Bedroom' },
    capabilities: { canReceive: ['isOn', 'lightLevel', 'colorTemperature', 'colorHue', 'colorSaturation'] },
    attributes: { customName: 'Bed lamp', model: 'TRADFRI bulb E26 CWS 806lm', isOn: true, lightLevel: 80, colorMode: 'temperature', colorTemperature: 2700, colorTemperatureMin: 4000, colorTemperatureMax: 2202, colorHue: 0, colorSaturation: 0 } },
  { id: 'strip-1', type: 'light', deviceType: 'light', isReachable: true, room: { id: 'room-a', name: 'Bedroom' },
    capabilities: { canReceive: ['isOn', 'lightLevel', 'colorTemperature'] },
    attributes: { customName: 'Shelf', model: 'ORMANAS LED strip', isOn: false, lightLevel: 50, colorMode: 'temperature', colorTemperature: 3000, colorTemperatureMin: 4000, colorTemperatureMax: 2202 } },
  { id: 'plug-1', type: 'outlet', deviceType: 'outlet', isReachable: true, capabilities: { canReceive: ['isOn'] }, attributes: { customName: 'Fairy lights', model: 'TRETAKT smart plug', isOn: false } },
  { id: 'remote-1', type: 'controller', deviceType: 'lightController', isReachable: true, capabilities: { canReceive: [] }, attributes: { customName: 'Remote', model: 'STYRBAR' } },
];
ikea.get('/v1/oauth/authorize', (q, s) => { ikeaPolls = 0; s.json(q.query.code_challenge_method === 'S256' && q.query.code_challenge ? { code: 'ikeacode' } : {}); });
ikea.post('/v1/oauth/token', (q, s) => {
  ikeaPolls++;
  if (q.body.code !== 'ikeacode' || !q.body.code_verifier) return s.status(400).json({ error: 'bad request' });
  if (ikeaPolls < 3) return s.status(403).json({ error: 'Button not pressed or presence time stamp timed out.' });
  s.json({ access_token: 'ikeatoken' });
});
ikea.use('/v1', (q, s, n) => q.headers.authorization === 'Bearer ikeatoken' ? n() : s.status(401).json({ error: 'unauthorized' }));
ikea.get('/v1/devices', (q, s) => s.json(ikeaDevices));
ikea.get('/v1/scenes', (q, s) => s.json([{ id: 'sc-1', info: { name: 'Movie night' }, type: 'userScene' }]));
ikea.post('/v1/scenes/:id/trigger', (q, s) => { calls.push(['ikea-scene', q.params.id]); s.json({}); });
ikea.patch('/v1/devices/:id', (q, s) => {
  const d = ikeaDevices.find(x => x.id === q.params.id);
  if (!d || !Array.isArray(q.body)) return s.status(400).json({ error: 'bad' });
  if (Object.keys(q.body[0].attributes).filter(k => k !== 'colorSaturation').length > 1) return s.status(400).json({ error: 'one attribute at a time' });
  calls.push(['ikea', d.id, q.body[0]]);
  Object.assign(d.attributes, q.body[0].attributes);
  if ('colorHue' in q.body[0].attributes) d.attributes.colorMode = 'color';
  if ('colorTemperature' in q.body[0].attributes) d.attributes.colorMode = 'temperature';
  s.json({});
});
ikea.get('/v1/mock/state', (q, s) => s.json(ikeaDevices.map(d => [d.id, d.attributes])));
https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'fixtures/dirigera-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fixtures/dirigera-cert.pem')),
}, ikea).listen(8443);

// Fake Tuya cloud (http 8125). Checks the request signature the way Tuya does.
const tuya = express(); tuya.use(express.json());
const crypto = require('crypto');
const TUYA_ID = 'tuyaid123', TUYA_SECRET = 'tuyasecret456';
const tuyaDevs = {
  'tl-bulb': { category: 'dj', name: 'Treatlife bulb', product_name: 'Treatlife Smart Bulb A19', online: true,
    functions: [{ code: 'switch_led', type: 'Boolean', values: '{}' }, { code: 'work_mode', type: 'Enum', values: '{"range":["white","colour","scene","music"]}' },
      { code: 'bright_value_v2', type: 'Integer', values: '{"min":10,"max":1000}' }, { code: 'temp_value_v2', type: 'Integer', values: '{"min":0,"max":1000}' },
      { code: 'colour_data_v2', type: 'Json', values: '{"h":{"min":0,"max":360},"s":{"min":0,"max":1000},"v":{"min":0,"max":1000}}' }],
    status: { switch_led: true, work_mode: 'white', bright_value_v2: 800, temp_value_v2: 200, colour_data_v2: '{"h":0,"s":0,"v":0}' } },
  'tl-dimmer': { category: 'tgkg', name: 'Hall dimmer', product_name: 'Treatlife Dimmer Switch', online: true,
    functions: [{ code: 'switch_led_1', type: 'Boolean', values: '{}' }, { code: 'bright_value_1', type: 'Integer', values: '{"min":10,"max":1000}' }],
    status: { switch_led_1: false, bright_value_1: 500 } },
  'tl-plug': { category: 'cz', name: 'Lamp plug', product_name: 'Treatlife Smart Plug', online: false,
    functions: [{ code: 'switch_1', type: 'Boolean', values: '{}' }], status: { switch_1: true } },
  'tl-cam': { category: 'sp', name: 'Door camera', product_name: 'Camera', online: true, functions: [], status: {} },
};
function tuyaCheck(q, tokenNeeded) {
  const body = q.method === 'GET' ? '' : JSON.stringify(q.body);
  const str = [q.method, crypto.createHash('sha256').update(body).digest('hex'), '', q.originalUrl].join('\n');
  const tok = tokenNeeded ? q.headers.access_token || '' : '';
  const want = crypto.createHmac('sha256', TUYA_SECRET).update(TUYA_ID + tok + q.headers.t + str).digest('hex').toUpperCase();
  if (q.headers.client_id !== TUYA_ID) return { success: false, code: 2009, msg: 'clientId is invalid' };
  if (q.headers.sign !== want) return { success: false, code: 1004, msg: 'sign invalid' };
  if (tokenNeeded && tok !== 'tuyatoken') return { success: false, code: 1010, msg: 'token invalid' };
  return null;
}
tuya.get('/v1.0/token', (q, s) => s.json(tuyaCheck(q, false) || { success: true, result: { access_token: 'tuyatoken', expire_time: 7200, uid: 'u1' } }));
tuya.use((q, s, n) => { const e = tuyaCheck(q, true); return e ? s.json(e) : n(); });
tuya.get('/v1.0/iot-01/associated-users/devices', (q, s) => {
  const all = Object.entries(tuyaDevs).map(([id, d]) => ({ id, name: d.name, product_name: d.product_name, category: d.category, online: d.online }));
  const page = q.query.last_row_key ? all.slice(2) : all.slice(0, 2);
  s.json({ success: true, result: { devices: page, has_more: !q.query.last_row_key, last_row_key: q.query.last_row_key ? '' : 'k2' } });
});
tuya.get('/v1.0/iot-03/devices/:id/functions', (q, s) => s.json({ success: true, result: { category: tuyaDevs[q.params.id].category, functions: tuyaDevs[q.params.id].functions } }));
tuya.get('/v1.0/iot-03/devices/:id/status', (q, s) => s.json({ success: true, result: Object.entries(tuyaDevs[q.params.id].status).map(([code, value]) => ({ code, value })) }));
tuya.post('/v1.0/iot-03/devices/:id/commands', (q, s) => {
  const d = tuyaDevs[q.params.id];
  calls.push(['tuya', q.params.id, q.body.commands]);
  for (const c of q.body.commands) d.status[c.code] = typeof c.value === 'object' ? JSON.stringify(c.value) : c.value;
  s.json({ success: true, result: true });
});
tuya.get('/mock/state', (q, s) => s.json(Object.fromEntries(Object.entries(tuyaDevs).map(([k, v]) => [k, v.status]))));
tuya.listen(8125);

// Fake Lutron Caseta Smart Bridge: pairing on 8083, LEAP on 8081.
// Run Photon with LUTRON_EXTRA_CA=test/fixtures/lutron-ca.pem.
{
  const tls = require('tls');
  const forge = require('node-forge');
  const fx = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
  const caPem = fx('lutron-ca.pem'), caKey = forge.pki.privateKeyFromPem(fx('lutron-ca-key.pem')), caCert = forge.pki.certificateFromPem(caPem);
  const send = (sock, obj) => sock.write(JSON.stringify(obj) + '\r\n');
  const lines = (sock, fn) => { let b = ''; sock.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i).trim(); b = b.slice(i + 1); if (l) fn(JSON.parse(l)); } }); };
  tls.createServer({ key: fx('lutron-bridge-key.pem'), cert: fx('lutron-bridge.pem'), requestCert: true, rejectUnauthorized: false }, sock => {
    const peer = sock.getPeerCertificate();
    if (!/Caseta Application/.test(peer?.subject?.CN || '')) { sock.destroy(); return; }
    calls.push(['lutron-pair', 'connected']);
    setTimeout(() => send(sock, { Header: { StatusCode: '200 OK', ContentType: 'status;plurality=single' }, Body: { Status: { Permissions: ['Public', 'PhysicalAccess'] } } }), 1500);
    lines(sock, msg => {
      if (msg.Header?.Url !== '/pair') return;
      const csr = forge.pki.certificationRequestFromPem(msg.Body.Parameters.CSR);
      const cert = forge.pki.createCertificate();
      cert.publicKey = csr.publicKey; cert.serialNumber = '01' + Date.now().toString(16);
      cert.validity.notBefore = new Date(Date.now() - 60000); cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
      cert.setSubject(csr.subject.attributes); cert.setIssuer(caCert.subject.attributes);
      cert.sign(caKey, forge.md.sha256.create());
      send(sock, { Header: { StatusCode: '200 OK', ClientTag: 'get-cert', ContentType: 'signing-result;plurality=single' }, Body: { SigningResult: { Certificate: forge.pki.certificateToPem(cert), RootCertificate: caPem } } });
    });
  }).listen(8083);
  const zones = { 2: { level: 75 }, 3: { level: 0 }, 5: { level: 100 }, 6: { level: 40 } };
  const devices = [
    { href: '/device/1', Name: 'Smart Bridge', DeviceType: 'SmartBridge' },
    { href: '/device/2', Name: 'Ceiling', FullyQualifiedName: ['Family Room', 'Ceiling'], DeviceType: 'WallDimmer', ModelNumber: 'PD-6WCL', LocalZones: [{ href: '/zone/2' }], AssociatedArea: { href: '/area/2' } },
    { href: '/device/3', Name: 'Floor lamp', FullyQualifiedName: ['Family Room', 'Floor lamp'], DeviceType: 'PlugInDimmer', ModelNumber: 'PD-3PCL', LocalZones: [{ href: '/zone/3' }], AssociatedArea: { href: '/area/2' } },
    { href: '/device/5', Name: 'Porch', FullyQualifiedName: ['Outside', 'Porch'], DeviceType: 'WallSwitch', ModelNumber: 'PD-5ANS', LocalZones: [{ href: '/zone/5' }], AssociatedArea: { href: '/area/4' } },
    { href: '/device/6', Name: 'Pendants', FullyQualifiedName: ['Kitchen', 'Pendants'], DeviceType: 'DivaSmartDimmer', ModelNumber: 'DVRF-6L', LocalZones: [{ href: '/zone/6' }], AssociatedArea: { href: '/area/5' } },
    { href: '/device/7', Name: 'Pico', DeviceType: 'Pico3ButtonRaiseLower', AssociatedArea: { href: '/area/2' } },
  ];
  tls.createServer({ key: fx('lutron-bridge-key.pem'), cert: fx('lutron-bridge.pem'), ca: caPem, requestCert: true, rejectUnauthorized: true }, sock => {
    lines(sock, msg => {
      const url = msg.Header?.Url, tag = msg.Header?.ClientTag;
      const ok = Body => send(sock, { CommuniqueType: msg.CommuniqueType.replace('Request', 'Response'), Header: { StatusCode: '200 OK', ClientTag: tag, Url: url }, Body });
      let m;
      if (url === '/server/1/status/ping') ok({ PingResponse: { LEAPVersion: 1.123 } });
      else if (url === '/area') ok({ Areas: [{ href: '/area/1', Name: 'Home' }, { href: '/area/2', Name: 'Family Room', Parent: { href: '/area/1' } }, { href: '/area/4', Name: 'Outside', Parent: { href: '/area/1' } }, { href: '/area/5', Name: 'Kitchen', Parent: { href: '/area/1' } }] });
      else if (url === '/device') ok({ Devices: devices });
      else if (url === '/virtualbutton') ok({ VirtualButtons: [{ href: '/virtualbutton/1', Name: 'Movie', IsProgrammed: true }, { href: '/virtualbutton/2', IsProgrammed: false }] });
      else if ((m = /^\/zone\/(\d+)\/status$/.exec(url))) ok({ ZoneStatus: { href: `/zone/${m[1]}/status`, Level: zones[m[1]]?.level ?? 0, Zone: { href: `/zone/${m[1]}` } } });
      else if ((m = /^\/zone\/(\d+)\/commandprocessor$/.exec(url))) {
        const cmd = msg.Body.Command;
        const level = cmd.CommandType === 'GoToDimmedLevel' ? cmd.DimmedLevelParameters.Level : cmd.Parameter[0].Value;
        if (zones[m[1]]) zones[m[1]].level = level;
        calls.push(['lutron', m[1], cmd.CommandType, level, cmd.DimmedLevelParameters?.FadeTime || null]);
        send(sock, { CommuniqueType: 'CreateResponse', Header: { StatusCode: '201 Created', ClientTag: tag, Url: url }, Body: {} });
      } else if ((m = /^\/virtualbutton\/(\d+)\/commandprocessor$/.exec(url))) { calls.push(['lutron-scene', m[1]]); send(sock, { CommuniqueType: 'CreateResponse', Header: { StatusCode: '201 Created', ClientTag: tag, Url: url }, Body: {} }); }
      else send(sock, { CommuniqueType: 'ExceptionResponse', Header: { StatusCode: '404 Not Found', ClientTag: tag, Url: url } });
    });
  }).listen(8081);
}
// Fake Hue Play HDMI Sync Box (https 8444). Pairing works on the second try, as if the
// button was pressed in between. Its entertainment area is Hue group 4 (lights 1 and 4).
{
  const fx = f => fs.readFileSync(path.join(__dirname, 'fixtures', f));
  let tries = 0;
  const sync = { syncActive: false, mode: 'passthrough', hdmiSource: 'input1', brightness: 100, intensity: 'moderate' };
  const box = express(); box.use(express.json());
  box.post('/api/v1/registrations', (q, s) => (++tries < 2
    ? s.status(400).json({ code: 16, message: 'Invalid State' })
    : s.json({ registrationId: '1', accessToken: 'synctoken' })));
  box.use('/api/v1', (q, s, n) => (q.headers.authorization === 'Bearer synctoken' ? n() : s.status(401).json({ code: 1, message: 'unauthorized' })));
  box.get('/api/v1', (q, s) => s.json({ device: { name: 'Living room sync box' }, hue: { groupId: '4', groups: { 4: { name: 'Entertainment area', numLights: 2 } } }, execution: sync }));
  box.put('/api/v1/execution', (q, s) => { calls.push(['sync-box', q.body]); Object.assign(sync, q.body, q.body.syncActive === false ? { mode: 'passthrough' } : {}); s.json({}); });
  box.get('/sync-state', (q, s) => s.json(sync));
  https.createServer({ key: fx('dirigera-key.pem'), cert: fx('dirigera-cert.pem') }, box).listen(8444);
}

// Fake Govee cloud (http 8126). One sync box with DreamView. Run Photon with
// GOVEE_CLOUD_URL=http://127.0.0.1:8126.
{
  const gv = express(); gv.use(express.json());
  const dv = { on: 0 };
  gv.use((q, s, n) => (q.headers['govee-api-key'] === 'gkey' ? n() : s.status(401).json({ message: 'bad key' })));
  gv.get('/user/devices', (q, s) => s.json({ data: [{ sku: 'H6604', device: 'AA:BB:CC:DD', deviceName: 'TV sync box', type: 'devices.types.light',
    capabilities: [{ instance: 'powerSwitch' }, { instance: 'brightness' }, { instance: 'colorRgb' }, { instance: 'dreamViewToggle' }] }] }));
  gv.post('/device/control', (q, s) => {
    calls.push(['govee', q.body.payload.device, q.body.payload.capability]);
    if (q.body.payload.capability.instance === 'dreamViewToggle') dv.on = q.body.payload.capability.value;
    s.json({ code: 200 });
  });
  gv.post('/device/state', (q, s) => s.json({ payload: { capabilities: [{ instance: 'dreamViewToggle', state: { value: dv.on } }, { instance: 'powerSwitch', state: { value: 1 } }] } }));
  gv.listen(8126);
}

// Wyze cloud (auth and app API on one port, 8127). Account wyze@example.com / wyzepass, or
// mfa@example.com for two-step sign-in with code 123456. Key ID wkid, API key wkey.
{
  const crypto = require('crypto');
  const md5 = x => crypto.createHash('md5').update(x).digest('hex');
  const PASS = md5(md5(md5('wyzepass')));
  const wz = express(); wz.use(express.json()); wz.use(express.urlencoded({ extended: false }));
  const valid = new Set();
  let n = 0;
  const tokens = () => { n++; const t = { access_token: `acc${n}`, refresh_token: `ref${n}` }; valid.add(t.access_token); return t; };
  const lights = {
    WYZE1: { product_type: 'MeshLight', product_model: 'WLPA19C', nickname: 'Den color bulb', props: { P3: '0', P1501: '80', P1502: '3000', P1507: 'FFAA00', P1508: '2' } },
    WYZE2: { product_type: 'Light', product_model: 'WLPA19', nickname: 'Hall bulb', props: { P3: '1', P1501: '100', P1502: '4000' } },
    WYZE3: { product_type: 'LightStrip', product_model: 'HL_LSL', nickname: 'TV light strip', props: { P3: '1', P1501: '60', P1507: '00FF88', P1508: '1' } },
  };
  wz.post('/api/user/login', (q, s) => {
    calls.push(['wyze', 'login', q.body.email, '']);
    if (q.headers.keyid !== 'wkid' || q.headers.apikey !== 'wkey') return s.json({ errorCode: 1001, description: 'invalid api key' });
    if (q.body.password !== PASS) return s.json({ errorCode: 1000, description: 'UserIsLocked or wrong password' });
    if (q.body.email === 'mfa@example.com') return s.json({ mfa_options: ['TotpVerificationCode'], mfa_details: { totp_apps: [{ app_id: 'totp-app-1' }] }, access_token: '' });
    s.json(tokens());
  });
  wz.post('/user/login', (q, s) => {
    if (q.body.verification_id !== 'totp-app-1' || q.body.verification_code !== '123456' || q.body.password !== PASS) return s.status(400).json({ errorCode: 1006, description: 'wrong code' });
    s.json(tokens());
  });
  wz.post('/expire', (q, s) => { valid.clear(); s.json({ ok: true }); });
  wz.post('/app/user/refresh_token', (q, s) => {
    if (!/^ref\d+$/.test(q.body.refresh_token || '')) return s.json({ code: '2001', msg: 'refresh token is error' });
    s.json({ code: '1', data: tokens() });
  });
  wz.use('/app', (q, s, next) => {
    if (!valid.has(q.body.access_token)) return s.json({ code: '2001', msg: 'access token is error' });
    next();
  });
  wz.post('/app/v2/home_page/get_object_list', (q, s) => s.json({ code: '1', data: { device_list: [
    ...Object.entries(lights).map(([mac, l]) => ({ mac, product_type: l.product_type, product_model: l.product_model, nickname: l.nickname, conn_state: 1, device_params: {} })),
    { mac: 'CAM1', product_type: 'Camera', product_model: 'WYZE_CAKP2JFUS', nickname: 'Porch camera' },
  ] } }));
  wz.post('/app/v2/device/get_property_list', (q, s) => s.json({ code: '1', data: { property_list: Object.entries(lights[q.body.device_mac]?.props || {}).map(([pid, value]) => ({ pid, value })) } }));
  const setProps = (mac, list, via) => { calls.push(['wyze', via, mac, list.map(p => `${p.pid}=${p.pvalue}`).join(' ')]); for (const p of list) lights[mac].props[p.pid] = String(p.pvalue); };
  wz.post('/app/v2/auto/run_action_list', (q, s) => {
    for (const a of q.body.action_list || []) for (const d of a.action_params?.list || []) setProps(d.mac, d.plist, `action:${a.action_key}`);
    s.json({ code: '1', data: {} });
  });
  wz.post('/app/v2/device/set_property_list', (q, s) => { setProps(q.body.device_mac, q.body.property_list, 'device'); s.json({ code: '1', data: {} }); });
  wz.post('/app/v2/device_list/set_property_list', (q, s) => { for (const d of q.body.device_list) setProps(d.device_mac, d.property_list, 'bulk'); s.json({ code: '1', data: {} }); });
  wz.get('/state', (q, s) => s.json(lights));
  wz.listen(8127);
}

// Yeelights: a search answer on UDP 19820 (run Photon with YEELIGHT_SEARCH=127.0.0.1:19820) and two
// lights on TCP: a color bulb on 15543 and a white-only one on 15544. Like real Yeelights, a light
// that's off refuses brightness and color, and each light pushes a "props" notice after a change.
{
  const dgram = require('dgram');
  const net = require('net');
  const yl = {
    '0x00000000aa01': { port: 15543, model: 'color4', name: 'Bedroom lamp', support: 'get_prop set_default set_power toggle set_bright set_ct_abx set_rgb set_hsv set_scene set_name', p: { power: 'off', bright: 70, ct: 4000, rgb: 16711680, hue: 0, sat: 100, color_mode: 2 } },
    '0x00000000aa02': { port: 15544, model: 'mono', name: '', support: 'get_prop set_default set_power toggle set_bright set_name', p: { power: 'on', bright: 100, ct: 2700, rgb: 0, hue: 0, sat: 0, color_mode: 2 } },
  };
  const ylLog = [];
  const udp = dgram.createSocket('udp4');
  udp.on('message', (m, r) => {
    if (!/M-SEARCH/.test(m.toString())) return;
    for (const [id, l] of Object.entries(yl)) {
      udp.send(Buffer.from(`HTTP/1.1 200 OK\r\nCache-Control: max-age=3600\r\nLocation: yeelight://127.0.0.1:${l.port}\r\nServer: POSIX UPnP/1.0 YGLC/1\r\nid: ${id}\r\nmodel: ${l.model}\r\nfw_ver: 26\r\nsupport: ${l.support}\r\npower: ${l.p.power}\r\nbright: ${l.p.bright}\r\ncolor_mode: ${l.p.color_mode}\r\nct: ${l.p.ct}\r\nrgb: ${l.p.rgb}\r\nhue: 0\r\nsat: 0\r\nname: ${l.name}\r\n`), r.port, r.address);
    }
  });
  udp.bind(19820, '127.0.0.1');
  for (const [id, l] of Object.entries(yl)) {
    net.createServer(sock => {
      let buf = '';
      sock.on('error', () => {});
      sock.on('data', d => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          const { id: rid, method, params } = JSON.parse(line);
          ylLog.push([id, method, params]);
          calls.push(['yeelight', id, method, params]);
          const ok = () => { sock.write(`{"method":"props","params":{"power":"${l.p.power}"}}\r\n`); sock.write(`${JSON.stringify({ id: rid, result: ['ok'] })}\r\n`); };
          const err = message => sock.write(`${JSON.stringify({ id: rid, error: { code: -1, message } })}\r\n`);
          if (method === 'get_prop') { sock.write(`${JSON.stringify({ id: rid, result: params.map(k => String(l.p[k] ?? '')) })}\r\n`); continue; }
          if (!l.support.split(' ').includes(method)) { err('method not supported'); continue; }
          if (method === 'set_power') { l.p.power = params[0]; ok(); continue; }
          if (l.p.power !== 'on') { err('general error'); continue; }
          if (method === 'set_bright') { l.p.bright = params[0]; ok(); continue; }
          if (method === 'set_ct_abx') { if (params[0] < 1700 || params[0] > 6500) { err('invalid params'); continue; } l.p.ct = params[0]; l.p.color_mode = 2; ok(); continue; }
          if (method === 'set_rgb') { l.p.rgb = params[0]; l.p.color_mode = 1; ok(); continue; }
          if (method === 'set_hsv') { l.p.hue = params[0]; l.p.sat = params[1]; l.p.color_mode = 3; ok(); continue; }
          err('method not supported');
        }
      });
    }).listen(l.port, '127.0.0.1');
  }
  hue.get('/yeelight', (q, s) => s.json(Object.fromEntries(Object.entries(yl).map(([id, l]) => [id, l.p]))));
}

console.log('mocks up');
