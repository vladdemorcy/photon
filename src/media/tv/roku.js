'use strict';

// Roku TVs and players, through Roku's External Control Protocol on port 8060. No pairing.
// /query/media-player reports play, pause and stop for whatever app is playing.

const { http } = require('../../util');
const { makeTv, ssdp } = require('./common');

const port = () => Number(process.env.ROKU_PORT || 8060);
const base = host => (host.includes(':') ? `http://${host}` : `http://${host}:${port()}`);
const tag = (xml, t) => (new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(xml) || [])[1] || '';
const attr = (xml, el, a) => (new RegExp(`<${el}\\b[^>]*\\b${a}="([^"]*)"`, 'i').exec(xml) || [])[1] || '';
const ms = s => { const m = /([\d.]+)\s*ms/.exec(s || ''); return m ? Number(m[1]) : 0; };

const infoCache = new Map();
async function deviceInfo(host) {
  const hit = infoCache.get(host);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const xml = await http('GET', `${base(host)}/query/device-info`, { raw: true, timeout: 2500 });
  if (/<status>\s*error/i.test(xml) || !/<device-info/i.test(xml)) {
    const e = new Error('the Roku refused. On the Roku, set Settings > System > Advanced system settings > Control by mobile apps > Network access to "Default" or "Permissive".');
    e.auth = true; throw e;
  }
  const v = {
    id: tag(xml, 'serial-number') || tag(xml, 'device-id') || host,
    name: tag(xml, 'user-device-name') || tag(xml, 'friendly-device-name') || tag(xml, 'default-device-name') || 'Roku',
    product: `Roku ${tag(xml, 'is-tv') === 'true' ? 'TV' : 'player'}${tag(xml, 'model-name') ? `, ${tag(xml, 'model-name')}` : ''}`,
    power: tag(xml, 'power-mode'),
  };
  infoCache.set(host, { at: Date.now(), v });
  return v;
}

const LIMITED = 'this Roku is in "Limited" mode, which blocks reading what\'s playing. On the Roku, go to Settings > System > Advanced system settings > Control by mobile apps > Network access and choose "Default" (or "Permissive").';

async function probe(c, host) {
  const info = await deviceInfo(host);
  let xml;
  try {
    xml = await http('GET', `${base(host)}/query/media-player`, { raw: true, timeout: 2500 });
  } catch (err) {
    if (/limited mode|403/i.test(err.message)) throw Object.assign(new Error(LIMITED), { auth: true });
    throw err;
  }
  if (/limited mode/i.test(xml)) throw Object.assign(new Error(LIMITED), { auth: true });
  if (/<status>\s*error/i.test(xml)) { const e = new Error('the Roku refused. Set Control by mobile apps > Network access to "Default" or "Permissive".'); e.auth = true; throw e; }
  const st = attr(xml, 'player', 'state');
  const app = attr(xml, 'plugin', 'name');
  const state = ['play', 'buffer'].includes(st) ? 'playing' : st === 'pause' ? 'paused' : 'idle';
  const runtime = ms(tag(xml, 'duration'));
  return { ...info, state, app, title: app || 'Roku', position: ms(tag(xml, 'position')), runtime, mediaType: tag(xml, 'is_live') === 'true' ? 'other' : undefined };
}

module.exports = makeTv({
  id: 'roku',
  label: 'Roku',
  short: 'Rokus',
  blurb: 'Roku TVs and streaming players report play, pause and stop for any app (Netflix, YouTube, Disney+ and the rest). No pairing needed. Newer Rokus block this until you set Settings > System > Advanced system settings > Control by mobile apps > Network access to "Default" (not "Limited").',
  async discover() {
    const list = await ssdp(['roku:ecp']);
    return Promise.all(list.map(async d => {
      const host = (/\/\/([^/]+)/.exec(d.location) || [])[1]?.replace(/:8060$/, '') || d.host;
      if (!/roku/i.test(`${d.st} ${d.usn} ${d.server}`)) return null;
      try { const i = await deviceInfo(host); return { host, name: i.name }; } catch { return { host }; }
    })).then(list => list.filter(Boolean));
  },
  describe: (c, host) => deviceInfo(host),
  probe,
});
