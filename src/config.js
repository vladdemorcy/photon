'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lighting = require('./lighting');
const media = require('./media');
const { newId } = require('./util');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '..', 'data', 'config.json');
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const EVENTS = ['play', 'pause', 'resume', 'scrobble', 'stop'];
const MEDIA_TYPES = ['movie', 'episode', 'music', 'other'];

const DEFAULT_ACTION = {
  type: 'state',     // state | off | scene | restore | none
  brightness: 30,    // percent
  colorMode: 'keep', // keep | temp | color | random
  randomEach: false, // random: a different color for each light
  palette: [],       // random: pick from these colors (empty means any color)
  kelvin: 2700,
  color: '#ff8a3d',
  scene: '',         // "<provider>::<sceneId>"
  transition: 1,     // seconds
};

let config = null;
const arr = v => (Array.isArray(v) ? v : []);
const numOr = (v, d) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));

function normalizeRule(r = {}) {
  const s = r.schedule || {};
  return {
    id: r.id || newId(),
    name: String(r.name || 'Behavior'),
    enabled: r.enabled !== false,
    events: arr(r.events).filter(e => EVENTS.includes(e)),
    schedule: {
      enabled: Boolean(s.enabled),
      from: String(s.from || 'sunset'),
      to: String(s.to || 'sunrise'),
      days: (Array.isArray(s.days) ? s.days : ALL_DAYS).map(Number).filter(d => d >= 0 && d <= 6),
    },
    action: normalizeAction(r.action),
  };
}

function normalizeAction(a = {}) {
  const out = { ...DEFAULT_ACTION, ...a };
  out.randomEach = Boolean(out.randomEach);
  out.palette = arr(out.palette).filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 12);
  return out;
}

function normalizeRoom(r = {}) {
  return {
    id: r.id || newId(),
    name: String(r.name || 'New room'),
    enabled: r.enabled !== false,
    players: arr(r.players).map(String),       // "<source>:<playerId>"
    // Names of those players, so a cast device that shows up under a new ID still matches.
    playerNames: Object.fromEntries(Object.entries(r.playerNames || {}).filter(([k, v]) => typeof v === 'string' && v && arr(r.players).includes(k)).map(([k, v]) => [k, v.slice(0, 80)])),
    users: arr(r.users).map(String).filter(Boolean),
    mediaTypes: arr(r.mediaTypes).filter(t => MEDIA_TYPES.includes(t)),
    targets: arr(r.targets).map(String),       // "<provider>::<targetId>"
    snapshotOnPlay: r.snapshotOnPlay !== false,
    stopDelaySeconds: numOr(r.stopDelaySeconds, 10),
    rules: arr(r.rules).map(normalizeRule),
    layout: normalizeLayout(r.layout, arr(r.targets).map(String)),
  };
}

// Floor plan, in feet. x runs left to right, y runs from the back wall forward,
// h is mounting height. Items are keyed by light (a group in the room shows each
// of its member lights, so keys can be member lights too). Furniture is a list.
const SHAPES = ['bulb', 'lamp', 'strip', 'panel'];
const FURNITURE_KINDS = ['tv', 'screen', 'tvstand', 'sofa', 'sectional', 'loveseat', 'armchair', 'coffeetable', 'sidetable',
  'bed', 'kingbed', 'nightstand', 'dresser', 'desk', 'chair', 'diningtable', 'bookshelf', 'rug', 'plant', 'door', 'window',
  'pergola', 'gazebo', 'fence', 'railing', 'deck', 'patio', 'path', 'housewall', 'shed',
  'pool', 'hottub', 'firepit', 'patiotable', 'lounger', 'outdoorsofa', 'grill', 'tree', 'shrub', 'hedge', 'gardenbed'];

function normalizeLayout(l = {}, targets = []) {
  // Outdoor spaces (a yard, patio or deck) have no walls or ceiling and can be much bigger.
  const outdoor = l.outdoor === true;
  const maxSide = outdoor ? 200 : 60;
  const width = clampNum(l.width, 6, maxSide, 16);
  const depth = clampNum(l.depth, 6, maxSide, 13);
  const height = clampNum(l.height, 7, outdoor ? 40 : 20, 9);
  const items = {};
  const keys = new Set([...Object.keys(l.items || {}), ...targets]);
  [...keys].forEach((key, i) => {
    const it = l.items?.[key] || {};
    const angle = (i / Math.max(1, keys.size)) * Math.PI * 2;
    items[key] = {
      x: clampNum(it.x, 0, width, width / 2 + Math.cos(angle) * width * 0.32),
      y: clampNum(it.y, 0, depth, depth / 2 + Math.sin(angle) * depth * 0.32),
      h: clampNum(it.h, 0, height, 5),
      shape: SHAPES.includes(it.shape) ? it.shape : undefined,
      len: clampNum(it.len, 1, 120, 6),
      rot: clampNum(it.rot, -360, 360, 0),
    };
  });

  let furniture = Array.isArray(l.furniture) ? l.furniture : null;
  if (!furniture) { // older layouts had a fixed TV and sofa
    furniture = [
      { kind: 'tv', x: l.tv?.x ?? width / 2, y: l.tv?.y ?? 0.4, w: 4.8, d: 0.4, rot: l.tv?.rot ?? 0 },
      { kind: 'sofa', x: l.sofa?.x ?? width / 2, y: l.sofa?.y ?? depth * 0.7, w: 7, d: 3, rot: l.sofa?.rot ?? 0 },
    ];
  }
  furniture = furniture.filter(f => FURNITURE_KINDS.includes(f.kind)).slice(0, 80).map(f => ({
    id: f.id || newId(),
    kind: f.kind,
    label: String(f.label || '').slice(0, 40),
    x: clampNum(f.x, 0, width, width / 2),
    y: clampNum(f.y, 0, depth, depth / 2),
    w: clampNum(f.w, 0.3, 120, 3),
    d: clampNum(f.d, 0.1, 120, 2),
    rot: clampNum(f.rot, -360, 360, 0),
  }));
  return { width, depth, height, outdoor, items, furniture };
}

function clampNum(v, lo, hi, d) {
  const n = Number(v);
  return v === '' || v == null || Number.isNaN(n) ? d : Math.min(hi, Math.max(lo, n));
}

const DEFAULT_COLORS = {
  hue: '#f5b301', govee: '#2ec4b6', lifx: '#ff5d8f', wiz: '#4cc9f0', nanoleaf: '#7bd389', dirigera: '#0a6fd6', tuya: '#ff7a3d', lutron: '#c9a227', homeassistant: '#5b8cff',
  plex: '#e5a00d', jellyfin: '#aa5cc3', emby: '#52b54b',
  roku: '#6f1ab1', lg: '#a50034', androidtv: '#3ddc84', cast: '#4285f4', vizio: '#8e97ab', samsung: '#1428a0',
};

function normalizeIntegrations(list, saved = {}) {
  const out = {};
  for (const p of list) {
    const cur = saved[p.id] || {};
    const o = { enabled: Boolean(cur.enabled) };
    for (const f of p.fields || []) o[f.key] = cur[f.key] ?? f.default ?? '';
    for (const [k, v] of Object.entries(cur)) if (!(k in o)) o[k] = v; // keep extra state like tokens
    out[p.id] = o;
  }
  return out;
}

function normalize(c = {}) {
  const loc = c.location || {};
  const coord = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    webhookToken: c.webhookToken || crypto.randomBytes(12).toString('hex'),
    location: { lat: coord(loc.lat), lon: coord(loc.lon) },
    lighting: normalizeIntegrations(lighting.providers, c.lighting),
    media: normalizeIntegrations(media.sources, c.media),
    rooms: arr(c.rooms).map(normalizeRoom),
    // Goes up by one with every edit saved from the app, so a page that is out of date
    // can be told instead of overwriting newer changes.
    editRev: Number.isInteger(c.editRev) && c.editRev >= 0 ? c.editRev : 0,
    hiddenPlayers: arr(c.hiddenPlayers).map(String).slice(0, 500),
    tls: {
      mode: ['off', 'generated', 'custom'].includes(c.tls?.mode) ? c.tls.mode : 'off',
      httpsPort: clampNum(c.tls?.httpsPort, 1, 65535, 8443),
      redirect: Boolean(c.tls?.redirect),
      extraNames: arr(c.tls?.extraNames).map(n => String(n).trim().toLowerCase()).filter(n => /^[a-z0-9.:*-]+$/.test(n)).slice(0, 20),
    },
    brandColors: Object.fromEntries(Object.entries(DEFAULT_COLORS).map(([k, d]) =>
      [k, /^#[0-9a-f]{6}$/i.test(c.brandColors?.[k] || '') ? c.brandColors[k] : d])),
  };
}

// ---- saving, with automatic backups -----------------------------------------
const BACKUP_DIR = path.join(path.dirname(CONFIG_PATH), 'backups');
const KEEP_BACKUPS = 60;
const BACKUP_EVERY_MS = 10 * 60 * 1000;
let lastBackupAt = 0;

// Copy the config as it is on disk right now into data/backups.
function backup(reason = 'auto') {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `config-${stamp}-${reason}.json`;
    fs.copyFileSync(CONFIG_PATH, path.join(BACKUP_DIR, file));
    fs.chmodSync(path.join(BACKUP_DIR, file), 0o600);
    lastBackupAt = Date.now();
    const all = fs.readdirSync(BACKUP_DIR).filter(f => /^config-.*\.json$/.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, old));
    return file;
  } catch (err) {
    console.error(`Could not back up settings: ${err.message}`);
    return null;
  }
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => /^config-.*\.json$/.test(f)).sort().reverse().map(file => {
    const m = /^config-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-z-]+)\.json$/.exec(file);
    let rooms = [], unreadable = false;
    try { rooms = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, file), 'utf8')).rooms?.map(r => r.name) || []; } catch { unreadable = true; }
    return { file, time: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null, reason: m?.[6] || '', rooms, unreadable };
  });
}

function restoreBackup(file) {
  if (!/^config-[\w-]+\.json$/.test(file)) throw new Error('Unknown backup');
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) throw new Error('That backup no longer exists');
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  backup('before-restore');
  // Keep current sign-ins and HTTPS settings; bring back rooms, layouts and the rest.
  const cur = config;
  data.tls = cur.tls;
  data.webhookToken = cur.webhookToken;
  // Only keep the current Plex sign-in if there is one, so restoring never loses a working sign-in.
  if (data.media?.plex && cur.media.plex.token) Object.assign(data.media.plex, { token: cur.media.plex.token, account: cur.media.plex.account, clientId: cur.media.plex.clientId });
  data.editRev = cur.editRev + 1;
  return set(data);
}

// Bring in a config.json from another Photon (for example one that was run by hand before
// installing). Everything comes across, sign-ins and keys included, except HTTPS, whose
// certificate files belong to the other copy. The webhook key comes across too, so the
// address already set up in Plex, Jellyfin or Emby keeps working.
function importConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || (!data.rooms && !data.lighting && !data.media)) {
    throw new Error("That file doesn't look like Photon settings. Pick the config.json from the other Photon's data folder.");
  }
  backup('before-import');
  const cur = config;
  const next = { ...data, tls: cur.tls, editRev: cur.editRev + 1 };
  if (!next.webhookToken) next.webhookToken = cur.webhookToken;
  if (next.media?.plex && !next.media.plex.token && cur.media.plex.token) {
    Object.assign(next.media.plex, { token: cur.media.plex.token, account: cur.media.plex.account, clientId: cur.media.plex.clientId });
  }
  return set(next);
}

// When Photon can't read its settings file it must not write over it: that file holds
// everything you set up. In that case it runs on what it could recover and refuses to save.
let readOnly = null;
let recoveredFrom = null;
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function save() {
  if (readOnly) throw new Error(readOnly);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  if (Date.now() - lastBackupAt > BACKUP_EVERY_MS) backup('auto');
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

// Older installers left files in the settings folder with no usable permissions. The Windows
// service runs as SYSTEM, which may take ownership and reset them to inherit from the folder.
let repaired = null;
function repairPermissions() {
  if (process.platform !== 'win32' || repaired !== null) return false;
  const dir = path.dirname(CONFIG_PATH);
  const { spawnSync } = require('child_process');
  const run = (cmd, args) => spawnSync(cmd, args, { windowsHide: true, timeout: 60000, encoding: 'utf8' });
  const a = run('takeown.exe', ['/F', dir, '/R', '/A', '/D', 'Y']);
  const b = run('icacls.exe', [path.join(dir, '*'), '/reset', '/T', '/C', '/Q']);
  repaired = b.status === 0;
  console.error(`Reset permissions in ${dir}: takeown ${a.status}, icacls ${b.status}${b.status ? ` ${String(b.stdout || b.stderr).trim().slice(0, 300)}` : ''}`);
  return repaired;
}

function readConfigFile() {
  let raw = null, err = null;
  for (let i = 0; i < 5; i++) { // a virus scanner or backup tool can hold the file for a moment
    try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); err = null; break; } catch (e) { err = e; if (e.code === 'ENOENT') break; if (e.code === 'EPERM' || e.code === 'EACCES') break; sleepSync(300); }
  }
  return { raw, err };
}

function load() {
  let { raw, err } = readConfigFile();
  if ((err?.code === 'EPERM' || err?.code === 'EACCES') && repairPermissions()) ({ raw, err } = readConfigFile());
  if (err?.code === 'ENOENT') { // first run
    config = normalize({});
    save();
    return config;
  }
  if (raw !== null) {
    try {
      config = normalize(JSON.parse(raw));
      backup('startup'); // a copy from before this run, and before any upgrade changes it
      save();
      return config;
    } catch (e) { err = e; }
  }

  // The file is there but couldn't be read or makes no sense. Look for the newest backup that works.
  config = null;
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^config-.*\.json$/.test(f)).sort().reverse();
    for (const f of files) {
      try { const d = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8')); if (d && typeof d === 'object') { config = normalize(d); recoveredFrom = f; break; } } catch { /* try the next one */ }
    }
  } catch { /* no backups folder */ }

  if (raw !== null) {
    // Readable but damaged: keep the damaged file as a backup, then carry on with the best copy.
    console.error(`${CONFIG_PATH} is damaged (${err.message}). ${recoveredFrom ? `Using the backup ${recoveredFrom}.` : 'Starting fresh.'} The damaged file is kept in the backups folder.`);
    backup('unreadable');
    if (!config) config = normalize({});
    save();
    return config;
  }

  // Can't read it at all (usually permissions). Don't touch it.
  readOnly = `Photon can't read its settings file ${CONFIG_PATH} (${err.code || err.message}), so it won't save changes over it. `
    + 'This usually means Photon was started by a different Windows account than the Photon service. Restart the Photon service, or run the installer again.';
  console.error(readOnly);
  if (!config) config = normalize({});
  return config;
}

const status = () => ({ readOnly, recoveredFrom, permissionsRepaired: repaired });

const get = () => config;

function set(next) {
  if (readOnly) throw new Error(readOnly);
  config = normalize(next);
  save();
  return config;
}

// A sensible starting set of behaviors for a new room.
function defaultRules() {
  return [
    { name: 'Daytime: leave lights alone', enabled: false, events: ['play', 'pause', 'resume', 'scrobble', 'stop'],
      schedule: { enabled: true, from: 'sunrise', to: 'sunset-30', days: ALL_DAYS }, action: { type: 'none' } },
    { name: 'Playback starts: dim down', events: ['play'], action: { type: 'state', brightness: 8, colorMode: 'temp', kelvin: 2200, transition: 3 } },
    { name: 'Paused: bring lights up', events: ['pause'], action: { type: 'state', brightness: 45, colorMode: 'temp', kelvin: 2700, transition: 1 } },
    { name: 'Resumed: dim again', events: ['resume'], action: { type: 'state', brightness: 8, colorMode: 'temp', kelvin: 2200, transition: 2 } },
    { name: 'Credits rolling: ease up', enabled: false, events: ['scrobble'], action: { type: 'state', brightness: 30, colorMode: 'temp', kelvin: 2700, transition: 10 } },
    { name: 'Stopped: back to how it was', events: ['stop'], action: { type: 'restore', transition: 3 } },
  ].map(normalizeRule);
}

module.exports = { status, load, get, set, backup, listBackups, restoreBackup, importConfig, defaultRules, CONFIG_PATH, DEFAULT_ACTION, EVENTS, MEDIA_TYPES };
