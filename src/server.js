'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const cfg = require('./config');
const engine = require('./engine');
const lighting = require('./lighting');
const media = require('./media');
const schedule = require('./schedule');
const trackerLib = require('./media/tracker');
const tlsLib = require('./tls');
const authLib = require('./auth');
const secretsLib = require('./secrets');

const VERSION = require('../package.json').version;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
// Older setups set a password with UI_PASSWORD. It now becomes the sign-in password once.
const UI_PASSWORD = process.env.UI_PASSWORD || '';

// ---- Logging that can't take Photon down ----------------------------------------
// As a Windows service, Photon's console output goes through a pipe to the service wrapper.
// If that pipe closes, writing to it fails with EPIPE, and an unhandled stream error would
// crash Photon. Ignore those errors and keep our own log file next to the settings instead.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
const LOG_DIR = path.join(path.dirname(require('./config').CONFIG_PATH), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'photon.log');
function fileLog(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2 * 1048576) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* no file yet */ }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`);
  } catch { /* logging must never break Photon */ }
}
for (const name of ['log', 'error', 'warn']) {
  const orig = console[name].bind(console);
  console[name] = (...args) => {
    fileLog(args.map(a => (typeof a === 'string' ? a : a?.stack || JSON.stringify(a))).join(' '));
    try { orig(...args); } catch { /* the pipe is gone, the file has it */ }
  };
}

cfg.load();

// Older setups used UI_PASSWORD for a browser password prompt. Use it as the first sign-in
// password, once, so those setups keep working.
if (UI_PASSWORD) {
  const a = require('./auth').create(path.dirname(cfg.CONFIG_PATH));
  if (!a.hasPassword()) {
    const problem = a.checkPolicy(UI_PASSWORD);
    if (problem) console.error(`UI_PASSWORD wasn't used as Photon's password: ${problem} Choose one when you open Photon.`);
    else a.setPassword(UI_PASSWORD).then(() => console.log('Using UI_PASSWORD as Photon\'s sign-in password.')).catch(err => console.error(`UI_PASSWORD: ${err.message}`));
  }
}

// ---- Crash notes -------------------------------------------------------------
// If Photon ever crashes, write down why next to the settings, so the reason can be seen
// in Activity and at /api/diagnostics after the service restarts it.
const DATA_DIR = path.dirname(cfg.CONFIG_PATH);
const CRASH_DIR = path.join(DATA_DIR, 'crashes');
const STARTED = Date.now();
function noteCrash(kind, err) {
  try {
    fs.mkdirSync(CRASH_DIR, { recursive: true });
    const text = `${new Date().toISOString()} ${kind} in Photon ${require('../package.json').version} (node ${process.version}, up ${Math.round((Date.now() - STARTED) / 1000)}s)\n${err?.stack || err}\n`;
    fs.writeFileSync(path.join(CRASH_DIR, `crash-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`), text);
    const all = fs.readdirSync(CRASH_DIR).filter(f => f.startsWith('crash-')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 20))) fs.unlinkSync(path.join(CRASH_DIR, old));
  } catch { /* nothing more we can do */ }
}
process.on('uncaughtException', err => {
  console.error(`Photon crashed: ${err?.stack || err}`);
  noteCrash('crash', err);
  process.exit(1);
});
// A failed promise somewhere shouldn't take the whole service down: note it and carry on.
process.on('unhandledRejection', err => {
  console.error(`Unhandled error: ${err?.stack || err}`);
  noteCrash('unhandled error', err);
  try { require('./engine').addLog('error', `Something failed in the background: ${err?.message || err}`); } catch { /* ignore */ }
});
function recentCrashes(n = 5) {
  try {
    return fs.readdirSync(CRASH_DIR).filter(f => f.startsWith('crash-')).sort().reverse().slice(0, n)
      .map(f => fs.readFileSync(path.join(CRASH_DIR, f), 'utf8'));
  } catch { return []; }
}
function serviceLogTail(lines = 80) {
  const dir = path.join(DATA_DIR, 'logs');
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => /\.log$/i.test(f))
      .map(f => { try { return { f, t: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return { f, t: 0 }; } })
      .sort((a, b) => b.t - a.t);
  } catch (err) { return { error: `Can't read ${dir}: ${err.message}` }; }
  for (const { f } of files.slice(0, 4)) {
    try { out[f] = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).slice(-lines).join('\n'); }
    catch (err) { out[f] = `(can't read: ${err.code || err.message})`; }
  }
  return out;
}

const app = express();
const tlsMgr = tlsLib.create(cfg.CONFIG_PATH);
const auth = authLib.create(DATA_DIR);
const secrets = secretsLib.create(lighting, media);
let httpsServer = null;

// Photon running in the Android app: the page and its settings only open on the phone itself
// (in the app). Other devices on the network can only reach the webhooks, which media servers
// use and which carry their own secret key. HTTPS isn't offered, since nothing else signs in.
const ON_PHONE = process.env.PHOTON_SERVICE === 'android';
const fromThisDevice = req => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(String(req.socket?.remoteAddress || ''));
let httpsPortOpen = null;
let httpsError = '';
app.disable('x-powered-by');

// ---- Only answer at Photon's own addresses ----------------------------------------------
// A website can point a name it controls at this computer's address ("DNS rebinding") and then
// talk to Photon as if it were that site. Requests have to be addressed to an IP address or to
// one of this computer's own names, so that doesn't work.
function allowedHostNames() {
  const host = os.hostname().toLowerCase();
  const short = host.split('.')[0];
  return new Set(['localhost', host, short, `${short}.local`, `${host}.local`,
    ...(cfg.get().tls?.extraNames || []).map(n => String(n).trim().toLowerCase()),
    ...String(process.env.PHOTON_HOSTNAMES || '').split(',').map(n => n.trim().toLowerCase())].filter(Boolean));
}
function hostAllowed(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return false;
  const name = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) return true; // an IP address
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  return allowedHostNames().has(name);
}
// What the page may load and run: only Photon's own files, plus the two small scripts inside
// index.html (the theme and the module map), allowed by their exact hashes. Nothing from other
// sites, no plugins, and no other site may show Photon inside a frame.
const CSP = (() => {
  let hashes = [];
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  } catch { /* no page to protect */ }
  return [
    "default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'", "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
})();

app.use((req, res, next) => {
  // Basic protections for every page and answer.
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), payment=(), usb=()',
  });
  if (ON_PHONE && !fromThisDevice(req) && !(req.method === 'POST' && req.path.startsWith('/webhook/'))) {
    return res.status(403).type('text/plain').send('Photon on this phone only opens in the Photon app on the phone itself.');
  }
  if (hostAllowed(req.headers.host)) return next();
  res.status(421).type('text/plain').send(`Photon only answers at this computer's own addresses, and "${String(req.headers.host || '').slice(0, 100)}" isn't one of them. Use its IP address, or add this name under Settings > Secure connection (HTTPS) > Other names.`);
});

// A request that came from this page itself, not from another website.
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // not sent by a browser page; the session and CSRF checks still apply
  try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}

const tracker = trackerLib.create(ev => engine.handle(ev).catch(err => engine.addLog('error', `Event handling failed: ${err.message}`)));

// ---- Background work (Govee LAN scans, Jellyfin/Emby polling) ---------------
function startIntegrations() {
  const c = cfg.get();
  for (const p of lighting.providers) {
    if (p.start && c.lighting[p.id]?.enabled) {
      try { p.start(c.lighting[p.id]); } catch (err) { engine.addLog('error', `${p.label}: ${err.message}`); }
    }
  }
  for (const s of media.sources) {
    if (s.stop) s.stop();
    if (s.start && c.media[s.id]?.enabled) {
      Promise.resolve(s.start(c.media[s.id], tracker, engine.notePlayer, engine.addLog))
        .catch(err => engine.addLog('error', `${s.label}: ${err.message}`));
    }
  }
  schedulePlexWebhook();
}

// ---- Keeping the Plex webhook on the account up to date -----------------------
// The address Plex should call. Plex Media Server sends webhooks, so pick the address of this
// computer that's on the same network as the server (or the server itself, if it's this PC).
function webhookHostForPlex(pc) {
  const mine = lanAddresses();
  if (!mine.length) return 'localhost';
  const theirs = plex.serverLanAddresses(pc);
  const same = theirs.find(a => mine.includes(a));
  if (same) return same;
  const common = (a, b) => { const x = a.split('.'), y = b.split('.'); let n = 0; while (n < 4 && x[n] === y[n]) n++; return n; };
  let best = mine[0], score = -1;
  for (const m of mine) for (const t of theirs) { const n = common(m, t); if (n > score) { score = n; best = m; } }
  return best;
}
const plexWebhookUrl = (c, host) => `http://${host}:${PORT}/webhook/plex/${c.webhookToken}`;

let plexHook = { url: null, ok: null, at: 0, error: null, auto: true };
let plexHookTimer = null;
function schedulePlexWebhook(force = false) {
  clearTimeout(plexHookTimer);
  plexHookTimer = setTimeout(() => ensurePlexWebhook(force).catch(() => {}), force ? 0 : 2000);
}
async function ensurePlexWebhook(force = false) {
  const c = cfg.get();
  const pc = c.media.plex;
  plexHook.auto = pc.autoWebhook !== false;
  if (!pc.enabled || !pc.token || pc.autoWebhook === false) return plexHook;
  await plex.info(pc).catch(() => {}); // know the server's addresses first
  const url = plexWebhookUrl(c, webhookHostForPlex(pc));
  const fresh = Date.now() - plexHook.at < (plexHook.ok ? 6 * 3600e3 : 10 * 60e3);
  if (!force && plexHook.url === url && fresh) return plexHook;
  try {
    const r = await plex.syncWebhook(pc, url);
    if (r.changed) engine.addLog('ok', `Plex webhook set to ${url}${r.removed.length ? ` (replaced ${r.removed.length} older Photon address${r.removed.length > 1 ? 'es' : ''})` : ''}`);
    plexHook = { url, ok: true, at: Date.now(), error: null, auto: true };
  } catch (err) {
    if (plexHook.error !== err.message) engine.addLog('error', `Couldn't set the Plex webhook: ${err.message}`);
    plexHook = { url, ok: false, at: Date.now(), error: err.message, auto: true };
  }
  return plexHook;
}
setInterval(() => schedulePlexWebhook(), 30 * 60e3).unref(); // also catches a new IP address

// ---- Webhooks from media servers ------------------------------------------
// Plex sends a small thumbnail with some events. Nothing is read until the key in the address
// is checked, and then only a couple of small files.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 2, fields: 20, parts: 30, fieldSize: 2 * 1024 * 1024 } });
function webhookKey(req, res, next) {
  const a = Buffer.from(String(req.params.token));
  const b = Buffer.from(cfg.get().webhookToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send('bad token');
  next();
}

app.post('/webhook/:source/:token',
  webhookKey,
  upload.any(),
  express.json({ limit: '2mb', type: ['application/json', 'text/plain', 'application/*+json'] }),
  express.urlencoded({ extended: false, limit: '2mb' }),
  (req, res) => {
    const c = cfg.get();
    const src = media.byId[req.params.source];
    if (!src || !src.parseWebhook) return res.status(404).send('unknown source');
    if (!c.media[src.id]?.enabled) {
      engine.addLog('warn', `Got a ${src.label} webhook, but ${src.label} is turned off in Connections`);
      return res.sendStatus(200);
    }
    res.sendStatus(200); // reply right away, do the light work after
    try {
      const r = src.parseWebhook(req, tracker, c.media[src.id]);
      if (r.ignored) return; // another server, or someone outside the Plex Home
      if (r.seen) engine.notePlayer(r.seen);
      for (const ev of r.events || []) engine.handle(ev).catch(err => engine.addLog('error', `Event handling failed: ${err.message}`));
    } catch (err) {
      engine.addLog('error', `${src.label} webhook could not be read: ${err.message}`);
    }
  });

// ---- HTTPS -----------------------------------------------------------------
// Photon's certificate authority, for installing on your devices. It's a public
// certificate (no key), so it's available without the UI password.
app.get('/photon-ca.crt', (req, res) => {
  const pem = tlsMgr.caPem();
  if (!pem) return res.status(404).send('Photon has not made a certificate authority yet.');
  res.set('Content-Type', 'application/x-x509-ca-cert');
  res.set('Content-Disposition', 'attachment; filename="Photon-CA.crt"');
  res.send(pem);
});

// Send browsers to HTTPS when asked to (page loads only). Webhooks and API calls
// stay on plain HTTP so media servers keep working without trusting Photon's certificate.
app.use((req, res, next) => {
  const t = cfg.get().tls;
  if (!t.redirect || req.secure || !httpsServer?.listening || req.path.startsWith('/webhook/') || req.method !== 'GET' || !String(req.headers.accept || '').includes('text/html')) return next();
  res.redirect(302, `https://${req.hostname}${t.httpsPort === 443 ? '' : `:${t.httpsPort}`}${req.originalUrl}`);
});

function applyTls() {
  if (ON_PHONE) return; // no HTTPS on a phone (see ON_PHONE)
  const t = cfg.get().tls;
  let opts = null;
  try {
    opts = tlsMgr.options(t);
  } catch (err) {
    httpsError = err.message;
    engine.addLog('error', `HTTPS could not start: ${err.message}`);
  }
  if (!opts) {
    if (httpsServer) { httpsServer.close(); httpsServer = null; httpsPortOpen = null; }
    return;
  }
  const port = Number(process.env.HTTPS_PORT || t.httpsPort);
  if (httpsServer && httpsPortOpen === port) {
    httpsServer.setSecureContext({ cert: opts.cert, key: opts.key });
    return;
  }
  if (httpsServer) httpsServer.close();
  httpsError = '';
  httpsServer = https.createServer({ cert: opts.cert, key: opts.key }, app);
  httpsPortOpen = port;
  httpsServer.on('error', err => {
    httpsError = err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another HTTPS port.` : err.code === 'EACCES' ? `Port ${port} needs admin rights on this machine. Pick a port above 1024.` : err.message;
    engine.addLog('error', `HTTPS could not start: ${httpsError}`);
    httpsServer = null;
    httpsPortOpen = null;
  });
  httpsServer.listen(port, HOST, () => {
    engine.addLog('ok', `HTTPS is on at port ${port}`);
    for (const ip of lanAddresses()) console.log(`  secure: https://${ip}:${port}`);
  });
}

// Renew Photon's own certificate before it runs out, or when this machine's address changes.
setInterval(() => {
  const t = cfg.get().tls;
  if (t.mode !== 'generated') return;
  try { if (tlsMgr.ensureGenerated(t.extraNames).renewed) { applyTls(); engine.addLog('ok', 'Renewed Photon\'s HTTPS certificate'); } } catch (err) { engine.addLog('error', `Certificate renewal failed: ${err.message}`); }
}, 6 * 3600 * 1000).unref();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// three.js is served to the browser for the 3D view. Look in node_modules directly so a
// trimmed install (only the browser files) still works.
const threeDir = [path.join(__dirname, '..', 'node_modules', 'three')]
  .concat((() => { try { return [path.join(path.dirname(require.resolve('three')), '..')]; } catch { return []; } })())
  .find(d => fs.existsSync(path.join(d, 'build', 'three.module.js')));
app.use('/vendor/three', express.static(path.join(threeDir, 'build')));
app.use('/vendor/three-addons', express.static(path.join(threeDir, 'examples', 'jsm')));

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => res.status(err.status || 400).json({ error: err.message }));

// ---- Signing in ---------------------------------------------------------------------------
// Open to everyone: whether a password exists and whether this browser is signed in. The page
// uses it to show the sign-in or first-time screen.
app.get('/api/auth/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = auth.sessionFor(req);
  res.json({ setup: !auth.hasPassword(), signedIn: Boolean(s), csrf: s?.csrf || null, minLength: auth.MIN_LENGTH });
});

// Photon's version, for the installers and the Android app to see that it's up.
app.get('/api/version', (req, res) => res.json({ version: VERSION }));

// Enough for a newer Photon to recognize this one on its port during an update.
app.get('/api/instance', (req, res) => res.json({
  photon: true, pid: process.pid, service: Boolean(process.env.PHOTON_SERVICE),
  configId: crypto.createHash('sha256').update(path.resolve(cfg.CONFIG_PATH).toLowerCase()).digest('hex').slice(0, 16),
}));

function refuseUnlessSameOrigin(req, res) {
  if (sameOrigin(req)) return false;
  res.status(403).json({ error: 'Photon only accepts this from its own page.' });
  return true;
}
const clientIp = req => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
function tooMany(req, res) {
  const wait = auth.limited(clientIp(req));
  if (!wait) return false;
  res.set('Retry-After', String(wait)).status(429).json({ error: `Too many wrong tries. Wait ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''} and try again.` });
  return true;
}
const slowDown = () => new Promise(r => setTimeout(r, 400 + Math.random() * 400));

app.post('/api/auth/login', wrap(async (req, res) => {
  if (refuseUnlessSameOrigin(req, res) || tooMany(req, res)) return;
  if (!auth.hasPassword()) return res.status(409).json({ error: 'Photon has no password yet.', setup: true });
  const ok = await auth.verifyPassword(String(req.body?.password ?? ''));
  if (!ok) {
    auth.noteFailure(clientIp(req));
    engine.addLog('warn', `Wrong Photon password from ${clientIp(req)}`);
    await slowDown();
    return res.status(401).json({ error: 'That password isn\'t right.' });
  }
  auth.noteSuccess(clientIp(req));
  const id = auth.startSession(req);
  auth.setCookie(res, req, id);
  engine.addLog('info', `Signed in to Photon from ${clientIp(req)}`);
  res.json({ ok: true });
}));

// The first password. Needs the setup code, so only someone who can see Photon's console,
// settings folder or installer can choose it.
app.post('/api/auth/setup', wrap(async (req, res) => {
  if (refuseUnlessSameOrigin(req, res) || tooMany(req, res)) return;
  if (auth.hasPassword()) return res.status(409).json({ error: 'Photon already has a password. Sign in instead.' });
  if (!auth.codeMatches(req.body?.code)) {
    auth.noteFailure(clientIp(req));
    await slowDown();
    return res.status(401).json({ error: 'That setup code isn\'t right. It\'s shown where Photon was installed or started.' });
  }
  await auth.setPassword(String(req.body?.password ?? ''));
  auth.noteSuccess(clientIp(req));
  auth.endAllSessions();
  const id = auth.startSession(req);
  auth.setCookie(res, req, id);
  engine.addLog('ok', `Photon's password was set from ${clientIp(req)}`);
  res.json({ ok: true });
}));

// Signing in with the phone's fingerprint or face, in the Android app. The app unlocks a device
// key with the phone's biometrics and sends it here. Device keys only work from the phone
// Photon runs on (the app's own page talks to 127.0.0.1), so a copied key is no use elsewhere.
const isLoopback = req => /^(127\.\d+\.\d+\.\d+|::1)$/.test(clientIp(req));
app.post('/api/auth/device-login', wrap(async (req, res) => {
  if (refuseUnlessSameOrigin(req, res) || tooMany(req, res)) return;
  if (!isLoopback(req)) return res.status(403).json({ error: 'Fingerprint and face sign-in only work in the Photon app on the phone Photon runs on.' });
  if (!auth.deviceMatches(req.body?.id, req.body?.token)) {
    auth.noteFailure(clientIp(req));
    await slowDown();
    return res.status(401).json({ error: 'Fingerprint and face sign-in was turned off, because the password changed or everyone was signed out. Sign in with your password and turn it on again.', deviceGone: true });
  }
  auth.noteSuccess(clientIp(req));
  const id = auth.startSession(req);
  auth.setCookie(res, req, id);
  engine.addLog('info', 'Signed in to Photon with fingerprint or face on this phone');
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  if (refuseUnlessSameOrigin(req, res)) return;
  auth.endSession(req);
  auth.clearCookie(res, req);
  res.json({ ok: true });
});

// Everything else under /api needs a signed-in session, and changes also need the session's
// CSRF token, which only Photon's own page has.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Photon only accepts this from its own page.' });
  const s = auth.sessionFor(req);
  if (!s) return res.status(401).json({ error: 'Sign in to Photon first.', signIn: true, setup: !auth.hasPassword() });
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Photon only accepts this from its own page.' });
    if (!auth.csrfOk(req, s)) return res.status(403).json({ error: 'This page is out of date. Reload it and try again.' });
  }
  req.photonSession = s;
  next();
});

app.post('/api/auth/password', wrap(async (req, res) => {
  if (tooMany(req, res)) return;
  if (!(await auth.verifyPassword(String(req.body?.current ?? '')))) {
    auth.noteFailure(clientIp(req));
    await slowDown();
    return res.status(401).json({ error: 'Your current password isn\'t right.' });
  }
  await auth.setPassword(String(req.body?.password ?? ''));
  auth.endAllSessions();
  auth.removeAllDevices();
  const id = auth.startSession(req); // a fresh session for this browser
  auth.setCookie(res, req, id);
  engine.addLog('ok', 'Photon\'s password was changed. Everyone else was signed out.');
  res.json({ ok: true });
}));

// Turning on fingerprint or face sign-in for this phone. Takes the password once more.
app.get('/api/auth/devices', (req, res) => res.json(auth.deviceList()));
app.post('/api/auth/devices', wrap(async (req, res) => {
  if (tooMany(req, res)) return;
  if (!isLoopback(req)) return res.status(403).json({ error: 'Fingerprint and face sign-in can only be turned on in the Photon app on the phone Photon runs on.' });
  if (!(await auth.verifyPassword(String(req.body?.password ?? '')))) {
    auth.noteFailure(clientIp(req));
    await slowDown();
    return res.status(403).json({ error: 'That password isn\'t right.' });
  }
  auth.noteSuccess(clientIp(req));
  const device = auth.addDevice(req.body?.name);
  engine.addLog('ok', 'Fingerprint and face sign-in was turned on for this phone');
  res.json(device);
}));
app.delete('/api/auth/devices/:id', (req, res) => {
  const removed = auth.removeDevice(String(req.params.id));
  if (removed) engine.addLog('info', 'Fingerprint and face sign-in was turned off for a phone');
  res.json({ ok: true, removed });
});

app.post('/api/auth/logout-all', (req, res) => {
  auth.endAllSessions();
  auth.removeAllDevices();
  auth.clearCookie(res, req);
  engine.addLog('info', 'Everyone was signed out of Photon');
  res.json({ ok: true });
});

const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

app.get('/api/meta', (req, res) => {
  const c = cfg.get();
  const host = lanAddresses()[0] || req.hostname;
  res.json({
    version: VERSION,
    onPhone: ON_PHONE,
    settingsProblem: cfg.status().readOnly,
    lighting: lighting.providers.map(p => ({ id: p.id, label: p.label, blurb: p.blurb, fields: p.fields, actions: p.actions || [] })),
    media: media.sources.map(s => ({
      id: s.id, label: s.label, blurb: s.blurb, fields: s.fields, webhookHelp: s.webhookHelp,
      group: s.group || 'server', actions: s.actions || [], webhook: s.webhook !== false,
      webhookUrl: s.id === 'plex' && c.media.plex.token ? plexWebhookUrl(c, webhookHostForPlex(c.media.plex)) : `http://${host}:${PORT}/webhook/${s.id}/${c.webhookToken}`,
    })),
    events: cfg.EVENTS,
    mediaTypes: cfg.MEDIA_TYPES,
    now: new Date().toString(),
    sun: schedule.sunTimesToday(c.location),
  });
});

app.get('/api/config', (req, res) => res.json(secrets.redact(cfg.get())));

app.get('/api/config/rev', (req, res) => res.json({ editRev: cfg.get().editRev }));

app.put('/api/config', wrap(async (req, res) => {
  const cur = cfg.get();
  // Keys the page only knows as "saved" keep their saved values.
  const next = secrets.restore({ ...req.body }, cur);
  // A page that loaded an older copy must not overwrite newer changes made elsewhere.
  if (next.editRev !== cur.editRev) {
    return res.status(409).json({ error: 'Photon was changed in another window or on another device.', config: secrets.redact(cur) });
  }
  // A time that can't be read doesn't block saving everything else; that behavior just
  // stays inactive until it's fixed.
  const warnings = [];
  for (const room of next.rooms || []) {
    for (const rule of room.rules || []) {
      const s = rule.schedule || {};
      if (s.enabled && (!schedule.isValidSpec(s.from) || !schedule.isValidSpec(s.to))) {
        warnings.push(`"${rule.name}" in ${room.name} won't run until its time is fixed. Use 22:30, sunset, sunrise, dawn or dusk, with an optional offset like sunset-30.`);
      }
    }
  }
  next.webhookToken = cur.webhookToken; // only changed by its own route
  next.tls = cur.tls; // changed only through the HTTPS routes
  next.hiddenPlayers = cur.hiddenPlayers; // changed only through the player routes
  // Plex sign-in details are only changed by the sign-in routes.
  if (next.media?.plex) Object.assign(next.media.plex, { token: cur.media.plex.token, account: cur.media.plex.account, clientId: cur.media.plex.clientId });
  next.editRev = cur.editRev + 1;
  const saved = cfg.set(next);
  startIntegrations();
  res.json({ editRev: saved.editRev, warnings });
}));

app.get('/api/backups', (req, res) => res.json(cfg.listBackups()));

app.post('/api/backups/restore', wrap(async (req, res) => {
  const restored = cfg.restoreBackup(String(req.body?.file || ''));
  engine.addLog('ok', `Restored settings from a backup (${restored.rooms.length} room(s))`);
  startIntegrations();
  res.json({ ok: true });
}));

app.post('/api/backups/import', wrap(async (req, res) => {
  // A file saved from a page has keys hidden as SAVED; those keep the keys this Photon has.
  const incoming = req.body?.config && typeof req.body.config === 'object' ? secrets.restore(req.body.config, cfg.get()) : req.body?.config;
  const imported = cfg.importConfig(incoming);
  engine.addLog('ok', `Imported settings from another Photon (${imported.rooms.length} room(s))`);
  startIntegrations();
  res.json({ ok: true, rooms: imported.rooms.length });
}));

// Every setting including keys and tokens, as a file, for moving Photon to another computer
// or phone. The file holds every key, so it takes the password again.
app.post('/api/backups/export', wrap(async (req, res) => {
  if (tooMany(req, res)) return;
  if (!(await auth.verifyPassword(String(req.body?.password ?? '')))) {
    auth.noteFailure(clientIp(req));
    await slowDown();
    return res.status(403).json({ error: 'That password isn\'t right.' });
  }
  auth.noteSuccess(clientIp(req));
  engine.addLog('ok', `Settings, keys included, were downloaded from ${clientIp(req)}`);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', `attachment; filename="photon-settings-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(cfg.get(), null, 2));
}));

app.post('/api/backups/now', wrap(async (req, res) => {
  const file = cfg.backup('manual');
  if (!file) throw new Error('Could not make a backup');
  res.json({ file });
}));

app.post('/api/webhook-token/regenerate', (req, res) => {
  const c = cfg.get();
  const saved = cfg.set({ ...c, webhookToken: crypto.randomBytes(12).toString('hex') });
  schedulePlexWebhook(true);
  res.json(secrets.redact(saved));
});

app.get('/api/default-rules', (req, res) => res.json(cfg.defaultRules()));
app.get('/api/diagnostics', (req, res) => res.json({
  version: VERSION, node: process.version, platform: `${process.platform} ${os.release()}`,
  pid: process.pid, ppid: process.ppid, user: (() => { try { return os.userInfo().username; } catch { return process.env.USERNAME || ''; } })(),
  execPath: process.execPath, settings: cfg.status(), service: Boolean(process.env.PHOTON_SERVICE),
  upSeconds: Math.round((Date.now() - STARTED) / 1000), config: cfg.CONFIG_PATH, memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  crashes: recentCrashes(), serviceLogs: serviceLogTail(),
}));
app.get('/api/status', (req, res) => res.json(engine.status()));
// Other Photons heard on the network (see peers.js).
app.get('/api/peers', (req, res) => res.json(peers.list()));
app.get('/api/log', (req, res) => res.json(engine.log()));

// Which behavior would run right now for each event, per room.
app.get('/api/preview', (req, res) => {
  res.json(Object.fromEntries(cfg.get().rooms.map(r => [r.id,
    Object.fromEntries(cfg.EVENTS.map(e => [e, engine.pickRule(r, e)?.id || null]))])));
});

// ---- Lighting systems ------------------------------------------------------
// The UI posts the (possibly unsaved) settings so you can test before saving.
// Settings the page sent for testing, with saved keys filled back in.
const bodyConfig = (req, kind, id) => {
  const saved = cfg.get()[kind][id];
  return req.body?.config ? secrets.restoreOne(kind, id, req.body.config, saved) : saved;
};
// Pairing gives back new keys. Save them here, and only tell the page that they're saved.
function keepPatch(kind, id, result) {
  if (!result?.patch) return result;
  const c = cfg.get();
  const saved = cfg.set({ ...c, [kind]: { ...c[kind], [id]: { ...c[kind][id], ...result.patch } }, editRev: c.editRev + 1 });
  return { ...result, patch: secrets.redactOne(kind, id, result.patch), editRev: saved.editRev };
}

app.post('/api/lighting/:id/action/:action', wrap(async (req, res) => {
  const p = lighting.byId[req.params.id];
  if (!p?.action) throw new Error('unknown action');
  res.json(keepPatch('lighting', p.id, await p.action(req.params.action, bodyConfig(req, 'lighting', p.id))));
}));

app.post('/api/lighting/:id/test', wrap(async (req, res) => {
  const p = lighting.byId[req.params.id];
  if (!p) throw new Error('unknown lighting system');
  const c = bodyConfig(req, 'lighting', p.id);
  if (!p.configured(c)) throw new Error('Fill in the settings first');
  const r = await p.list(c);
  if (!r.targets.length && ['govee', 'wiz'].includes(p.id)) {
    throw new Error(p.id === 'govee'
      ? 'No Govee lights answered. Turn on "LAN Control" for each light in the Govee app (device settings), make sure Photon runs on the same network, or add a cloud API key.'
      : 'No WiZ bulbs answered. Make sure Photon runs on the same network as the bulbs, or list their IPs.');
  }
  res.json({ message: `Connected. Found ${r.targets.length} light(s) or group(s) and ${r.scenes.length} scene(s).` });
}));

app.get('/api/targets', wrap(async (req, res) => {
  const c = cfg.get();
  const out = await Promise.all(lighting.providers
    .filter(p => c.lighting[p.id]?.enabled)
    .map(async p => {
      if (!p.configured(c.lighting[p.id])) return { id: p.id, label: p.label, targets: [], scenes: [], error: 'Not set up yet' };
      try { return { id: p.id, label: p.label, ...(await p.list(c.lighting[p.id])) }; }
      catch (err) { return { id: p.id, label: p.label, targets: [], scenes: [], error: err.message }; }
    }));
  res.json(out);
}));

// ---- Media servers ---------------------------------------------------------
// Find, pair and similar buttons for Smart TVs.
app.post('/api/media/:id/action/:action', wrap(async (req, res) => {
  const s = media.byId[req.params.id];
  if (!s?.action) throw new Error('unknown action');
  res.json(keepPatch('media', s.id, await s.action(req.params.action, bodyConfig(req, 'media', s.id))));
}));

app.get('/api/media/:id/status', (req, res) => {
  const s = media.byId[req.params.id];
  res.json({ devices: s?.status ? s.status() : [] });
});

app.post('/api/media/:id/test', wrap(async (req, res) => {
  const s = media.byId[req.params.id];
  if (!s) throw new Error('unknown media server');
  const c = bodyConfig(req, 'media', s.id);
  const players = await s.listPlayers(c);
  if (s.group === 'tv') return res.json({ message: `Found ${players.map(p => p.name).join(', ')}. Add ${players.length > 1 ? 'them' : 'it'} to a room as its player.` });
  res.json({ message: players.length ? `Connected. Found ${players.length} player(s).` : 'Nothing to test without credentials. Webhooks still work; players appear here once they play something.' });
}));

app.get('/api/players', wrap(async (req, res) => {
  const c = cfg.get();
  const map = new Map();
  const errors = [];
  await Promise.all(media.sources.filter(s => c.media[s.id]?.enabled && s.listPlayers).map(async s => {
    try {
      for (const p of await s.listPlayers(c.media[s.id])) {
        map.set(`${s.id}:${p.id}`, { key: `${s.id}:${p.id}`, source: s.id, id: p.id, name: p.name, product: p.product });
      }
    } catch (err) { errors.push(`${s.label}: ${err.message}`); }
  }));
  const hidden = new Set(c.hiddenPlayers);
  for (const p of engine.seenPlayers()) {
    const known = map.get(p.key) || {};
    map.set(p.key, { ...known, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null)) });
  }
  res.json({ players: [...map.values()].filter(p => !hidden.has(p.key)), hidden: hidden.size, errors });
}));

app.post('/api/players/hide', wrap(async (req, res) => {
  const key = String(req.body?.key || '');
  if (!key) throw new Error('Which player?');
  const c = cfg.get();
  cfg.set({ ...c, hiddenPlayers: [...new Set([...c.hiddenPlayers, key])] });
  res.json({ ok: true });
}));

app.post('/api/players/unhide', wrap(async (req, res) => {
  const c = cfg.get();
  cfg.set({ ...c, hiddenPlayers: [] });
  res.json({ ok: true });
}));

// ---- HTTPS settings ----------------------------------------------------------
function tlsInfo(req) {
  const t = cfg.get().tls;
  const st = tlsMgr.status(t);
  const port = httpsPortOpen || t.httpsPort;
  const hosts = [...new Set([req.hostname, ...lanAddresses()])];
  return {
    ...t, ...st,
    active: Boolean(httpsServer?.listening),
    error: httpsError,
    secureNow: req.secure,
    urls: httpsServer?.listening ? hosts.map(h => `https://${h}${port === 443 ? '' : `:${port}`}`) : [],
  };
}

function setTls(patch) {
  const c = cfg.get();
  cfg.set({ ...c, tls: { ...c.tls, ...patch } });
}

app.use('/api/tls', (req, res, next) => (ON_PHONE ? res.status(404).json({ error: 'HTTPS isn\'t used when Photon runs on a phone.' }) : next()));
app.get('/api/tls', (req, res) => res.json(tlsInfo(req)));

app.post('/api/tls/generate', wrap(async (req, res) => {
  const extraNames = Array.isArray(req.body?.extraNames) ? req.body.extraNames : cfg.get().tls.extraNames;
  setTls({ mode: 'generated', extraNames });
  tlsMgr.ensureGenerated(cfg.get().tls.extraNames, true);
  applyTls();
  await new Promise(r => setTimeout(r, 300));
  res.json(tlsInfo(req));
}));

app.post('/api/tls/custom', wrap(async (req, res) => {
  tlsMgr.saveCustom(req.body || {});
  setTls({ mode: 'custom' });
  applyTls();
  await new Promise(r => setTimeout(r, 300));
  res.json(tlsInfo(req));
}));

app.post('/api/tls/settings', wrap(async (req, res) => {
  const patch = {};
  if (req.body?.httpsPort != null) {
    const p = Number(req.body.httpsPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('The HTTPS port must be a number from 1 to 65535.');
    if (p === PORT) throw new Error(`Port ${p} is already used for plain HTTP. Pick a different one.`);
    patch.httpsPort = p;
  }
  if (req.body?.redirect != null) patch.redirect = Boolean(req.body.redirect);
  if (Array.isArray(req.body?.extraNames)) patch.extraNames = req.body.extraNames;
  if (req.body?.mode === 'custom') {
    if (!tlsMgr.status(cfg.get().tls).hasCustom) throw new Error('Upload your certificate first.');
    patch.mode = 'custom';
  }
  setTls(patch);
  applyTls();
  await new Promise(r => setTimeout(r, 300));
  res.json(tlsInfo(req));
}));

app.post('/api/tls/off', wrap(async (req, res) => {
  setTls({ mode: 'off', redirect: false });
  applyTls();
  res.json(tlsInfo(req));
}));

// ---- Plex sign-in (PIN flow, the password never touches Photon) ------------
const plex = media.byId.plex;

function plexConfig() {
  const c = cfg.get();
  if (!c.media.plex.clientId) {
    c.media.plex.clientId = plex.newClientId();
    cfg.set(c);
  }
  return cfg.get().media.plex;
}

app.post('/api/plex/signin', wrap(async (req, res) => {
  res.json(await plex.createPin(plexConfig()));
}));

app.get('/api/plex/signin/:id', wrap(async (req, res) => {
  const token = await plex.checkPin(plexConfig(), req.params.id);
  if (!token) return res.json({ done: false });
  const c = cfg.get();
  const pc = { ...c.media.plex, token, enabled: true };
  const data = await plex.info(pc, true);
  pc.account = data.account?.name || '';
  if (!pc.serverId && data.servers.length === 1) pc.serverId = data.servers[0].id;
  cfg.set({ ...c, media: { ...c.media, plex: pc } });
  engine.addLog('ok', `Signed in to Plex as ${pc.account}`);
  schedulePlexWebhook(true);
  res.json({ done: true, config: secrets.redactOne('media', 'plex', cfg.get().media.plex), ...publicInfo(data) });
}));

app.post('/api/plex/signout', wrap(async (req, res) => {
  const c = cfg.get();
  const pc = { ...c.media.plex, token: '', account: '', serverId: '' };
  cfg.set({ ...c, media: { ...c.media, plex: pc } });
  res.json({ config: secrets.redactOne('media', 'plex', cfg.get().media.plex) });
}));

app.post('/api/plex/token', wrap(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) throw new Error('Paste a token first');
  const c = cfg.get();
  const pc = { ...c.media.plex, token, enabled: true };
  const data = await plex.info(pc, true).catch(err => { throw new Error(`Plex didn't accept that token (${err.message})`); });
  pc.account = data.account?.name || '';
  if (!pc.serverId && data.servers.length === 1) pc.serverId = data.servers[0].id;
  cfg.set({ ...c, media: { ...c.media, plex: pc } });
  schedulePlexWebhook(true);
  res.json({ config: secrets.redactOne('media', 'plex', cfg.get().media.plex), ...publicInfo(data) });
}));

const publicInfo = d => ({ account: d.account, servers: d.servers, homeUsers: d.homeUsers, webhook: plexHook });

app.post('/api/plex/webhook', wrap(async (req, res) => {
  const pc = cfg.get().media.plex;
  if (!pc.token) throw new Error('Sign in to Plex first');
  if (pc.autoWebhook === false) throw new Error('Turn on "Add Photon\'s webhook to my Plex account" first');
  const r = await ensurePlexWebhook(true);
  if (!r.ok) throw new Error(r.error);
  res.json({ webhook: r, message: `Your Plex account now sends events to ${r.url}` });
}));

app.get('/api/plex/info', wrap(async (req, res) => {
  const pc = cfg.get().media.plex;
  if (!pc.token) return res.json({ account: null, servers: [], homeUsers: [] });
  res.json(publicInfo(await plex.info(pc, req.query.refresh === '1')));
}));

// ---- Testing from the UI ---------------------------------------------------
app.post('/api/test-action', wrap(async (req, res) => {
  const { targets = [], action = {} } = req.body || {};
  if (action.type === 'restore') throw new Error('"Restore" needs a saved state from real playback. Use Simulate instead.');
  const r = await engine.applyAction({ name: 'Test', targets }, { ...cfg.DEFAULT_ACTION, ...action }, null);
  if (!r.ok && r.errors.length) throw new Error(r.errors.join('; '));
  res.json({ message: r.summary + (r.errors.length ? `. Problems: ${r.errors.join('; ')}` : '') });
}));

// TV sync boxes: which lights a box colors (to fill in the room's list), and trying it out.
app.get('/api/sync/lights', wrap(async (req, res) => {
  const key = String(req.query.box || '');
  const [pid, tid] = lighting.splitKey(key);
  const p = lighting.byId[pid];
  const c = cfg.get().lighting[pid];
  if (!p?.syncLights || !c?.enabled) throw new Error('Turn that sync box\'s connection on first');
  res.json({ lights: await p.syncLights(c, tid, cfg.get().lighting) });
}));
app.post('/api/rooms/:id/sync', wrap(async (req, res) => {
  const room = cfg.get().rooms.find(r => r.id === req.params.id);
  if (!room?.sync?.box) throw new Error('Pick a sync box for this room and let it save first');
  const message = await engine.setSync(room, Boolean(req.body?.on), { mediaType: room.mediaTypes[0] || 'movie' });
  engine.addLog('ok', `${room.name}: ${message} (tried from Room settings)`, { room: room.name });
  res.json({ message: message.charAt(0).toUpperCase() + message.slice(1) });
}));

app.post('/api/rooms/:id/simulate', wrap(async (req, res) => {
  const room = cfg.get().rooms.find(r => r.id === req.params.id);
  if (!room) throw new Error('Save the room first');
  if (!room.players.length) throw new Error('Pick at least one player for this room first');
  const [source, ...rest] = room.players[0].split(':');
  const playerId = rest.join(':');
  const known = engine.seenPlayers().find(p => p.key === room.players[0]);
  const ev = {
    source, playerId, event: req.body?.event,
    playerName: known?.name || playerId, product: known?.product || '',
    user: room.users[0] || known?.user || '',
    mediaType: room.mediaTypes[0] || 'movie', title: 'Simulated playback',
  };
  if (!cfg.EVENTS.includes(ev.event)) throw new Error('unknown event');
  engine.addLog('info', `Simulating ${ev.event} in ${room.name}`, { room: room.name });
  res.json(await engine.handle(ev));
}));

// If the previous Photon is still letting go of the port (during an update or a restart),
// wait for it instead of crashing.
// Another Photon on the same settings (left behind by an update, or started by hand) is
// stopped so this one, normally the Windows service, can take over.
const INSTANCE_FILE = path.join(DATA_DIR, 'instance.json');
async function stopOtherPhoton() {
  // Only a process that answers as Photon on this port, using these same settings, is stopped.
  const pids = new Set();
  const myConfigId = crypto.createHash('sha256').update(path.resolve(cfg.CONFIG_PATH).toLowerCase()).digest('hex').slice(0, 16);
  const ask = async p => { const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 2000); return (await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: ctrl.signal })).json(); };
  try {
    // Photon 1.5 says who it is at /api/instance; older versions at /api/diagnostics.
    let d = await ask('/api/instance').catch(() => null);
    let same = d?.photon && d.configId === myConfigId;
    if (!d?.photon) {
      d = await ask('/api/diagnostics');
      same = path.resolve(String(d?.config || '')).toLowerCase() === path.resolve(cfg.CONFIG_PATH).toLowerCase();
    }
    // A copy started by hand never pushes the Windows service aside; the service does take over.
    if (d?.pid && same && !(d.service && !process.env.PHOTON_SERVICE)) pids.add(Number(d.pid));
  } catch { /* not Photon, or too old to say */ }
  for (const pid of pids) {
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 0); } catch { continue; } // not running
    console.error(`Stopping the other Photon (process ${pid}) that holds port ${PORT}`);
    try { process.kill(pid); } catch (err) { console.error(`Couldn't stop process ${pid}: ${err.message}`); }
  }
}
function listenWithRetry(tries = 0) {
  const server = app.listen(PORT, HOST);
  server.once('error', async err => {
    if (err.code === 'EADDRINUSE' && tries < 30) {
      if (tries === 0) console.error(`Port ${PORT} is in use, checking whether it's another Photon`);
      if (tries % 5 === 0) await stopOtherPhoton().catch(() => {});
      setTimeout(() => listenWithRetry(tries + 1), 2000);
      return;
    }
    throw err;
  });
  server.once('listening', onListening);
}
listenWithRetry();

// Other copies of Photon on the network (two of them fight over the same lights).
const peers = require('./peers').create({
  dataDir: DATA_DIR, version: VERSION, onPhone: ON_PHONE,
  lights: () => Object.entries(cfg.get().lighting || {}).filter(([, c]) => c?.enabled).map(([k]) => k),
  log: (level, msg) => engine.addLog(level, msg),
});

function onListening() {
  if (!process.env.PHOTON_NO_PEERS) peers.start();
  try { fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ pid: process.pid, port: PORT, version: VERSION, started: new Date(STARTED).toISOString() })); } catch { /* not important */ }
  console.log(`Photon ${VERSION} is running: http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  on your network: http://${ip}:${PORT}`);
  console.log(`Config: ${cfg.CONFIG_PATH}`);
  if (!auth.hasPassword()) {
    console.log(`Photon has no password yet. Open it and choose one with this setup code: ${auth.setupCode()}`);
    console.log(`  (the code is also in ${auth.SETUP_FILE})`);
  }
  const last = recentCrashes(1)[0];
  if (last && Date.parse(last.slice(0, 24)) > STARTED - 10 * 60e3) {
    engine.addLog('error', `Photon restarted after a problem: ${last.split('\n')[1] || last.slice(0, 200)}`);
  }
  startIntegrations();
  applyTls();
}
