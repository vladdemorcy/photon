'use strict';

// Starts Photon inside the Android app. The app runs this instead of src/server.js so the
// few Android differences are handled here and Photon itself stays the same everywhere.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Some Android versions don't let apps list network interfaces, which Photon uses to show
// its address and to tell Plex where to send webhooks. The app writes the phone's Wi-Fi
// addresses to a small file whenever the network changes; use those when the list is empty.
const NET_FILE = process.env.PHOTON_ANDROID_NET;
function androidAddresses() {
  try {
    const d = JSON.parse(fs.readFileSync(NET_FILE, 'utf8'));
    return (d.addresses || []).filter(a => a && a.address);
  } catch { return []; }
}
function netmask(bits) {
  const n = bits >= 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');
}
const realInterfaces = os.networkInterfaces.bind(os);
os.networkInterfaces = function networkInterfaces() {
  let list = {};
  try { list = realInterfaces() || {}; } catch { list = {}; }
  const hasLan = Object.values(list).flat().some(i => i && i.family === 'IPv4' && !i.internal);
  if (!hasLan) {
    const found = androidAddresses();
    if (found.length) {
      list.wlan0 = found.map(a => ({
        address: a.address, netmask: netmask(a.prefix || 24), family: 'IPv4',
        mac: '00:00:00:00:00:00', internal: false, cidr: `${a.address}/${a.prefix || 24}`,
      }));
    }
  }
  return list;
};

process.on('SIGTERM', () => process.exit(0));

console.log(`Starting Photon on Android (Node ${process.version}, ${process.arch})`);
require(path.join(__dirname, 'src', 'server.js'));
