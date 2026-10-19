'use strict';

// HTTPS for Photon. Two ways to get a certificate:
//
//  - generated: Photon makes its own small certificate authority (valid 10 years) and
//    a server certificate signed by it. Browsers warn about any certificate they don't
//    trust, so you install the authority once on each device; after that every
//    certificate Photon issues (including renewals) is trusted with no warnings.
//  - custom: you upload your own certificate and key (PEM files, or a .pfx/.p12).
//
// Files live in data/tls with owner-only permissions.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const SERVER_DAYS = 397;       // stays under browser limits for server certificates
const RENEW_WITHIN_DAYS = 30;

function dir(configPath) {
  const d = path.join(path.dirname(configPath), 'tls');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const write = (file, data) => fs.writeFileSync(file, data, { mode: 0o600 });
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && !i.internal && (i.family === 'IPv4' || i.family === 4)).map(i => i.address);
}

// Every name this machine is likely to be reached by, plus any the person adds.
function defaultNames(extra = []) {
  const host = os.hostname().toLowerCase();
  const names = new Set(['localhost', '127.0.0.1', host, ...(host.includes('.') ? [] : [`${host}.local`]), ...lanAddresses(), ...extra]);
  return [...names].map(n => String(n).trim().toLowerCase()).filter(Boolean);
}

const isIp = n => /^\d{1,3}(\.\d{1,3}){3}$/.test(n) || n.includes(':');

function serial() {
  return `00${crypto.randomBytes(15).toString('hex')}`; // positive, 16 bytes
}

function makeCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: `Photon Local CA (${os.hostname()})` }, { name: 'organizationName', value: 'Photon' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

function makeServer(caPem, caKeyPem, names) {
  const ca = forge.pki.certificateFromPem(caPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
  cert.validity.notAfter = new Date(Date.now() + SERVER_DAYS * 24 * 3600 * 1000);
  cert.setSubject([{ name: 'commonName', value: names.find(n => !isIp(n)) || names[0] || 'photon' }, { name: 'organizationName', value: 'Photon' }]);
  cert.setIssuer(ca.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: names.map(n => (isIp(n) ? { type: 7, ip: n } : { type: 2, value: n })) },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

// Human-readable details of a PEM certificate.
function describe(pem) {
  if (!pem) return null;
  const x = new crypto.X509Certificate(pem);
  const sans = (x.subjectAltName || '').split(',').map(s => s.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean);
  const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1] || '';
  const issuer = /CN=([^\n,]+)/.exec(x.issuer)?.[1] || x.issuer;
  const validTo = new Date(x.validTo);
  return {
    subject: cn, issuer, names: sans.length ? sans : [cn],
    validFrom: new Date(x.validFrom).toISOString(), validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo - Date.now()) / 86400000),
    selfSigned: x.issuer === x.subject,
    fingerprint: x.fingerprint256,
  };
}

// Split a PEM bundle into its certificates.
const pemCerts = text => String(text || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];

function pfxToPem(base64, passphrase = '') {
  let p12;
  try {
    const der = forge.util.decode64(base64);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), passphrase);
  } catch (err) {
    throw new Error(/password|MAC|Invalid/i.test(err.message) ? 'The .pfx password is wrong, or the file is damaged.' : `Could not read the .pfx file (${err.message})`);
  }
  const keyBag = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0]
    || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBag?.key) throw new Error('The .pfx file has no private key in it.');
  if (!certBags.length) throw new Error('The .pfx file has no certificate in it.');
  const certs = certBags.map(b => forge.pki.certificateToPem(b.cert));
  return { cert: certs.join(''), key: forge.pki.privateKeyToPem(keyBag.key) };
}

// Check an uploaded certificate and key. Returns PEM text ready to save.
function validateCustom({ cert, key, chain, pfx, passphrase }) {
  if (pfx) ({ cert, key } = pfxToPem(pfx, passphrase));
  const certs = [...pemCerts(cert), ...pemCerts(chain)];
  if (!certs.length) throw new Error('That certificate file isn\'t in PEM format. It should start with "-----BEGIN CERTIFICATE-----". A .pfx or .p12 file works too.');
  if (!key || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
    throw new Error(/ENCRYPTED/.test(key || '') ? 'The private key is password protected. Upload an unencrypted key, or use a .pfx with its password.' : 'The private key file isn\'t in PEM format. It should start with "-----BEGIN PRIVATE KEY-----".');
  }
  let leaf;
  let pkey;
  try { leaf = new crypto.X509Certificate(certs[0]); } catch { throw new Error('The certificate could not be read.'); }
  try { pkey = crypto.createPrivateKey(key); } catch { throw new Error('The private key could not be read.'); }
  if (!leaf.checkPrivateKey(pkey)) throw new Error('This private key doesn\'t belong to this certificate.');
  const info = describe(certs[0]);
  if (info.daysLeft < 0) throw new Error(`This certificate expired on ${info.validTo.slice(0, 10)}.`);
  return { cert: certs.join('\n'), key: pkey.export({ type: 'pkcs8', format: 'pem' }), info };
}

function create(configPath) {
  const d = dir(configPath);
  const f = name => path.join(d, name);

  // Make sure the generated certificate exists, covers `names`, and isn't close to expiring.
  function ensureGenerated(extraNames = [], force = false) {
    let caPem = read(f('ca.crt'));
    let caKey = read(f('ca.key'));
    if (!caPem || !caKey) {
      ({ cert: caPem, key: caKey } = makeCa());
      write(f('ca.crt'), caPem);
      write(f('ca.key'), caKey);
    }
    const names = defaultNames(extraNames);
    const cur = read(f('server.crt'));
    const info = cur ? describe(cur) : null;
    const covers = info && names.every(n => info.names.includes(n));
    if (force || !info || !covers || info.daysLeft < RENEW_WITHIN_DAYS) {
      const s = makeServer(caPem, caKey, names);
      write(f('server.crt'), s.cert + caPem); // send the chain so clients can link it to the authority
      write(f('server.key'), s.key);
      return { renewed: true };
    }
    return { renewed: false };
  }

  function saveCustom(input) {
    const v = validateCustom(input);
    write(f('custom.crt'), v.cert);
    write(f('custom.key'), v.key);
    return v.info;
  }

  // TLS options for the current mode, or null when HTTPS is off.
  function options(tlsCfg) {
    if (process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) {
      return { cert: fs.readFileSync(process.env.TLS_CERT_FILE), key: fs.readFileSync(process.env.TLS_KEY_FILE), source: 'env' };
    }
    if (tlsCfg.mode === 'generated') {
      ensureGenerated(tlsCfg.extraNames);
      return { cert: read(f('server.crt')), key: read(f('server.key')), source: 'generated' };
    }
    if (tlsCfg.mode === 'custom') {
      const cert = read(f('custom.crt'));
      const key = read(f('custom.key'));
      if (!cert || !key) return null;
      return { cert, key, source: 'custom' };
    }
    return null;
  }

  function status(tlsCfg) {
    const pick = tlsCfg.mode === 'custom' ? 'custom.crt' : 'server.crt';
    const envCert = process.env.TLS_CERT_FILE && fs.existsSync(process.env.TLS_CERT_FILE) ? fs.readFileSync(process.env.TLS_CERT_FILE, 'utf8') : null;
    const pem = envCert || (tlsCfg.mode === 'off' ? null : read(f(pick)));
    return {
      fromEnv: Boolean(envCert),
      cert: pem ? describe(pemCerts(pem)[0]) : null,
      ca: read(f('ca.crt')) ? describe(read(f('ca.crt'))) : null,
      suggestedNames: defaultNames([]),
      hasCustom: Boolean(read(f('custom.crt'))),
    };
  }

  const caPem = () => read(f('ca.crt'));

  return { ensureGenerated, saveCustom, options, status, caPem, removeCustom: () => { for (const n of ['custom.crt', 'custom.key']) if (fs.existsSync(f(n))) fs.unlinkSync(f(n)); } };
}

module.exports = { create, validateCustom, describe, defaultNames };
