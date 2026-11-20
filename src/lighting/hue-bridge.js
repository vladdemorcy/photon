'use strict';

// Talks to a Philips Hue bridge's local API.
//
// Hue bridges are moving to HTTPS only: the Bridge Pro has never answered on plain HTTP, and
// firmware updates are turning HTTP off on the square bridge too. So Photon uses HTTPS first and
// only falls back to HTTP for a bridge that has never answered on HTTPS (very old bridges and
// older firmware).
//
// Bridge certificates aren't trusted by any computer by default. Newer bridges have one signed
// by Signify's own Hue root, which Photon checks; older ones have their own self-made one. Photon
// accepts a Signify-signed certificate, otherwise remembers the certificate it first saw and
// refuses a different one later, so nothing else on the network can pose as the bridge and
// collect its app key. Once a bridge has answered on HTTPS, Photon never drops back to HTTP.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const http = require('http');

const TIMEOUT = 8000;
const ROOT_CA = () => fs.readFileSync(process.env.HUE_ROOT_CA || path.join(__dirname, 'hue-root-ca.pem'));
let rootCa = null;

// Remembered certificates, by bridge address, next to Photon's settings.
const PINS_FILE = () => path.join(path.dirname(process.env.CONFIG_PATH || path.join(__dirname, '..', '..', 'data', 'config.json')), 'hue-bridges.json');
let pins = null;
function loadPins() {
  if (pins) return pins;
  try { pins = JSON.parse(fs.readFileSync(PINS_FILE(), 'utf8')); } catch { pins = {}; }
  return pins;
}
function savePin(host, fp) {
  loadPins();
  if (fp) pins[host] = fp; else delete pins[host];
  try { fs.writeFileSync(PINS_FILE(), JSON.stringify(pins, null, 2), { mode: 0o600 }); } catch { /* kept in memory */ }
}

const plainOnly = new Set(); // bridges that have only ever answered on HTTP

function parse(address) {
  const a = String(address || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!a) throw new Error('Enter the bridge IP first');
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(a);
  return { key: a, host: m[1], port: m[2] ? Number(m[2]) : null };
}

const certError = host => new Error(`The Hue bridge at ${host} answered with a different certificate than before. If you replaced or reset the bridge, click "Pair" (press the bridge button first) so Photon trusts the new one.`);

// Opens a TLS connection and checks the certificate before anything is sent on it.
function secure(b) {
  return new Promise((resolve, reject) => {
    rootCa = rootCa || ROOT_CA();
    // A bridge's certificate is issued to its bridge ID, not its IP address, so the usual name
    // check would always fail: only whether it chains to a Hue root counts.
    const sock = tls.connect({ host: b.host, port: b.port || 443, ca: rootCa, rejectUnauthorized: false, checkServerIdentity: () => undefined });
    const timer = setTimeout(() => sock.destroy(Object.assign(new Error(`no response from the Hue bridge at ${b.host}`), { code: 'ETIMEDOUT' })), TIMEOUT);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const fp = sock.getPeerCertificate()?.fingerprint256 || '';
      const pinned = loadPins()[b.key];
      if (sock.authorized) {
        // Signed by Signify's Hue root: trusted, and remembered in case Photon sees it again.
        if (pinned !== fp) savePin(b.key, fp);
      } else if (!pinned) {
        savePin(b.key, fp); // first time: remember it
      } else if (pinned !== fp) {
        sock.destroy();
        reject(Object.assign(certError(b.host), { code: 'ECERTCHANGED' }));
        return;
      }
      resolve(sock);
    });
    sock.once('error', err => { clearTimeout(timer); reject(err); });
  });
}

function send(b, sock, method, apiPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: b.host, port: b.port || (sock ? 443 : 80), method, path: `/api${apiPath}`, timeout: TIMEOUT,
      ...(sock ? { createConnection: () => sock } : {}),
      headers: {
        Host: b.port ? `${b.host}:${b.port}` : b.host, Accept: 'application/json', Connection: 'close',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; if (text.length > 5e6) res.destroy(); });
      res.on('end', () => {
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error(`the Hue bridge answered ${res.statusCode}`), { status: res.statusCode }));
          return;
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no response from the Hue bridge at ${b.host}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// True when the other end isn't speaking TLS at all (an HTTP-only bridge or older firmware).
const notTls = err => err && (err.code === 'EPROTO' || err.code === 'ECONNRESET' || /wrong version number|packet length too long|unknown protocol/i.test(err.message || ''));

function friendly(err, b) {
  if (err.code === 'ECERTCHANGED') return err;
  if (err.code === 'ECONNREFUSED') return new Error(`connection refused reaching the Hue bridge at ${b.host}`);
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return new Error(`host unreachable: the Hue bridge at ${b.host}`);
  if (err.code === 'ETIMEDOUT') return new Error(`no response from the Hue bridge at ${b.host}`);
  return err;
}

// method and apiPath like ('GET', '/<appkey>/lights'). Returns the parsed JSON.
async function request(address, method, apiPath, body) {
  const b = parse(address);
  if (!plainOnly.has(b.key)) {
    let sock;
    try {
      sock = await secure(b);
    } catch (err) {
      // Fall back to HTTP only for a bridge that has never answered on HTTPS: refused on the
      // standard port, or a port that doesn't speak TLS at all.
      const neverSecure = !loadPins()[b.key];
      const refusedDefault = err.code === 'ECONNREFUSED' && !b.port;
      if (!(neverSecure && (refusedDefault || notTls(err)))) {
        if (!neverSecure && (notTls(err) || err.code === 'ECONNREFUSED')) {
          throw new Error(`The Hue bridge at ${b.host} stopped answering on HTTPS, which it used before. Photon won't fall back to an unencrypted connection. Check the bridge's address, or if you replaced the bridge, click "Pair".`);
        }
        throw friendly(err, b);
      }
      plainOnly.add(b.key);
    }
    if (sock) {
      try { return await send(b, sock, method, apiPath, body); } catch (err) { throw friendly(err, b); }
    }
  }
  try {
    return await send(b, null, method, apiPath, body);
  } catch (err) {
    plainOnly.delete(b.key); // try HTTPS again next time, in case the bridge was updated
    throw friendly(err, b);
  }
}

// Forget what Photon knows about a bridge's connection, so the next contact trusts it afresh.
// Used when pairing, since pressing the bridge's button proves it's the right bridge.
function forget(address) {
  try {
    const b = parse(address);
    savePin(b.key, null);
    plainOnly.delete(b.key);
  } catch { /* nothing to forget */ }
}

module.exports = { request, forget, _reset() { pins = null; plainOnly.clear(); rootCa = null; } };
