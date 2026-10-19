'use strict';

// Samsung TVs (2016 and newer, Tizen). The TV's REST interface on port 8001 says whether the
// screen is on, but not whether something is playing, so "TV on" counts as playing and
// "TV off" as stopped. No pairing needed for this.

const { http } = require('../../util');
const { makeTv, ssdp } = require('./common');

const port = () => Number(process.env.SAMSUNG_PORT || 8001);
const base = host => (host.includes(':') ? `http://${host}` : `http://${host}:${port()}`);

async function read(host) {
  const r = await http('GET', `${base(host)}/api/v2/`, { timeout: 2500 });
  const d = r?.device || {};
  return { id: d.id || d.duid || host, name: d.name || r?.name || 'Samsung TV', product: `Samsung ${d.modelName || 'TV'}`, power: String(d.PowerState || 'on').toLowerCase() };
}

module.exports = makeTv({
  id: 'samsung',
  label: 'Samsung TV',
  short: 'Samsung TVs',
  blurb: 'Samsung TVs only say whether they are on, not what is playing. Photon treats the TV turning on as "playing" and turning off as "stopped". For real play and pause, cast to it or use Plex.',
  async discover() {
    const list = await ssdp(['urn:samsung.com:device:RemoteControlReceiver:1']);
    return [...new Map(list.map(d => [d.host, { host: d.host }])).values()];
  },
  describe: (c, host) => read(host),
  async probe(c, host) {
    const d = await read(host);
    return { ...d, state: d.power === 'on' ? 'playing' : 'off', title: 'Samsung TV on', mediaType: 'other' };
  },
});
