'use strict';
// Writes THIRD-PARTY-NOTICES.md from package-lock.json and the installed packages, so the list of
// JavaScript packages Photon ships always matches what's really in it.
//   node installer/tools/notices.js           write the file
//   node installer/tools/notices.js --check   fail if the file is out of date (used on GitHub)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

const repoUrl = r => {
  const u = typeof r === 'string' ? r : r?.url || '';
  return u.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/');
};

// For packages that don't say in package.json, tell the common licenses apart by their text.
function fromFile(dir) {
  const f = (fs.readdirSync(dir).find(n => /^licen[cs]e/i.test(n)));
  if (!f) return '';
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  if (/Permission is hereby granted, free of charge/.test(t)) return 'MIT';
  if (/Redistribution and use in source and binary forms/.test(t)) return /Neither the name/.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/Permission to use, copy, modify, and\/or distribute/.test(t)) return 'ISC';
  return '';
}

const rows = [];
for (const [key, p] of Object.entries(lock.packages || {})) {
  if (!key || p.dev || p.devOptional) continue;
  const name = key.split('node_modules/').pop();
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(ROOT, key, 'package.json'), 'utf8')); } catch { /* not installed */ }
  const license = p.license || meta.license || (meta.licenses || []).map(l => l.type || l).join(' OR ') || fromFile(path.join(ROOT, key)) || 'see package';
  rows.push(`| ${name} | ${p.version} | ${license} | ${repoUrl(meta.repository) || meta.homepage || ''} |`);
}
rows.sort((a, b) => a.localeCompare(b));

const text = `# Third-party notices

Photon itself is Copyright (c) 2026 Vladimir Demorcy, all rights reserved (see [LICENSE](LICENSE)).
It includes the third-party components below, which stay under their own licenses. The full
license texts are in the [licenses](licenses) folder, and each JavaScript package also keeps its
own license file inside \`node_modules\`.

## Bundled with every version

| Component | License | Where it's used | License text |
|---|---|---|---|
| Sora font | SIL Open Font License 1.1 | Headings in the app | [licenses/Sora-OFL.txt](licenses/Sora-OFL.txt) |
| IBM Plex Sans font | SIL Open Font License 1.1 | Text in the app | [licenses/IBMPlexSans-OFL.txt](licenses/IBMPlexSans-OFL.txt) |
| Lutron Caseta pairing certificates, from [pylutron-caseta](https://github.com/gurumitts/pylutron-caseta) | Apache License 2.0 | \`src/lighting/lutron-certs.js\`, used to pair with a Caseta bridge | [licenses/pylutron-caseta-Apache-2.0.txt](licenses/pylutron-caseta-Apache-2.0.txt) |
| LG webOS registration manifest, from [aiowebostv](https://github.com/home-assistant-libs/aiowebostv) | Apache License 2.0 | \`src/media/tv/lg.js\`, used to pair with an LG TV | [licenses/aiowebostv-Apache-2.0.txt](licenses/aiowebostv-Apache-2.0.txt) |

## Windows installer only

| Component | License | Where it's used | License text |
|---|---|---|---|
| [WinSW](https://github.com/winsw/winsw) 2.12.0 | MIT | Runs Photon as a Windows service | [licenses/WinSW-MIT.txt](licenses/WinSW-MIT.txt) |

On Windows and Mac, Node.js isn't included in the installer: setup downloads it from nodejs.org if
it's missing, under Node.js's own license.

## Android app only

| Component | License | Where it's used | License text |
|---|---|---|---|
| Node.js 18.20.4 built for Android by [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) | MIT (Node.js and the libraries it includes, such as V8, libuv, OpenSSL and ICU, are under their own licenses, listed in the Node.js license file) | Runs Photon on the phone | [licenses/nodejs-mobile-LICENSE.txt](licenses/nodejs-mobile-LICENSE.txt), [licenses/Node.js-18.20.4-LICENSE.txt](licenses/Node.js-18.20.4-LICENSE.txt) |
| LLVM libc++ from the Android NDK | Apache License 2.0 with LLVM Exceptions | C++ library Node.js needs | [licenses/LLVM-Apache-2.0-with-LLVM-exception.txt](licenses/LLVM-Apache-2.0-with-LLVM-exception.txt) |

## JavaScript packages

These are installed from npm and shipped in every version. Where a package offers a choice of
licenses, Photon uses it under the first one listed (node-forge under BSD-3-Clause).

| Package | Version | License | Source |
|---|---|---|---|
${rows.join('\n')}
`;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) {
    console.error('THIRD-PARTY-NOTICES.md is out of date. Run: node installer/tools/notices.js');
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.md is up to date (${rows.length} packages)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`Wrote THIRD-PARTY-NOTICES.md (${rows.length} packages)`);
}
