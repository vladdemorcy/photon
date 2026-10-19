#!/usr/bin/env node
'use strict';

// Sets or resets Photon's sign-in password from the command line. The installers use this,
// and it's how you get back in if you forget the password (it needs admin rights, because
// only admins can write Photon's settings folder).
//
//   node src/password.js set      choose a new password (asks, or reads one line from stdin)
//   node src/password.js reset    remove the password; Photon asks for a new one with a setup code
//   node src/password.js status
//
// Uses the same settings folder as Photon: CONFIG_PATH, or the default next to the app.

const path = require('path');
const { CONFIG_PATH } = require('./config');
const auth = require('./auth').create(path.dirname(CONFIG_PATH));

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', d => { data += d; });
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '').replace(/\r$/, '')));
      stdin.on('error', reject);
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let text = '';
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); resolve(text); return; }
        if (c === '\u0003') { stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') text = text.slice(0, -1); else text += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') {
    console.log(auth.hasPassword() ? 'Photon has a password.' : `Photon has no password yet. Setup code: ${auth.setupCode()}`);
    return;
  }
  if (cmd === 'reset') {
    auth.reset();
    console.log(`Photon's password is removed and everyone is signed out. Open Photon and choose a new one with this setup code: ${auth.setupCode()}`);
    return;
  }
  if (cmd === 'set') {
    const first = await readHidden('New Photon password: ');
    if (process.stdin.isTTY) {
      const again = await readHidden('Type it again: ');
      if (again !== first) { console.error('The two passwords are different. Nothing was changed.'); process.exit(1); }
    }
    const problem = auth.checkPolicy(first);
    if (problem) { console.error(problem); process.exit(1); }
    await auth.setPassword(first);
    auth.endAllSessions();
    console.log('Password set. Everyone who was signed in needs to sign in again.');
    return;
  }
  console.error('Use: node src/password.js set | reset | status');
  process.exit(2);
}

main().catch(err => { console.error(err.message); process.exit(1); });
