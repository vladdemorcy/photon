'use strict';
// Checks that two Photons on the same network find each other and warn about it.
// Start two Photons (different ports and settings folders, both with this password), then:
//   node test/peers-test.js http://127.0.0.1:18821 http://127.0.0.1:18822 "the password"
const [a, b, password] = process.argv.slice(2);
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}`); if (!cond) failed++; };

async function signIn(base) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const get = async (base, cookie, p) => (await fetch(base + p, { headers: { Cookie: cookie } })).json();

(async () => {
  const ca = await signIn(a), cb = await signIn(b);
  let pa = [], pb = [];
  for (let i = 0; i < 20 && !(pa.length && pb.length); i++) {
    await new Promise(r => setTimeout(r, 1000));
    pa = await get(a, ca, '/api/peers'); pb = await get(b, cb, '/api/peers');
  }
  ok(pa.length >= 1 && pb.length >= 1, `each Photon hears the other (${pa.length}, ${pb.length})`);
  // Each lists the others but never itself, so A's list has B's ID (missing from B's list) and
  // the other way round. Other Photons on the same machine or network may be listed too.
  const ia = new Set(pa.map(p => p.id)), ib = new Set(pb.map(p => p.id));
  ok([...ia].some(x => !ib.has(x)) && [...ib].some(x => !ia.has(x)), 'each lists the other, not itself');
  ok(!JSON.stringify(pa).match(/token|key|password/i), 'the announcement holds no keys');
  const log = await get(a, ca, '/api/log');
  ok(log.some(l => /Another Photon is running/.test(l.msg)), 'the Activity log notes it');
  ok((await fetch(`${a}/api/peers`)).status === 401, 'the list needs signing in');
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
