'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 6000;

// fetch with a timeout and JSON handling. Throws with a readable message.
async function http(method, url, { body, headers = {}, timeout = TIMEOUT_MS, raw = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = text;
    if (!raw) { try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ } }
    if (!res.ok) {
      const detail = typeof data === 'object' && data ? (data.message || data.msg || data.error || JSON.stringify(data)) : String(text).slice(0, 200);
      const err = new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`no response from ${new URL(url).host}`);
    const code = err.cause?.code || err.cause?.errors?.[0]?.code;
    if (code) throw new Error(`${code === 'ECONNREFUSED' ? 'connection refused' : code === 'ENOTFOUND' ? 'address not found' : code === 'EHOSTUNREACH' ? 'host unreachable' : code} reaching ${new URL(url).host}`);
    if (err.message === 'fetch failed') throw new Error(`could not reach ${new URL(url).host}`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgbToHex = ([r, g, b]) => `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// sRGB to CIE xy (what Hue wants for color).
function rgbToXy([r, g, b]) {
  const lin = v => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
  [r, g, b] = [lin(r), lin(g), lin(b)];
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const s = X + Y + Z;
  return s === 0 ? [0.3227, 0.329] : [+(X / s).toFixed(4), +(Y / s).toFixed(4)];
}

// Approximate RGB for a color temperature, for devices that only take RGB.
function kelvinToRgb(k) {
  const t = Math.min(40000, Math.max(1000, k)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = v => Math.min(255, Math.max(0, Math.round(v)));
  return [c(r), c(g), c(b)];
}

// RGB to hue (0-360) and saturation (0-100), for Nanoleaf and LIFX.
function rgbToHs([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(((h * 60) + 360) % 360);
  return [h, max === 0 ? 0 : Math.round((d / max) * 100)];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const newId = () => crypto.randomBytes(6).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Best guess at a light's physical form from its product name, so strips draw as strips.
function guessShape(text) {
  const t = String(text || '').toLowerCase();
  if (/strip|gradient|tube|neon|rope|lightbar|play ?bar|beam|\bz\b|lifx z|signature/.test(t)) return 'strip';
  if (/panel|canvas|shapes|nanoleaf|tile|lines|elements|hexa|triangle/.test(t)) return 'panel';
  // Hue calls ordinary bulbs "color lamp" / "white ambiance lamp", so those stay bulbs.
  if (/(color|ambiance|white) lamp/.test(t)) return 'bulb';
  if (/\blamp\b|floor|bloom|iris|hue go|lantern/.test(t)) return 'lamp';
  return 'bulb';
}

// True for addresses on a home network (and loopback), false for internet addresses.
function isPrivateIp(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '').replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '');
  if (!a) return null;
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a);
  if (m) return Number(m[1]) >= 16 && Number(m[1]) <= 31;
  if (/^(::1|fe80:|fc|fd)/i.test(a)) return true;
  return false;
}

module.exports = { isPrivateIp, guessShape, http, hexToRgb, rgbToHex, rgbToXy, kelvinToRgb, rgbToHs, clamp, newId, sleep };
