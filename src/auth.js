'use strict';

// Signing in to Photon.
//
// - The password is stored only as a salted scrypt hash, in its own file (auth.json) next to
//   the settings, readable only by Photon. It is never part of config.json, never sent to the
//   browser and never logged.
// - Signing in starts a session. The browser gets a random session ID in a cookie that page
//   scripts can't read (HttpOnly) and that other websites can't make the browser send
//   (SameSite=Strict). Only a SHA-256 of the ID is kept on disk, so a copy of the sessions
//   file can't be used to sign in.
// - Every change also needs the session's CSRF token in a request header, so neither another
//   website nor another program on the computer can change anything without signing in.
// - Wrong passwords are slowed down per address and overall.
// - Until a password exists, Photon makes a one-time setup code (printed at start and kept in
//   the setup-code file). Choosing the first password needs that code, so nobody else on the
//   network can claim Photon first. The installers set the password directly instead.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

// OWASP's scrypt settings (N=2^15, r=8, p=3): about 32 MB and a noticeable fraction of a
// second per guess, which still runs fine on a phone.
const KDF = { N: 2 ** 15, r: 8, p: 3, keylen: 64 };
const MAXMEM = 128 * 1024 * 1024;

const COOKIE = 'photon_sid';
const IDLE_MS = 30 * 24 * 3600e3;       // signed out after 30 days without use
const ABSOLUTE_MS = 180 * 24 * 3600e3;  // and after 180 days regardless
// Length limits, the most common passwords and keyboard runs. Kept in a JSON file that the
// installers read too, so a password they accept is one Photon accepts.
const POLICY = require('./password-policy.json');
const MIN_LENGTH = POLICY.minLength;
const MAX_LENGTH = POLICY.maxLength;
const COMMON = new Set(POLICY.common);

function create(dataDir) {
  const AUTH_FILE = path.join(dataDir, 'auth.json');
  const SESSIONS_FILE = path.join(dataDir, 'sessions.json');
  const SETUP_FILE = path.join(dataDir, 'setup-code');

  const writePrivate = (file, text) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows: the folder's permissions apply */ }
    // The password tool may run as root (sudo, or a Mac installer) while Photon runs as its own
    // account. Give the file to whoever owns the settings folder, so Photon can still read it.
    if (process.getuid?.() === 0) {
      try { const d = fs.statSync(dataDir); if (d.uid !== 0) fs.chownSync(file, d.uid, d.gid); } catch { /* keep root's */ }
    }
  };
  const mtime = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

  // ---- The password ---------------------------------------------------------------------
  // Read again whenever the file changes, so the installers' password tool and a reset take
  // effect without restarting Photon.
  let authCache = { at: -1, data: null };
  function readAuth() {
    const m = mtime(AUTH_FILE);
    if (m !== authCache.at) {
      let data = null;
      if (m) { try { data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { data = null; } }
      authCache = { at: m, data: data && data.hash && data.salt ? data : null };
    }
    return authCache.data;
  }
  const hasPassword = () => Boolean(readAuth());

  function checkPolicy(password) {
    const p = typeof password === 'string' ? password.normalize('NFKC') : '';
    if (p.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters. A few words together make a strong password that's easy to remember.`;
    if (p.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`;
    const lower = p.toLowerCase();
    if (COMMON.has(lower) || /^(.)\1+$/.test(p) || POLICY.sequences.some(run => run.includes(lower))) {
      return 'That password is too common or too easy to guess. Pick something else.';
    }
    return '';
  }

  async function hashPassword(password, salt = crypto.randomBytes(16), params = KDF) {
    const key = await scryptAsync(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM });
    return { v: 1, kdf: 'scrypt', N: params.N, r: params.r, p: params.p, keylen: params.keylen, salt: salt.toString('base64'), hash: key.toString('base64') };
  }

  // One hash at a time, so a flood of attempts can't use up memory or the thread pool.
  let hashQueue = Promise.resolve();
  const queued = fn => { const run = hashQueue.then(fn, fn); hashQueue = run.catch(() => {}); return run; };

  async function verifyPassword(password) {
    const a = readAuth();
    if (!a || typeof password !== 'string' || password.length > MAX_LENGTH * 4) return false;
    return queued(async () => {
      const got = await hashPassword(password, Buffer.from(a.salt, 'base64'), a);
      return crypto.timingSafeEqual(Buffer.from(got.hash, 'base64'), Buffer.from(a.hash, 'base64'));
    });
  }

  async function setPassword(password) {
    const problem = checkPolicy(password);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    const record = await queued(() => hashPassword(password));
    writePrivate(AUTH_FILE, JSON.stringify({ ...record, changed: new Date().toISOString() }, null, 2));
    authCache.at = -1;
    try { fs.unlinkSync(SETUP_FILE); } catch { /* none */ }
  }

  // Back to "no password": the next visitor needs a new setup code. Used by the password tool.
  function reset() {
    for (const f of [AUTH_FILE, SESSIONS_FILE, SETUP_FILE]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    authCache.at = -1;
    sessionsCache.at = -1;
  }

  // ---- First-time setup code --------------------------------------------------------------
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
  function setupCode() {
    if (hasPassword()) return null;
    try {
      const code = fs.readFileSync(SETUP_FILE, 'utf8').trim();
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return code;
    } catch { /* make one */ }
    const bytes = crypto.randomBytes(12);
    const chars = [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
    const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    writePrivate(SETUP_FILE, `${code}\n`);
    return code;
  }
  const codeMatches = given => {
    const code = setupCode();
    const a = Buffer.from(String(given || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const b = Buffer.from((code || '').replace(/-/g, ''));
    return Boolean(code) && a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // ---- Sessions ---------------------------------------------------------------------------
  let sessionsCache = { at: -1, data: {} };
  function sessions() {
    const m = mtime(SESSIONS_FILE);
    if (m !== sessionsCache.at) {
      let data = {};
      if (m) { try { data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {}; } catch { data = {}; } }
      sessionsCache = { at: m, data };
    }
    return sessionsCache.data;
  }
  function saveSessions(data) {
    const now = Date.now();
    for (const [k, s] of Object.entries(data)) if (now - s.seen > IDLE_MS || now - s.created > ABSOLUTE_MS) delete data[k];
    writePrivate(SESSIONS_FILE, JSON.stringify(data));
    sessionsCache = { at: mtime(SESSIONS_FILE), data };
  }
  const digest = id => crypto.createHash('sha256').update(String(id)).digest('hex');

  function startSession(req) {
    const id = crypto.randomBytes(32).toString('base64url');
    const data = { ...sessions() };
    data[digest(id)] = {
      created: Date.now(), seen: Date.now(),
      csrf: crypto.randomBytes(24).toString('base64url'),
      ip: req.socket?.remoteAddress || '', agent: String(req.headers['user-agent'] || '').slice(0, 160),
    };
    saveSessions(data);
    return id;
  }

  function cookieId(req) {
    const header = String(req.headers.cookie || '');
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return '';
  }

  // The signed-in session for this request, or null.
  function sessionFor(req) {
    const id = cookieId(req);
    if (!id || id.length > 100 || !hasPassword()) return null;
    const key = digest(id);
    const all = sessions();
    const s = all[key];
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > IDLE_MS || now - s.created > ABSOLUTE_MS) { const d = { ...all }; delete d[key]; saveSessions(d); return null; }
    if (now - s.seen > 10 * 60e3) { const d = { ...all, [key]: { ...s, seen: now } }; saveSessions(d); }
    return { key, ...s };
  }

  function endSession(req) {
    const id = cookieId(req);
    if (!id) return;
    const d = { ...sessions() };
    delete d[digest(id)];
    saveSessions(d);
  }
  function endAllSessions(exceptKey) {
    const d = {};
    if (exceptKey && sessions()[exceptKey]) d[exceptKey] = sessions()[exceptKey];
    saveSessions(d);
  }

  function setCookie(res, req, id) {
    const parts = [`${COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(IDLE_MS / 1000)}`];
    if (req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }
  function clearCookie(res, req) {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`);
  }

  const csrfOk = (req, s) => {
    const given = Buffer.from(String(req.headers['x-photon-csrf'] || ''));
    const want = Buffer.from(String(s?.csrf || ''));
    return want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  // ---- Slowing down guesses ----------------------------------------------------------------
  // At most 5 wrong tries per address and 30 in total per 15 minutes. Each wrong try also
  // waits a moment before answering.
  const WINDOW = 15 * 60e3;
  const failures = new Map(); // address -> [times]
  let allFailures = [];
  function limited(ip) {
    const now = Date.now();
    const mine = (failures.get(ip) || []).filter(t => now - t < WINDOW);
    allFailures = allFailures.filter(t => now - t < WINDOW);
    if (mine.length >= 5) return Math.ceil((mine[0] + WINDOW - now) / 1000);
    if (allFailures.length >= 30) return Math.ceil((allFailures[0] + WINDOW - now) / 1000);
    return 0;
  }
  function noteFailure(ip) {
    const now = Date.now();
    failures.set(ip, [...(failures.get(ip) || []).filter(t => now - t < WINDOW), now]);
    allFailures.push(now);
    if (failures.size > 5000) failures.delete(failures.keys().next().value);
  }
  const noteSuccess = ip => failures.delete(ip);

  return {
    COOKIE, MIN_LENGTH, AUTH_FILE, SETUP_FILE,
    hasPassword, checkPolicy, verifyPassword, setPassword, reset,
    setupCode, codeMatches,
    startSession, sessionFor, endSession, endAllSessions, setCookie, clearCookie, csrfOk,
    limited, noteFailure, noteSuccess,
    sessionCount: () => Object.keys(sessions()).length,
  };
}

module.exports = { create, MIN_LENGTH };
