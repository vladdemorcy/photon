// Photon web UI. Plain ES modules, no build step.

import { FURNITURE, SCREEN_KINDS, OUTDOOR_GROUPS } from './furniture.js';

// Photon's Android app already keeps the page clear of the phone's status and navigation
// bars, so the page shouldn't add room for them again (photon.css, the in-app class).
if (window.PhotonAndroid) document.documentElement.classList.add('in-app');

const EV = { play: 'Starts playing', pause: 'Paused', resume: 'Resumes', scrobble: 'Near the end', stop: 'Stops' };
const EV_SHORT = { play: 'Starts', pause: 'Paused', resume: 'Resumes', scrobble: 'Near end', stop: 'Stops' };
const MEDIA_LABEL = { movie: 'Movies', episode: 'TV episodes', music: 'Music', other: 'Other (live TV, clips)' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE_LABEL = { light: 'Light', room: 'Room', zone: 'Zone', plug: 'Smart plug' };
const SHAPE_LABEL = { bulb: 'Bulb', lamp: 'Lamp', strip: 'Strip', panel: 'Panel' };

const S = {
  meta: null, config: null,
  targets: [], targetsLoaded: false, targetsLoading: false,
  players: [], playerErrors: [], playersLoaded: false,
  plex: { account: null, servers: [], homeUsers: [] },
  tls: null, tlsView: null, tlsMsg: null,
  status: [], preview: {}, log: [],
  view: 'rooms', roomId: null,
  stageMode: localGet('photon.stage') || 'plan', previewEvent: 'play',
  sel: null, // { type: 'light', key } or { type: 'furn', id }
  expanded: new Set(),
  openRule: null, openSys: null, results: {},
  drag: null,
  // Phones get a different arrangement: one room section at a time, and lights, furniture
  // and players in a panel that slides up from the bottom instead of a side column.
  mobile: false,
  roomTab: localGet('photon.roomTab') || 'layout', // layout | behaviors | players | settings
  sheet: null, // the bottom panel on phones: lights | furniture | players
};

const app = document.getElementById('app');
let view3d = null;

// Phones, and tablets used by touch, which have the same trouble dragging across a long page.
const phoneQuery = window.matchMedia('(max-width: 820px), (max-width: 1180px) and (pointer: coarse)');
S.mobile = phoneQuery.matches;
phoneQuery.addEventListener('change', () => {
  S.mobile = phoneQuery.matches;
  S.sheet = null;
  if (S.config) render();
});

// ---------------------------------------------------------------------------
// helpers
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(16).slice(2, 14);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = v => Math.round(v * 10) / 10;
const pctX = (x, L) => `${(x / L.width) * 100}%`;
const pctY = (y, L) => `${(y / L.depth) * 100}%`;

// Changes carry the session's CSRF token, which only this page has (see src/auth.js).
function apiHeaders(method, hasBody) {
  const h = hasBody ? { 'Content-Type': 'application/json' } : {};
  if (method !== 'GET' && S.csrf) h['X-Photon-CSRF'] = S.csrf;
  return h;
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: apiHeaders(method, Boolean(body)), body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn) {
    // Signed out on this device (expired, or signed out everywhere from another one).
    showAuth(data.setup ? 'setup' : 'login', { expired: true });
    throw new Error(data.error || 'Sign in to Photon first.');
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// A saved key or token: Photon keeps it on the server and only says that it's there.
const SAVED = '__photon_saved__';

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 6000 : 3200);
}

function kelvinToRgb(k) {
  const t = clamp(k, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; } else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.52 * Math.log(t - 10) - 305.04;
  return [r, g, b].map(v => clamp(Math.round(v), 0, 255));
}
const hexToRgb = h => { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbCss = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// Random colors for previews. Kept stable until you press the event again or Shuffle,
// so the plan doesn't flicker while you edit.
const randomCache = new Map();
function randomRgb(palette = []) {
  if (palette.length) return hexToRgb(palette[Math.floor(Math.random() * palette.length)]);
  const h = Math.random() * 360;
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (1 - 0.9 * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}
function randomFor(action, slot) {
  const k = `${JSON.stringify(action.palette || [])}|${slot}`;
  if (!randomCache.has(k)) randomCache.set(k, randomRgb(action.palette));
  return randomCache.get(k);
}
// The color a given light shows for a look.
const lightRgb = (lk, key) => (lk.random && lk.each ? randomFor(lk.action, key) : lk.rgb);

// What a behavior's action looks like, for swatches, the plan glow and the 3D view.
function look(action) {
  if (!action) return { rgb: [255, 226, 184], level: 0.55, label: 'No behavior: lights stay as they are', kind: 'none' };
  switch (action.type) {
    case 'off': return { rgb: [20, 24, 40], level: 0, label: 'Lights off', kind: 'off' };
    case 'none': return { rgb: [255, 226, 184], level: 0.55, label: 'Lights left alone', kind: 'none' };
    case 'restore': return { rgb: [255, 226, 184], level: 0.6, label: 'Back to how they were before playback', kind: 'restore' };
    case 'scene': return { rgb: [170, 160, 255], level: 0.65, label: `Scene: ${sceneName(action.scene) || 'not picked yet'}`, kind: 'scene' };
    default: {
      if (action.colorMode === 'random') {
        return { rgb: randomFor(action, 'all'), level: clamp(action.brightness / 100, 0.01, 1), kind: 'state', random: true, each: action.randomEach, action,
          label: `${action.brightness}%, a random ${action.palette?.length ? 'pick from your colors' : 'color'}${action.randomEach ? ' for each light' : ''} every time` };
      }
      const rgb = action.colorMode === 'temp' ? kelvinToRgb(action.kelvin) : action.colorMode === 'color' ? hexToRgb(action.color) : [255, 226, 184];
      const extra = action.colorMode === 'temp' ? `, ${action.kelvin}K` : action.colorMode === 'color' ? ', color' : '';
      return { rgb, level: clamp(action.brightness / 100, 0.01, 1), label: `${action.brightness}%${extra}`, kind: 'state' };
    }
  }
}

function brandColor(id) { return S.config?.brandColors?.[id] || '#8e98bc'; }
function providerLabel(id) { return S.meta?.lighting.find(p => p.id === id)?.label || S.meta?.media.find(m => m.id === id)?.label || id; }
function splitKey(key) { const i = key.indexOf('::'); return [key.slice(0, i), key.slice(i + 2)]; }
function findTarget(key) {
  const [pid, tid] = splitKey(key);
  return S.targets.find(p => p.id === pid)?.targets.find(x => x.id === tid) || null;
}
function targetInfo(key) {
  const [pid, tid] = splitKey(key);
  const t = findTarget(key);
  return {
    pid, tid, name: t?.name || tid, type: t?.type || 'light', detail: t?.detail || '', known: Boolean(t),
    shape: t?.shape || 'bulb', members: (t?.members || []).map(m => `${pid}::${m}`),
  };
}
function sceneName(key) {
  if (!key) return '';
  const [pid, sid] = splitKey(key);
  return S.targets.find(p => p.id === pid)?.scenes.find(s => s.id === sid)?.name || sid;
}
function playerInfo(key) {
  const i = key.indexOf(':');
  const source = key.slice(0, i);
  const id = key.slice(i + 1);
  const p = S.players.find(x => x.key === key);
  return { source, id, name: p?.name || id, product: p?.product || '', user: p?.user || '' };
}
const room = () => S.config.rooms.find(r => r.id === S.roomId);

// The individual lights a room shows on its plan. A group in the room shows each of
// its member lights (positioned on their own) but is still controlled as one group.
function planLights(r) {
  const out = [];
  for (const key of r.targets) {
    const t = targetInfo(key);
    if (t.members.length) for (const m of t.members) out.push({ key: m, group: key });
    else out.push({ key, group: null });
  }
  return out;
}

function itemFor(r, key) {
  const L = r.layout;
  if (!L.items[key]) {
    const t = targetInfo(key);
    // A light from a group that was placed as one marker (older Photon versions) starts
    // around where that marker was, instead of in the middle of the room.
    const groupKey = r.targets.find(k => L.items[k] && targetInfo(k).members.includes(key));
    if (groupKey) {
      const g = L.items[groupKey];
      const members = targetInfo(groupKey).members;
      const i = members.indexOf(key);
      const angle = (i / members.length) * Math.PI * 2;
      L.items[key] = { x: round1(clamp(g.x + Math.cos(angle) * 1.2, 0, L.width)), y: round1(clamp(g.y + Math.sin(angle) * 1.2, 0, L.depth)), h: g.h ?? 5, shape: t.shape, len: 6, rot: 0 };
      return L.items[key];
    }
    // Spread unplaced lights out a little so they don't stack on top of each other.
    let hsh = 0;
    for (const ch of key) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    L.items[key] = {
      x: round1(clamp(L.width / 2 + ((hsh % 7) - 3) * 1.4, 0, L.width)),
      y: round1(clamp(L.depth / 2 + (((hsh >> 3) % 5) - 2) * 1.4, 0, L.depth)),
      h: t.shape === 'strip' ? 3 : 5, shape: t.shape, len: 6, rot: 0,
    };
  }
  const it = L.items[key];
  if (!it.shape) it.shape = targetInfo(key).shape;
  if (!it.len) it.len = 6;
  if (it.rot == null) it.rot = 0;
  return it;
}

// Where a light already is in this room: directly, or as part of a group.
function coverage(r, key) {
  if (r.targets.includes(key)) return 'In room';
  for (const tk of r.targets) {
    const t = targetInfo(tk);
    if (!t.members.length) continue;
    const mine = targetInfo(key);
    const covered = mine.members.length ? mine.members.every(m => t.members.includes(m)) : t.members.includes(key);
    if (covered) return `In ${t.name}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// saving
// Every save carries the edit number the page loaded. If another window or device saved
// in between, the server says so instead of letting this page overwrite newer changes.
let saveTimer = null;
let saving = Promise.resolve();
let retryTimer = null;
let shownWarnings = new Set();
S.dirty = false;
S.pointerActive = false;

function setSaveState(text, err = false) {
  const el = $('#saveState');
  el.textContent = text;
  el.classList.toggle('err', err);
  el.classList.toggle('quiet', text === 'All changes saved'); // phones only show it while something is happening
}

async function saveNow() {
  const body = JSON.stringify(S.config);
  const res = await fetch('/api/config', { method: 'PUT', headers: apiHeaders('PUT', true), body, credentials: 'same-origin' });
  if (res.status === 401) { showAuth('login', { expired: true }); throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function commit(delay = 500) {
  S.dirty = true;
  setSaveState('Saving…');
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving = saving.then(async () => {
      if (saveTimer) return; // a newer change is queued and will save everything
      try {
        const { res, data } = await saveNow();
        if (res.status === 409) {
          S.config = data.config;
          S.dirty = false;
          setSaveState('Reloaded the latest version');
          toast('Photon was changed in another window or on another device, so this page loaded that newer version. Your last change here was not applied, so make it again if you still want it.', true);
          render();
          return;
        }
        if (!res.ok) {
          // A rejected save: say why, keep the change on screen, don't retry blindly.
          setSaveState(`Not saved: ${data.error || res.statusText}`, true);
          toast(data.error || `Could not save (${res.status})`, true);
          return;
        }
        S.config.editRev = data.editRev;
        if (!saveTimer) S.dirty = false;
        setSaveState('All changes saved');
        for (const w of data.warnings || []) if (!shownWarnings.has(w)) { shownWarnings.add(w); toast(w, true); }
        if (!data.warnings?.length) shownWarnings = new Set();
        refreshPreview();
      } catch {
        // Photon restarting or the network dropped: keep the change and try again.
        setSaveState('Not saved yet, trying again…', true);
        retryTimer = setTimeout(() => commit(0), 3000);
      }
    });
  }, delay);
}

// Save right away if the page is being closed or hidden with a change still waiting.
function flushOnLeave() {
  if (!S.dirty || !S.config) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fetch('/api/config', { method: 'PUT', headers: apiHeaders('PUT', true), body: JSON.stringify(S.config), keepalive: true, credentials: 'same-origin' });
  } catch { /* nothing more we can do here */ }
}
window.addEventListener('pagehide', flushOnLeave);
// Switching to another tab or app: the page is still alive, so do a normal save now.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) commit(0); });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// Pick up changes saved from another window or device, when this page isn't mid-edit.
async function syncFromServer() {
  if (S.dirty || S.pointerActive || saveTimer) return;
  const active = document.activeElement;
  if (active && active.matches?.('input, select, textarea') && active.closest('#app')) return;
  try {
    const { editRev } = await api('GET', '/api/config/rev');
    if (editRev === S.config.editRev || S.dirty) return;
    S.config = await api('GET', '/api/config');
    render();
    setSaveState('Updated with changes from another window');
  } catch { /* offline for a moment */ }
}

async function refreshPreview() {
  try { S.preview = await api('GET', '/api/preview'); } catch { return; }
  if (S.view === 'rooms' && room()) { updateStageNote(); updatePlanLook(); markActiveRules(); }
}

async function loadTargets(force = false) {
  if (S.targetsLoading || (S.targetsLoaded && !force)) return;
  S.targetsLoading = true;
  try { S.targets = await api('GET', '/api/targets'); S.targetsLoaded = true; } catch (err) { toast(err.message, true); }
  S.targetsLoading = false;
  if (S.view === 'rooms') render();
}
async function loadPlayers(force = false) {
  if (S.playersLoaded && !force) return;
  S.playersLoaded = true;
  try { const r = await api('GET', '/api/players'); S.players = r.players; S.playerErrors = r.errors; S.hiddenPlayers = r.hidden || 0; } catch { /* keep */ }
  if (S.view === 'rooms') render();
}
async function loadPlex() {
  try { S.plex = await api('GET', '/api/plex/info'); } catch { /* not signed in or offline */ }
}

// ---------------------------------------------------------------------------
// routing
function route() {
  if (!S.config) return; // signed out: the sign-in screen is showing
  const [view, id] = location.hash.replace(/^#/, '').split('/');
  S.view = ['rooms', 'connections', 'activity', 'settings'].includes(view) ? view : 'rooms';
  if (S.view === 'rooms') {
    const has = x => x && S.config.rooms.some(r => r.id === x);
    S.roomId = has(id) ? id : has(S.roomId) ? S.roomId : S.config.rooms[0]?.id || null;
    S.sel = null;
  }
  $$('.tabs a').forEach(a => a.setAttribute('aria-current', a.dataset.view === S.view ? 'page' : 'false'));
  $('#pageTitle').textContent = { rooms: 'Rooms', connections: 'Connections', activity: 'Activity', settings: 'Settings' }[S.view];
  render();
}
window.addEventListener('hashchange', route);

function render() {
  if (view3d && !(S.view === 'rooms' && S.stageMode === '3d')) { view3d.dispose(); view3d = null; }
  if (S.view !== 'rooms') { S.sheet = null; document.body.classList.remove('pop-open'); }
  document.body.classList.toggle('sheet-open', Boolean(S.mobile && S.sheet));
  if (S.view === 'connections') renderConnections();
  else if (S.view === 'settings') renderSettings();
  else if (S.view === 'activity') renderActivity();
  else renderRooms();
  settingsBanner();
}

// Shown when Photon can't read its settings file and so won't save (see config.load on the server).
function settingsBanner() {
  let el = $('#settingsProblem');
  const msg = S.meta?.settingsProblem;
  if (!msg) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'settingsProblem'; el.className = 'panel setup-strip'; el.style.cssText = 'margin:12px 16px 0;border-color:var(--bad)'; app.before(el); }
  el.innerHTML = `<span style="color:var(--bad)"><b>Changes aren't being saved.</b> ${esc(msg)}</span>`;
}

// ---------------------------------------------------------------------------
// setup progress
function progress() {
  const c = S.config;
  return {
    lights: Object.values(c.lighting).some(x => x.enabled),
    media: Object.values(c.media).some(x => x.enabled),
    rooms: c.rooms.length > 0,
  };
}

function welcomeHtml() {
  const p = progress();
  const step = (done, text, doneText, href, btn) => `
    <li class="${done ? 'done' : ''}"><span>${done ? doneText : text}</span><span class="spacer"></span>
      ${done ? '' : `<a class="btn ${btn ? 'primary' : ''}" href="${href}">${btn || 'Open'}</a>`}</li>`;
  return `
  <section class="panel welcome">
    <img src="photon-hero.png" alt="Photon" width="1100" height="314">
    <div>
      <h1>Lights that follow the movie</h1>
      <p class="muted">Photon dims, brightens and colors the lights in each room when something plays, pauses or stops on your media server. You choose what happens and when.</p>
      <ol class="steps">
        ${step(p.lights, 'Connect your lights', 'Lights connected', '#connections', 'Connect lights')}
        ${step(p.media, 'Connect your media server', 'Media server connected', '#connections', p.lights ? 'Connect media server' : '')}
        <li class="${p.rooms ? 'done' : ''}"><span>Create your first room</span><span class="spacer"></span>
          <button class="btn ${p.lights && p.media ? 'primary' : ''}" data-act="new-room">New room</button></li>
      </ol>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// ROOMS
function renderRooms() {
  const c = S.config;
  if (!c.rooms.length) {
    app.innerHTML = welcomeHtml();
    $('[data-act="new-room"]', app)?.addEventListener('click', newRoom);
    return;
  }
  loadTargets();
  loadPlayers();
  const r = room();
  const p = progress();
  app.innerHTML = `
    <div class="rooms-layout">
      <aside class="panel side" aria-label="Rooms">
        <h2>Rooms</h2>
        <ul class="room-list" id="roomList">${c.rooms.map(roomLink).join('')}</ul>
        <button class="btn new-room" data-act="new-room">New room</button>
      </aside>
      <div class="editor">
        ${!p.lights || !p.media ? `<div class="panel setup-strip"><span>${!p.lights ? 'No lighting system is connected yet.' : 'No media server is connected yet, so nothing will trigger these behaviors.'}</span><span class="spacer"></span><a class="btn primary sm" href="#connections">Open Connections</a></div>` : ''}
        ${editorHtml(r)}
      </div>
      ${S.mobile ? `<div class="sheet-backdrop" id="sheetBackdrop" ${S.sheet ? '' : 'hidden'}></div>` : ''}
      <aside class="panel library ${S.mobile ? 'sheet' : ''}" id="library" aria-label="Lights, furniture and players" ${S.mobile && !S.sheet ? 'hidden' : ''}>${libraryHtml(r)}</aside>
    </div>`;
  bindRooms(r);
}

function roomLink(r) {
  const st = S.status.find(s => s.id === r.id);
  const state = !r.enabled ? 'off' : st?.status === 'playing' ? 'playing' : st?.status === 'paused' ? 'paused' : 'idle';
  const label = { off: 'Off', playing: 'Playing', paused: 'Paused', idle: '' }[state];
  return `<li draggable="true" data-room="${r.id}"><a href="#rooms/${r.id}" aria-current="${r.id === S.roomId}">
    <span class="dot ${state}"></span><span class="rname">${esc(r.name)}</span><span class="state">${label}</span></a></li>`;
}

// A visible reminder when a room only reacts to some media or some people, since
// playback outside that is ignored on purpose.
function filterNoteHtml(r) {
  const media = r.mediaTypes.map(t => MEDIA_LABEL[t].replace(/ \(.*\)/, '')).join(', ');
  const people = r.users.join(', ');
  let text = '';
  if (media && people) text = `Only reacts to ${media}, played by ${people}`;
  else if (media) text = `Only reacts to ${media}`;
  else if (people) text = `Only reacts when ${people} plays`;
  if (!text) return '';
  return `<a class="filter-note" id="filterNote" href="#rooms/${r.id}" data-act="show-settings" title="Change in Room settings">${esc(text)}</a>`;
}

function nowPlayingHtml(r) {
  const st = S.status.find(s => s.id === r.id);
  if (!st || st.status === 'idle') return `<span class="now-playing" id="nowPlaying">Nothing playing</span>`;
  const word = { playing: 'Playing', paused: 'Paused', stopping: 'Stopping' }[st.status] || st.status;
  return `<span class="now-playing ${st.status === 'playing' ? 'playing' : ''}" id="nowPlaying"><span class="dot" style="--c:${st.status === 'playing' ? 'var(--cyan)' : 'var(--warn)'}"></span>${word}: ${esc(st.title || 'something')}</span>`;
}

function usersHtml(r) {
  const home = S.config.media.plex?.enabled ? S.plex.homeUsers || [] : [];
  const homeNames = home.map(u => u.title);
  const extra = r.users.filter(u => !homeNames.some(n => n.toLowerCase() === u.toLowerCase()));
  return `
    <div>
      <div class="small muted" style="margin-bottom:6px">Who can trigger this room</div>
      ${home.length ? `<div class="chips" id="homeUsers">
        <button class="chip" data-user="*" aria-pressed="${!r.users.length}">Everyone</button>
        ${home.map(u => `<button class="chip" data-user="${esc(u.title)}" aria-pressed="${r.users.some(x => x.toLowerCase() === u.title.toLowerCase())}">${esc(u.title)}</button>`).join('')}
      </div>` : ''}
      <label class="field" style="margin-top:8px"><span>${home.length ? 'Jellyfin or Emby user names (comma separated)' : 'Only these users (comma separated, empty means everyone)'}</span>
        <input id="roomUsers" value="${esc(extra.join(', '))}" placeholder="${home.length ? 'None' : 'Everyone'}"></label>
    </div>`;
}

// On phones a room shows one of these at a time.
const ROOM_TABS = [['layout', 'Layout'], ['behaviors', 'Behaviors'], ['players', 'Players'], ['settings', 'Settings']];
const paneAttr = name => `data-pane="${name}" ${S.mobile && S.roomTab !== name ? 'hidden' : ''}`;

function roomTabsHtml(r) {
  if (!S.mobile) return '';
  const count = { behaviors: r.rules.length, players: r.players.length };
  return `<nav class="room-tabs" role="tablist" aria-label="Room sections">
    ${ROOM_TABS.map(([k, label]) => `<button role="tab" data-room-tab="${k}" aria-selected="${S.roomTab === k}">${label}${count[k] != null ? `<span class="count">${count[k]}</span>` : ''}</button>`).join('')}
  </nav>`;
}

function editorHtml(r) {
  return `
    <div class="room-head">
      <input class="room-name" id="roomName" value="${esc(r.name)}" aria-label="Room name">
      <label class="switch"><input type="checkbox" id="roomEnabled" ${r.enabled ? 'checked' : ''}><i></i>${r.enabled ? 'On' : 'Off'}</label>
      ${nowPlayingHtml(r)}
      ${filterNoteHtml(r)}
    </div>
    ${roomTabsHtml(r)}

    <section class="panel stage" aria-label="Room layout" ${paneAttr('layout')}>
      <div class="stage-bar">
        <div class="seg" role="group" aria-label="View">
          <button data-stage="plan" aria-pressed="${S.stageMode === 'plan'}">Floor plan</button>
          <button data-stage="3d" aria-pressed="${S.stageMode === '3d'}">3D</button>
        </div>
        <span class="label">Show when it</span>
        <div class="seg" role="group" aria-label="Preview event">
          ${Object.keys(EV).map(e => `<button data-preview="${e}" aria-pressed="${S.previewEvent === e}">${EV_SHORT[e]}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        <button class="btn sm" data-act="simulate" title="Sends this event to the room as if your media server did, so your real lights change">Run on real lights</button>
      </div>
      <p class="stage-note" id="stageNote"></p>
      <div class="plan-wrap" id="planWrap">${S.stageMode === '3d' ? `<div class="three-host" id="threeHost"><span class="hint">${S.mobile ? 'Drag to turn, pinch to zoom.' : 'Drag to orbit, scroll to zoom.'} Arrange things on the floor plan.</span></div>` : planHtml(r)}</div>
      ${S.mobile ? '<button class="btn add-wide" data-open-sheet="lights">Add lights or furniture</button>' : ''}
    </section>

    <section class="panel" aria-label="Behaviors" ${paneAttr('behaviors')}>
      <div class="section-head" style="padding:14px 14px 0">
        <h2>Behaviors</h2>
        <p>When several match, the one nearest the top wins. ${S.mobile ? 'Open one to move it up or down.' : 'Drag to reorder.'}</p>
        <span class="spacer"></span>
        <button class="btn sm" data-act="add-rule">Add behavior</button>
      </div>
      <ul class="rules" id="rules">${r.rules.map(rule => ruleHtml(r, rule)).join('') || `<li class="empty-state">No behaviors yet. Add one to decide what the lights do.</li>`}</ul>
    </section>

    <div class="two-col">
      <section class="panel block" aria-label="Players" ${paneAttr('players')}>
        <h2>Players in this room</h2>
        <p class="muted small">${S.mobile ? 'The TVs, streaming boxes and apps in this room. Playback on them drives the lights here.' : "Drop the TVs, streaming boxes or apps that are in this room. Playback on them drives this room's lights."}</p>
        <div class="dropzone" id="playerZone">${r.players.map(k => playerChip(k)).join('') || `<span class="empty">${S.mobile ? 'No players yet.' : 'Drag a player here from the list'}</span>`}</div>
        ${S.mobile ? '<button class="btn add-wide" data-open-sheet="players">Add a player</button>' : ''}
        <details>
          <summary class="muted small" style="cursor:pointer">Add a player by its ID</summary>
          <div class="time-row" style="margin-top:8px">
            <select id="manualSource" style="width:auto">${S.meta.media.map(m => `<option value="${m.id}">${m.label}</option>`).join('')}</select>
            <input id="manualId" placeholder="Player or device ID" style="flex:1;width:auto">
            <button class="btn sm" data-act="manual-player">Add</button>
          </div>
        </details>
      </section>

      <section class="panel block" aria-label="Room settings" ${paneAttr('settings')}>
        <h2>Room settings</h2>
        <div class="settings-grid">
          <label class="field"><span>Width (ft)</span><input type="number" min="6" max="${r.layout.outdoor ? 200 : 60}" data-layout="width" value="${r.layout.width}"></label>
          <label class="field"><span>Depth (ft)</span><input type="number" min="6" max="${r.layout.outdoor ? 200 : 60}" data-layout="depth" value="${r.layout.depth}"></label>
          <label class="field"><span>${r.layout.outdoor ? 'Tallest light (ft)' : 'Ceiling (ft)'}</span><input type="number" min="7" max="${r.layout.outdoor ? 40 : 20}" data-layout="height" value="${r.layout.height}"></label>
        </div>
        <label class="switch"><input type="checkbox" id="outdoor" ${r.layout.outdoor ? 'checked' : ''}><i></i>Outdoor space (a yard, patio or deck: no walls or ceiling, and up to 200 ft across)</label>
        <div>
          <div class="small muted" style="margin-bottom:6px">React to (ticked ones change the lights, the rest are ignored)</div>
          <div class="chips checks" id="mediaTypes">
            ${S.meta.mediaTypes.map(t => `<button class="chip" data-mtype="${t}" aria-pressed="${!r.mediaTypes.length || r.mediaTypes.includes(t)}"><span class="tick" aria-hidden="true"></span>${MEDIA_LABEL[t]}</button>`).join('')}
          </div>
        </div>
        ${usersHtml(r)}
        <div class="settings-grid">
          <label class="field"><span>Wait after stop (s)</span><input type="number" min="0" max="120" id="stopDelay" value="${r.stopDelaySeconds}"></label>
        </div>
        <p class="muted small">The wait stops the lights jumping up between episodes when the next one starts on its own.</p>
        <label class="switch"><input type="checkbox" id="snapshot" ${r.snapshotOnPlay ? 'checked' : ''}><i></i>Remember how the lights were when playback starts</label>
        <div><button class="btn danger sm" data-act="delete-room">Delete room</button></div>
      </section>
    </div>`;
}

function playerChip(key) {
  const p = playerInfo(key);
  return `<span class="chip" aria-pressed="true" title="${esc(providerLabel(p.source))}${p.product ? `, ${esc(p.product)}` : ''}">
    <span class="dot" style="--c:${brandColor(p.source)}"></span>${esc(p.name)}
    <button class="x" data-remove-player="${esc(key)}" aria-label="Remove ${esc(p.name)}">×</button></span>`;
}

// ---- floor plan ----
function screensOn(r) {
  const st = S.status.find(s => s.id === r.id);
  return Boolean(st && st.status !== 'idle') || ['play', 'resume', 'scrobble'].includes(S.previewEvent);
}

// Pieces a light strip can run along, and the height it usually sits at on each.
const EDGE_KINDS = {
  fence: { h: f => 4.6, name: 'fence', line: true }, railing: { h: () => 3, name: 'railing', line: true },
  housewall: { h: () => 8.5, name: 'house wall', line: true }, hedge: { h: () => 0.4, name: 'hedge', line: true },
  pergola: { h: f => FURNITURE.pergola.ht, name: 'pergola' }, gazebo: { h: () => FURNITURE.gazebo.ht - 3, name: 'gazebo' },
  deck: { h: () => FURNITURE.deck.ht - 0.1, name: 'deck edge' }, patio: { h: () => 0.2, name: 'patio edge' },
  pool: { h: () => 0.3, name: 'pool edge' }, path: { h: () => 0.1, name: 'path' }, shed: { h: () => 7, name: 'shed' },
  gardenbed: { h: () => 1.1, name: 'garden bed' }, bookshelf: { h: () => 6, name: 'bookshelf' }, tvstand: { h: () => 0.2, name: 'TV stand' },
  bed: { h: () => 0.3, name: 'bed' }, kingbed: { h: () => 0.3, name: 'bed' },
};
function nearestEdge(L, it) {
  let best = null;
  for (const f of L.furniture) {
    const k = EDGE_KINDS[f.kind];
    if (!k) continue;
    const a = (f.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    // the piece's edges in its own frame: [center x, center y, length, turn]
    const edges = k.line ? [[0, 0, f.w, 0]] : [[0, -f.d / 2, f.w, 0], [0, f.d / 2, f.w, 0], [-f.w / 2, 0, f.d, 90], [f.w / 2, 0, f.d, 90]];
    for (const [ex, ey, len, turn] of edges) {
      const x = f.x + ex * cos - ey * sin, y = f.y + ex * sin + ey * cos;
      const dist = Math.hypot(x - it.x, y - it.y);
      if (!best || dist < best.dist) best = { dist, x, y, len, rot: ((f.rot || 0) + turn) % 360, h: k.h(f), name: k.name };
    }
  }
  return best && best.dist < Math.max(L.width, L.depth) * 0.6 ? best : null;
}

function furnitureHtml(r, f) {
  const L = r.layout;
  const def = FURNITURE[f.kind];
  const on = SCREEN_KINDS.includes(f.kind) && screensOn(r);
  const sel = S.sel?.type === 'furn' && S.sel.id === f.id;
  return `<div class="thing furn f-${f.kind} ${on ? 'on' : ''} ${sel ? 'sel' : ''}" data-thing="furn" data-id="${f.id}" tabindex="0" role="button"
    aria-label="${esc(f.label || def.label)}. Use arrow keys to move, R to rotate."
    style="left:${pctX(f.x, L)};top:${pctY(f.y, L)};width:${pctX(f.w, L)};height:${pctY(f.d, L)};transform:translate(-50%,-50%) rotate(${f.rot}deg)">
    <span>${esc(f.label || def.label)}</span></div>`;
}

function lightHtml(r, key, group) {
  const L = r.layout;
  const it = itemFor(r, key);
  const t = targetInfo(key);
  const sel = S.sel?.type === 'light' && S.sel.key === key;
  const isGroupMarker = !group && t.type !== 'light' && t.type !== 'plug';
  const style = [`left:${pctX(it.x, L)}`, `top:${pctY(it.y, L)}`, `--brand:${brandColor(t.pid)}`];
  if (it.shape === 'strip') style.push(`width:${pctX(it.len, L)}`, `transform:translate(-50%,-50%) rotate(${it.rot}deg)`);
  if (it.shape === 'panel') style.push(`transform:translate(-50%,-50%) rotate(${it.rot}deg)`);
  return `<div class="thing light s-${it.shape} ${isGroupMarker ? 'group' : ''} ${t.known || !S.targetsLoaded ? '' : 'unknown'} ${sel ? 'sel' : ''}"
    data-thing="light" data-key="${esc(key)}" ${group ? `data-group="${esc(group)}"` : ''} tabindex="0" role="button"
    aria-label="${esc(t.name)}, ${esc(providerLabel(t.pid))}. Use arrow keys to move." style="${style.join(';')}">
    <span class="tag" ${it.shape === 'strip' ? `style="transform:translateX(-50%) rotate(${-it.rot}deg)"` : ''}>${esc(t.name)}</span></div>`;
}

function planHtml(r) {
  const L = r.layout;
  const lights = planLights(r);
  return `
    <div class="plan ${L.outdoor ? 'outdoor' : ''}" id="plan" style="aspect-ratio:${L.width} / ${L.depth};--w:${L.width};--d:${L.depth}">
      ${L.furniture.filter(f => f.kind === 'rug').map(f => furnitureHtml(r, f)).join('')}
      <div class="glow-layer" id="glowLayer"></div>
      ${L.furniture.filter(f => f.kind !== 'rug').map(f => furnitureHtml(r, f)).join('')}
      ${lights.map(l => lightHtml(r, l.key, l.group)).join('')}
      ${r.targets.length ? '' : `<div class="plan-empty"><p>${S.mobile ? 'Tap Add lights or furniture below, then drag each one to where it is in the room.' : 'Drag a room or light from the list on the right and drop it where it is. Furniture is in the list too.'}</p></div>`}
      <span class="plan-dim">${L.width} × ${L.depth} ft</span>
    </div>
    ${popoverHtml(r)}`;
}

function popoverPos(r, x, y) {
  const L = r.layout;
  const left = clamp((x / L.width) * 100, 0, 100);
  const top = (y / L.depth) * 100;
  const below = top < 62;
  return `left:min(max(0px, calc(${left}% - 135px)), calc(100% - 270px));${below ? `top:calc(${top}% + 24px)` : `bottom:calc(${100 - top}% + 24px)`}`;
}

function popoverHtml(r) {
  if (!S.sel) return '';
  const L = r.layout;
  if (S.sel.type === 'furn') {
    const f = L.furniture.find(x => x.id === S.sel.id);
    if (!f) return '';
    const def = FURNITURE[f.kind];
    return `<div class="popover" id="popover" style="${popoverPos(r, f.x, f.y)}">
      <header><b>${esc(def.label)}</b><span class="spacer"></span><button class="btn ghost sm" data-act="close-pop">Done</button></header>
      <label class="field"><span>Name (optional)</span><input data-fp="label" value="${esc(f.label)}" placeholder="${esc(def.label)}"></label>
      <div class="settings-grid">
        <label class="field"><span>Width (ft)</span><input type="number" step="0.5" min="0.5" data-fp="w" value="${f.w}"></label>
        <label class="field"><span>Depth (ft)</span><input type="number" step="0.5" min="0.1" data-fp="d" value="${f.d}"></label>
      </div>
      <label class="field"><span>Turn: <b data-out="rot">${f.rot}°</b></span><input type="range" min="0" max="359" step="5" data-fp="rot" value="${((f.rot % 360) + 360) % 360}"></label>
      <div class="row"><button class="btn sm" data-act="rot-left">Turn left</button><button class="btn sm" data-act="rot-right">Turn right</button></div>
      <div class="row"><button class="btn sm" data-act="dup-furn">Duplicate</button><button class="btn sm danger" data-act="remove-furn">Remove</button></div>
    </div>`;
  }
  const key = S.sel.key;
  const pl = planLights(r).find(l => l.key === key);
  if (!pl) return '';
  const it = itemFor(r, key);
  const t = targetInfo(key);
  const group = pl.group ? targetInfo(pl.group) : null;
  const screen = L.furniture.find(f => SCREEN_KINDS.includes(f.kind));
  return `<div class="popover" id="popover" style="${popoverPos(r, it.x, it.y)}">
    <header><span class="dot" style="--c:${brandColor(t.pid)}"></span><b>${esc(t.name)}</b><span class="spacer"></span><button class="btn ghost sm" data-act="close-pop">Done</button></header>
    <p class="muted small">${esc(providerLabel(t.pid))}, ${esc(TYPE_LABEL[t.type] || t.type)}${t.detail ? `, ${esc(t.detail)}` : ''}</p>
    ${group ? `<p class="small">Part of <b>${esc(group.name)}</b>. Photon controls the whole group together.</p>` : ''}
    <div class="seg" role="group" aria-label="Shape">${Object.entries(SHAPE_LABEL).map(([k, v]) => `<button data-shape="${k}" aria-pressed="${it.shape === k}">${v}</button>`).join('')}</div>
    ${it.shape === 'strip' ? `<label class="field"><span>Length: <b data-out="len">${it.len} ft</b></span><input type="range" min="1" max="${Math.max(L.width, L.depth)}" step="0.5" data-lp="len" value="${it.len}"></label>` : ''}
    ${['strip', 'panel'].includes(it.shape) ? `<label class="field"><span>Turn: <b data-out="rot">${it.rot}°</b></span><input type="range" min="0" max="359" step="5" data-lp="rot" value="${((it.rot % 360) + 360) % 360}"></label>
      <div class="row">${L.outdoor ? '' : '<button class="btn sm" data-act="snap-wall">Line up with nearest wall</button>'}${screen && it.shape === 'strip' ? '<button class="btn sm" data-act="behind-tv">Behind the TV</button>' : ''}${it.shape === 'strip' && nearestEdge(L, it) ? `<button class="btn sm" data-act="snap-edge">Run along the ${esc(nearestEdge(L, it).name)}</button>` : ''}</div>` : ''}
    <label class="field"><span>Height: <b data-out="h">${round1(it.h)} ft</b></span><input type="range" min="0" max="${L.height}" step="0.5" data-lp="h" value="${it.h}"></label>
    <div class="chips">
      <button class="chip" data-h="0.3">Floor</button><button class="chip" data-h="2.5">Table</button>
      <button class="chip" data-h="5.5">Wall</button><button class="chip" data-h="${L.height - 0.3}">Ceiling</button>
    </div>
    <div class="row"><button class="btn sm" data-act="flash">Find it</button>
      <button class="btn sm danger" data-act="remove-light">${group ? `Remove ${esc(group.name)}` : 'Remove from room'}</button></div>
  </div>`;
}

function currentRule(r, ev = S.previewEvent) {
  const id = S.preview[r.id]?.[ev];
  return id ? r.rules.find(x => x.id === id) : null;
}

function updateStageNote() {
  const r = room();
  const el = $('#stageNote');
  if (!r || !el) return;
  const rule = currentRule(r);
  el.innerHTML = rule
    ? `Right now, when playback ${EV[S.previewEvent].toLowerCase()}, <b>${esc(rule.name)}</b> runs: ${esc(look(rule.action).label)}.`
    : `Right now, nothing is set to happen when playback ${EV[S.previewEvent].toLowerCase()}.`;
}

function updatePlanLook() {
  const r = room();
  if (!r) return;
  const lk = look(currentRule(r)?.action);
  const L = r.layout;
  const layer = $('#glowLayer');
  if (layer) {
    const a = lk.kind === 'off' ? 0 : 0.25 + lk.level * 0.75;
    layer.innerHTML = planLights(r).map(({ key, group }) => {
      const it = itemFor(r, key);
      const rgb = lightRgb(lk, key);
      const reach = 5 + lk.level * 12;
      if (it.shape === 'strip') {
        return `<div class="glow strip" style="left:${pctX(it.x, L)};top:${pctY(it.y, L)};width:${pctX(it.len + reach * 0.6, L)};height:${pctY(reach * 0.7, L)};transform:translate(-50%,-50%) rotate(${it.rot}deg);--g:${rgbCss(rgb, 0.9)};--a:${a}"></div>`;
      }
      const size = ((it.shape === 'panel' ? reach * 1.2 : reach) / L.width) * 100;
      return `<div class="glow" style="left:${pctX(it.x, L)};top:${pctY(it.y, L)};width:${size}%;aspect-ratio:1;--g:${rgbCss(rgb, 0.9)};--a:${a}"></div>`;
    }).join('');
    $$('.thing.light', $('#plan')).forEach(el => {
      const rgb = lightRgb(lk, el.dataset.key);
      el.style.setProperty('--lc', lk.kind === 'off' ? '#1a2038' : rgbCss(rgb));
      el.style.setProperty('--lc-glow', lk.kind === 'off' ? 'transparent' : rgbCss(rgb, 0.5 * (0.3 + lk.level)));
    });
    $$('.thing.furn', $('#plan')).forEach(el => {
      const f = L.furniture.find(x => x.id === el.dataset.id);
      if (f && SCREEN_KINDS.includes(f.kind)) el.classList.toggle('on', screensOn(r));
    });
  }
  if (view3d) view3d.update(model3d(r, lk));
}

function model3d(r, lk) {
  return {
    width: r.layout.width, depth: r.layout.depth, height: r.layout.height, outdoor: Boolean(r.layout.outdoor),
    screensOn: screensOn(r),
    furniture: r.layout.furniture.map(f => ({ ...f, ht: FURNITURE[f.kind]?.ht ?? 2 })),
    lights: planLights(r).map(({ key, group }) => {
      const t = targetInfo(key);
      const it = itemFor(r, key);
      return { key, ...it, name: t.name, brand: brandColor(t.pid), group: !group && t.type !== 'light' && t.type !== 'plug', rgb: lightRgb(lk, key), level: lk.kind === 'off' ? 0 : lk.level };
    }),
  };
}

// ---- behaviors ----
function ruleSummary(rule) {
  const evs = rule.events.length ? rule.events.map(e => EV[e]).join(', ') : 'No events picked';
  const s = rule.schedule;
  let when = 'any time';
  if (s.enabled) {
    when = `${s.from} to ${s.to}`;
    if (s.days.length && s.days.length < 7) when += `, ${s.days.map(d => DAYS[d]).join(' ')}`;
  }
  return `${evs}; ${when}`;
}

function swatchHtml(action) {
  const lk = look(action);
  if (lk.kind === 'off') return `<span class="swatch" style="background:#0b0f1d">off</span>`;
  if (lk.kind === 'none') return `<span class="swatch" style="background:#0b0f1d">–</span>`;
  if (lk.kind === 'restore') return `<span class="swatch" style="background:linear-gradient(135deg,#ffe2b8,#2a3762)">↺</span>`;
  if (lk.kind === 'scene') return `<span class="swatch" style="background:linear-gradient(135deg,#2f6bff,#a44dff)"></span>`;
  if (lk.random) {
    const stops = action.palette?.length ? action.palette.join(',') : '#ff4d4d,#ffd84d,#4dff88,#4dd2ff,#7a4dff,#ff4dd8,#ff4d4d';
    return `<span class="swatch" style="background:conic-gradient(${action.palette?.length === 1 ? `${stops},${stops}` : stops});opacity:${0.45 + lk.level * 0.55}"></span>`;
  }
  return `<span class="swatch" style="background:radial-gradient(circle at 50% 40%, ${rgbCss(lk.rgb)} 0%, ${rgbCss(lk.rgb, lk.level)} 45%, #0b0f1d 100%)"></span>`;
}

function ruleHtml(r, rule) {
  const open = S.openRule === rule.id;
  return `<li class="rule ${rule.enabled ? '' : 'off'}" data-rule="${rule.id}">
    <div class="rule-row" draggable="true" data-toggle-rule="${rule.id}" aria-expanded="${open}">
      <span class="handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
      ${swatchHtml(rule.action)}
      <span class="rule-main"><b>${esc(rule.name)}</b><span>${esc(ruleSummary(rule))}</span></span>
      <span class="badge-now" data-now="${rule.id}"></span>
      <label class="switch" title="${rule.enabled ? 'On' : 'Off'}"><input type="checkbox" data-rf="enabled" ${rule.enabled ? 'checked' : ''} aria-label="Behavior on"><i></i></label>
    </div>
    ${open ? ruleBodyHtml(r, rule) : ''}
  </li>`;
}

function ruleBodyHtml(r, rule) {
  const a = rule.action;
  const s = rule.schedule;
  const scenes = S.targets.filter(p => p.scenes?.length);
  const typeBtn = (t, label) => `<button data-atype="${t}" aria-pressed="${a.type === t}">${label}</button>`;
  return `<div class="rule-body">
    <label class="field"><span>Name</span><input data-rf="name" value="${esc(rule.name)}"></label>
    <div>
      <div class="label">When playback</div>
      <div class="chips">${Object.keys(EV).map(e => `<button class="chip" data-ev="${e}" aria-pressed="${rule.events.includes(e)}">${EV[e]}</button>`).join('')}</div>
    </div>
    <div>
      <label class="switch"><input type="checkbox" data-rf="schedule.enabled" ${s.enabled ? 'checked' : ''}><i></i>Only at certain times</label>
      ${s.enabled ? `
      <div class="time-row" style="margin-top:10px">
        <span class="muted small">From</span><input list="timePresets" data-rf="schedule.from" value="${esc(s.from)}" aria-label="From">
        <span class="muted small">to</span><input list="timePresets" data-rf="schedule.to" value="${esc(s.to)}" aria-label="To">
      </div>
      <p class="muted small" style="margin-top:6px">Use a clock time like 22:30, or sunrise, sunset, dawn, dusk with an offset in minutes like sunset-30.</p>
      <div class="chips" style="margin-top:8px">${DAYS.map((d, i) => `<button class="chip" data-day="${i}" aria-pressed="${s.days.includes(i)}">${d}</button>`).join('')}</div>` : ''}
    </div>
    <div>
      <div class="label">Lights</div>
      <div class="seg" role="group" aria-label="What the lights do">
        ${typeBtn('state', 'Set level')}${typeBtn('scene', 'Scene')}${typeBtn('restore', 'Restore')}${typeBtn('off', 'Off')}${typeBtn('none', 'Leave alone')}
      </div>
    </div>
    ${a.type === 'state' ? `
    <div class="grid">
      <label class="field"><span>Brightness <b data-out="brightness">${a.brightness}%</b></span><input type="range" min="1" max="100" data-rf="action.brightness" value="${a.brightness}"></label>
      <div>
        <div class="label">Color</div>
        <div class="seg" role="group" aria-label="Color">
          <button data-cmode="keep" aria-pressed="${a.colorMode === 'keep'}">Keep</button>
          <button data-cmode="temp" aria-pressed="${a.colorMode === 'temp'}">White</button>
          <button data-cmode="color" aria-pressed="${a.colorMode === 'color'}">Color</button>
          <button data-cmode="random" aria-pressed="${a.colorMode === 'random'}">Random</button>
        </div>
      </div>
      ${a.colorMode === 'temp' ? `<label class="field"><span>Warmth <b data-out="kelvin">${a.kelvin}K</b></span><input type="range" class="kelvin" min="2000" max="6500" step="100" data-rf="action.kelvin" value="${a.kelvin}"></label>` : ''}
      ${a.colorMode === 'color' ? `<label class="field"><span>Color</span><input type="color" data-rf="action.color" value="${esc(a.color)}" style="width:100%"></label>` : ''}
    </div>
    ${a.colorMode === 'random' ? `
    <div class="random-box">
      <p class="small muted">A new color is picked every time this runs.</p>
      <label class="switch"><input type="checkbox" data-rf="action.randomEach" ${a.randomEach ? 'checked' : ''}><i></i>Give each light its own color</label>
      <div>
        <div class="label">Pick from</div>
        <div class="seg" role="group" aria-label="Random colors from">
          <button data-palette-mode="any" aria-pressed="${!a.palette.length}">Any color</button>
          <button data-palette-mode="mine" aria-pressed="${a.palette.length > 0}">My colors</button>
        </div>
      </div>
      ${a.palette.length ? `<div class="palette">
        ${a.palette.map((c, i) => `<span class="pal"><input type="color" value="${esc(c)}" data-pal="${i}" aria-label="Color ${i + 1}"><button class="x" data-pal-remove="${i}" aria-label="Remove color ${i + 1}">×</button></span>`).join('')}
        ${a.palette.length < 12 ? '<button class="btn sm" data-act="pal-add">Add color</button>' : ''}
      </div>` : ''}
      <div><button class="btn sm ghost" data-act="shuffle">Shuffle preview</button></div>
    </div>` : ''}` : ''}
    ${a.type === 'scene' ? `
    <label class="field"><span>Scene</span>
      <select data-rf="action.scene"><option value="">Pick a scene</option>
        ${scenes.map(p => `<optgroup label="${esc(p.label)}">${p.scenes.map(sc => `<option value="${esc(`${p.id}::${sc.id}`)}" ${a.scene === `${p.id}::${sc.id}` ? 'selected' : ''}>${esc(sc.name)}${sc.detail ? ` (${esc(sc.detail)})` : ''}</option>`).join('')}</optgroup>`).join('')}
      </select></label>
      ${scenes.length ? '' : '<p class="muted small">None of your connected systems have scenes yet. Hue, LIFX, Nanoleaf effects and Home Assistant scenes show up here.</p>'}` : ''}
    ${a.type === 'restore' ? '<p class="muted small">Puts every light back exactly how it was when playback started. Needs "Remember how the lights were" on in Room settings.</p>' : ''}
    ${['state', 'scene', 'restore', 'off'].includes(a.type) ? `<label class="field" style="max-width:200px"><span>Fade (seconds)</span><input type="number" min="0" max="60" step="0.5" data-rf="action.transition" value="${a.transition}"></label>` : ''}
    <div class="actions-row">
      ${['state', 'off', 'scene'].includes(a.type) ? '<button class="btn sm" data-act="try-rule">Try on the lights</button>' : ''}
      <button class="btn sm" data-act="move-up" ${r.rules[0] === rule ? 'disabled' : ''}>Move up</button>
      <button class="btn sm" data-act="move-down" ${r.rules[r.rules.length - 1] === rule ? 'disabled' : ''}>Move down</button>
      <button class="btn sm" data-act="dup-rule">Duplicate</button>
      <button class="btn sm danger" data-act="del-rule">Delete</button>
    </div>
  </div>`;
}

function markActiveRules() {
  const r = room();
  if (!r) return;
  const active = new Map();
  for (const e of Object.keys(EV)) { const id = S.preview[r.id]?.[e]; if (id) active.set(id, [...(active.get(id) || []), EV_SHORT[e]]); }
  $$('[data-now]').forEach(el => { const evs = active.get(el.dataset.now); el.textContent = evs ? `Active now: ${evs.join(', ')}` : ''; });
}

// ---- library ----
// Rooms first, each opening to its zones and lights. Lights only show on their own
// when they aren't in any room or zone.
function lightTree(p) {
  const groups = p.targets.filter(t => t.members?.length);
  const rooms = groups.filter(t => t.type === 'room');
  const zones = groups.filter(t => t.type !== 'room');
  const lights = p.targets.filter(t => !t.members?.length);
  const roomOf = new Map();
  for (const g of rooms) for (const m of g.members) if (!roomOf.has(m)) roomOf.set(m, g.id);
  const inZone = new Set(zones.flatMap(z => z.members));
  const zoneRoom = new Map();
  for (const z of zones) { const g = rooms.find(x => z.members.every(m => x.members.includes(m))); if (g) zoneRoom.set(z.id, g.id); }
  const byId = new Map(lights.map(l => [l.id, l]));
  return {
    rooms: rooms.map(g => ({ ...g, zones: zones.filter(z => zoneRoom.get(z.id) === g.id), lights: g.members.map(m => byId.get(m)).filter(Boolean) })),
    zones: zones.filter(z => !zoneRoom.has(z.id)).map(z => ({ ...z, zones: [], lights: z.members.map(m => byId.get(m)).filter(Boolean) })),
    loose: lights.filter(l => !roomOf.has(l.id) && !inZone.has(l.id)),
  };
}

function libRow(r, pid, t, { depth = 0, expandable = false } = {}) {
  const key = `${pid}::${t.id}`;
  const cov = coverage(r, key);
  const open = S.expanded.has(key);
  const count = t.members?.length;
  return `<div class="lib-item ${cov ? 'in-room' : ''} ${expandable ? 'is-group' : ''}" style="--depth:${depth}" ${cov ? '' : 'draggable="true"'} data-drag-target="${esc(key)}" ${expandable ? `data-expand="${esc(key)}" aria-expanded="${open}"` : ''} title="${esc(t.detail || '')}">
    ${expandable ? `<span class="caret" aria-hidden="true">${open ? '▾' : '▸'}</span>` : depth ? '<span class="caret-pad"></span>' : ''}
    <span class="shape ${t.type === 'light' ? `s-${t.shape || 'bulb'}` : t.type}" style="--c:${brandColor(pid)}"></span><span class="nm">${esc(t.name)}</span>
    <span class="meta">${cov ? esc(cov) : count ? `${count} light${count === 1 ? '' : 's'}` : t.type === 'light' ? esc(SHAPE_LABEL[t.shape] || '') : esc(TYPE_LABEL[t.type] || '')}</span>
    ${cov ? '' : `<button class="add" data-add-target="${esc(key)}" aria-label="Add ${esc(t.name)} to this room">+</button>`}</div>`;
}

function libraryHtml(r) {
  let lights;
  if (!S.targetsLoaded) lights = `<p class="hint">Loading lights…</p>`;
  else if (!S.targets.length) lights = `<p class="hint">No lighting system is turned on. <a href="#connections">Connect one</a>.</p>`;
  else {
    lights = S.targets.map(p => {
      const tree = lightTree(p);
      const groupBlock = g => {
        const key = `${p.id}::${g.id}`;
        const sub = S.expanded.has(key)
          ? `<div class="lib-sub">${g.zones.map(z => libRow(r, p.id, z, { depth: 1 })).join('')}${g.lights.map(l => libRow(r, p.id, l, { depth: 1 })).join('')}</div>` : '';
        return libRow(r, p.id, g, { expandable: true }) + sub;
      };
      return `<div class="lib-group">
        <header><span class="dot" style="--c:${brandColor(p.id)}"></span>${esc(p.label)}</header>
        ${p.error ? `<p class="lib-error">${esc(p.error)}</p>` : ''}
        ${!p.error && !p.targets.length ? '<p class="hint">No lights found.</p>' : ''}
        ${tree.rooms.map(groupBlock).join('')}
        ${tree.zones.map(groupBlock).join('')}
        ${tree.loose.length && (tree.rooms.length || tree.zones.length) ? '<p class="sub-head">Not in a room</p>' : ''}
        ${tree.loose.map(l => libRow(r, p.id, l)).join('')}
      </div>`;
    }).join('');
  }

  const groupsF = {};
  for (const [kind, def] of Object.entries(FURNITURE)) (groupsF[def.group] ||= []).push([kind, def]);
  const outside = Boolean(r?.layout.outdoor);
  const furniture = Object.entries(groupsF).sort(([a], [b]) => outside ? Number(OUTDOOR_GROUPS.includes(b)) - Number(OUTDOOR_GROUPS.includes(a)) : 0).map(([g, items]) => `
    <div class="furn-group"><p class="sub-head">${esc(g)}</p><div class="furn-grid">
      ${items.map(([kind, def]) => `<button class="furn-chip" draggable="true" data-drag-furn="${kind}" title="Drag onto the floor plan, or click to add">
        <span class="fi f-${kind}"></span>${esc(def.label)}</button>`).join('')}
    </div></div>`).join('');

  const bySource = {};
  for (const p of S.players) (bySource[p.source] ||= []).push(p);
  const enabledSources = S.meta.media.filter(m => S.config.media[m.id]?.enabled);
  const players = !enabledSources.length
    ? `<p class="hint">No media server is turned on. <a href="#connections">Connect one</a>.</p>`
    : enabledSources.map(m => `
      <div class="lib-group">
        <header><span class="dot" style="--c:${brandColor(m.id)}"></span>${esc(m.label)}</header>
        ${(bySource[m.id] || []).map(p => {
          const inRoom = r.players.includes(p.key);
          const elsewhere = S.config.rooms.filter(x => x.id !== r.id && x.players.includes(p.key)).map(x => x.name);
          return `<div class="lib-item ${inRoom ? 'in-room' : ''}" ${inRoom ? '' : 'draggable="true"'} data-drag-player="${esc(p.key)}" title="${esc([p.product, p.user && `last used by ${p.user}`].filter(Boolean).join(', '))}">
            <span class="shape" style="--c:${brandColor(m.id)}"></span><span class="nm">${esc(p.name)}</span>
            <span class="meta">${inRoom ? 'In room' : elsewhere.length ? `In ${esc(elsewhere[0])}` : ''}</span>
            ${inRoom ? '' : `<button class="add" data-add-player="${esc(p.key)}" aria-label="Add ${esc(p.name)} to room">+</button>
            <button class="add hide" data-hide-player="${esc(p.key)}" title="Hide this player" aria-label="Hide ${esc(p.name)}">×</button>`}</div>`;
        }).join('') || `<p class="hint">${m.id === 'plex' && !S.config.media.plex?.token ? 'Sign in to Plex in Connections to list your players.' : 'Players show up here after they play something.'}</p>`}
      </div>`).join('');

  if (S.mobile) {
    const tabs = [['lights', 'Lights'], ['furniture', 'Furniture'], ['players', 'Players']];
    const body = {
      lights: `<p class="hint">Tap a light to put it in the room, or + to add a whole room of lights. Then drag it to where it is.</p>
        ${lights}<button class="btn sm ghost" data-act="refresh-lib">Refresh list</button>`,
      furniture: `<p class="hint">Tap a piece to add it. To move a piece on the plan, tap it first, then drag it. Tapping it also lets you turn, resize or remove it.</p>${furniture}`,
      players: `${players}
        <p class="hint">Only players on your home network are listed.${S.hiddenPlayers ? ` ${S.hiddenPlayers} hidden. <button class="linkish" data-act="unhide-players">Show them again</button>` : ''}</p>
        ${S.playerErrors.map(e => `<p class="lib-error">${esc(e)}</p>`).join('')}`,
    }[S.sheet] || '';
    return `
      <header class="sheet-head">
        <div class="seg" role="tablist" aria-label="Add to this room">
          ${tabs.map(([k, label]) => `<button role="tab" data-sheet-tab="${k}" aria-pressed="${S.sheet === k}">${label}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        <button class="btn ghost sm" data-act="close-sheet">Done</button>
      </header>
      <div class="sheet-body">${body}</div>`;
  }

  return `
    <div><h2>Lights</h2><p class="hint">Click a room to see what's in it. Drag onto the floor plan, and drag back here to remove.</p></div>
    ${lights}
    <button class="btn sm ghost" data-act="refresh-lib">Refresh list</button>
    <div><h2>Furniture</h2><p class="hint">Drag onto the floor plan. Click a piece on the plan to turn, resize or remove it.</p></div>
    ${furniture}
    <div><h2>Players</h2></div>
    ${players}
    <p class="hint">Only players on your home network are listed.${S.hiddenPlayers ? ` ${S.hiddenPlayers} hidden. <button class="linkish" data-act="unhide-players">Show them again</button>` : ''}</p>
    ${S.playerErrors.map(e => `<p class="lib-error">${esc(e)}</p>`).join('')}`;
}

// ---- binding ----
function bindRooms(r) {
  $$('[data-act="new-room"]', app).forEach(b => b.addEventListener('click', newRoom));

  // room list reorder
  const list = $('#roomList');
  list.addEventListener('dragstart', e => { const li = e.target.closest('li[data-room]'); if (li) { S.drag = { kind: 'room', id: li.dataset.room }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', li.dataset.room); } });
  list.addEventListener('dragover', e => { if (S.drag?.kind !== 'room') return; e.preventDefault(); $$('li', list).forEach(li => li.classList.toggle('drag-over', li === e.target.closest('li'))); });
  list.addEventListener('drop', e => {
    if (S.drag?.kind !== 'room') return;
    e.preventDefault();
    moveById(S.config.rooms, S.drag.id, e.target.closest('li')?.dataset.room);
    S.drag = null; commit(); render();
  });
  list.addEventListener('dragend', () => { S.drag = null; $$('li', list).forEach(li => li.classList.remove('drag-over')); });

  $('#roomName').addEventListener('input', e => {
    r.name = e.target.value || 'Room';
    const n = $(`li[data-room="${r.id}"] .rname`, list);
    if (n) n.textContent = r.name;
    commit();
  });
  $('#roomEnabled').addEventListener('change', e => { r.enabled = e.target.checked; commit(); render(); });
  $('.room-head').addEventListener('click', e => {
    if (!e.target.closest('[data-act="show-settings"]')) return;
    e.preventDefault();
    if (S.mobile) { showRoomTab('settings'); return; }
    const box = $('[aria-label="Room settings"]');
    box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    box?.classList.add('flash'); setTimeout(() => box?.classList.remove('flash'), 1600);
  });

  $('.room-tabs')?.addEventListener('click', e => {
    const b = e.target.closest('[data-room-tab]');
    if (b) showRoomTab(b.dataset.roomTab);
  });
  $$('[data-open-sheet]').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.openSheet)));
  if (S.mobile) $('#roomList [aria-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  $('#sheetBackdrop')?.addEventListener('click', closeSheet);

  $$('[data-stage]').forEach(b => b.addEventListener('click', () => { S.stageMode = b.dataset.stage; localSet('photon.stage', S.stageMode); S.sel = null; render(); }));
  $$('[data-preview]').forEach(b => b.addEventListener('click', () => {
    S.previewEvent = b.dataset.preview;
    randomCache.clear();
    $$('[data-preview]').forEach(x => x.setAttribute('aria-pressed', x === b));
    updateStageNote(); updatePlanLook();
  }));
  $('[data-act="simulate"]').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await saving;
      const res = await api('POST', `/api/rooms/${r.id}/simulate`, { event: S.previewEvent });
      const as = r.mediaTypes.length ? ` as ${MEDIA_LABEL[r.mediaTypes[0]].replace(/ \(.*\)/, '').toLowerCase()}, since the room only reacts to that` : '';
      toast(res.rooms?.length ? `Sent "${EV[S.previewEvent]}" to ${r.name}${as}. Check Activity for the result.` : 'This room did not match: check its players, users and media types.');
      setTimeout(pollStatus, 400);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });

  if (S.stageMode === '3d') mount3d(); else bindPlan(r);
  updateStageNote(); updatePlanLook(); markActiveRules();

  bindRules(r);
  bindPlayers(r);
  bindSettings(r);
  bindLibrary(r);
}

// Phones: one room section at a time.
function showRoomTab(tab) {
  S.roomTab = tab;
  localSet('photon.roomTab', tab);
  $$('[data-pane]').forEach(el => { el.hidden = el.dataset.pane !== tab; });
  $$('[data-room-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.roomTab === tab));
  const tabs = $('.room-tabs');
  if (tabs && tabs.getBoundingClientRect().top < 0) window.scrollTo({ top: window.scrollY + tabs.getBoundingClientRect().top - 60 });
}

// Phones: the lights, furniture and players list slides up from the bottom.
function openSheet(tab) {
  const r = room();
  const lib = $('#library');
  if (!r || !lib) return;
  S.sheet = tab;
  lib.innerHTML = libraryHtml(r);
  lib.hidden = false;
  lib.scrollTop = 0;
  $('#sheetBackdrop').hidden = false;
  document.body.classList.add('sheet-open');
  $('[data-act="close-sheet"]', lib)?.focus({ preventScroll: true });
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) closeSheet(); });
function closeSheet() {
  S.sheet = null;
  const lib = $('#library');
  if (lib && S.mobile) lib.hidden = true;
  const bd = $('#sheetBackdrop');
  if (bd) bd.hidden = true;
  document.body.classList.remove('sheet-open');
}

async function mount3d() {
  const host = $('#threeHost');
  try {
    const mod = await import('./room3d.js');
    if (!host.isConnected) return;
    view3d = mod.createRoom3D(host);
    updatePlanLook();
  } catch (err) {
    host.innerHTML = `<div class="empty-state">The 3D view could not start (${esc(err.message)}). The floor plan still works.</div>`;
  }
}

function planPoint(plan, clientX, clientY, L) {
  const rect = plan.getBoundingClientRect();
  return {
    x: clamp(((clientX - rect.left) / rect.width) * L.width, 0, L.width),
    y: clamp(((clientY - rect.top) / rect.height) * L.depth, 0, L.depth),
  };
}

function objOf(r, el) {
  return el.dataset.thing === 'furn' ? r.layout.furniture.find(f => f.id === el.dataset.id) : itemFor(r, el.dataset.key);
}

function bindPlan(r) {
  const plan = $('#plan');
  const L = r.layout;
  const lib = $('#library');

  plan.addEventListener('pointerdown', e => {
    const el = e.target.closest('.thing');
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    S.pointerActive = true;
    const obj = objOf(r, el);
    const start = { x: e.clientX, y: e.clientY, ox: obj.x, oy: obj.y };
    const p0 = planPoint(plan, e.clientX, e.clientY, L);
    let moved = false;
    const onMove = ev => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      moved = true;
      const p = planPoint(plan, ev.clientX, ev.clientY, L);
      obj.x = round1(clamp(start.ox + p.x - p0.x, 0, L.width));
      obj.y = round1(clamp(start.oy + p.y - p0.y, 0, L.depth));
      el.style.left = pctX(obj.x, L);
      el.style.top = pctY(obj.y, L);
      lib.classList.toggle('remove-zone', document.elementsFromPoint(ev.clientX, ev.clientY).includes(lib));
      updatePlanLook();
      $('#popover')?.remove();
    };
    const onUp = ev => {
      S.pointerActive = false;
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      lib.classList.remove('remove-zone');
      // The browser took over to scroll the page: not a tap, and not a move.
      if (ev.type === 'pointercancel' && !moved) return;
      if (moved && document.elementsFromPoint(ev.clientX, ev.clientY).includes(lib)) {
        if (el.dataset.thing === 'furn') removeFurniture(r, el.dataset.id);
        else removeLight(r, el.dataset.key);
        return;
      }
      if (moved) { commit(); if (S.sel) rerenderPlan(r); return; }
      const sel = el.dataset.thing === 'furn' ? { type: 'furn', id: el.dataset.id } : { type: 'light', key: el.dataset.key };
      S.sel = S.sel && JSON.stringify(S.sel) === JSON.stringify(sel) ? null : sel;
      rerenderPlan(r);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });

  // A tap on an empty spot closes the details. On click rather than pointerdown, so a
  // finger scrolling the page past the plan doesn't count.
  plan.addEventListener('click', e => {
    if (!e.target.closest('.thing') && S.sel) { S.sel = null; rerenderPlan(r); }
  });

  // keyboard: arrows move, R rotates furniture, Enter opens details, Delete removes
  plan.addEventListener('keydown', e => {
    const el = e.target.closest('.thing');
    if (!el) return;
    const obj = objOf(r, el);
    const step = e.shiftKey ? 2 : 0.5;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      obj.x = round1(clamp(obj.x + d[0], 0, L.width)); obj.y = round1(clamp(obj.y + d[1], 0, L.depth));
      el.style.left = pctX(obj.x, L); el.style.top = pctY(obj.y, L);
      updatePlanLook(); commit();
    } else if ((e.key === 'r' || e.key === 'R') && obj.rot != null) {
      e.preventDefault(); obj.rot = (obj.rot + (e.shiftKey ? -90 : 90) + 360) % 360; commit(); rerenderPlan(r);
      $(`.thing[data-${el.dataset.thing === 'furn' ? 'id' : 'key'}="${CSS.escape(el.dataset.id || el.dataset.key)}"]`)?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      S.sel = el.dataset.thing === 'furn' ? { type: 'furn', id: el.dataset.id } : { type: 'light', key: el.dataset.key };
      rerenderPlan(r);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (el.dataset.thing === 'furn') removeFurniture(r, el.dataset.id); else removeLight(r, el.dataset.key);
    }
  });

  // drops from the library: lights, rooms of lights, and furniture
  plan.addEventListener('dragover', e => {
    if (S.drag?.kind === 'target' || S.drag?.kind === 'furn') { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; plan.classList.add('drop-ok'); }
  });
  plan.addEventListener('dragleave', e => { if (!plan.contains(e.relatedTarget)) plan.classList.remove('drop-ok'); });
  plan.addEventListener('drop', e => {
    if (S.drag?.kind !== 'target' && S.drag?.kind !== 'furn') return;
    e.preventDefault();
    plan.classList.remove('drop-ok');
    const pos = planPoint(plan, e.clientX, e.clientY, L);
    if (S.drag.kind === 'furn') addFurniture(r, S.drag.furn, pos); else addTarget(r, S.drag.key, pos);
    S.drag = null;
  });

  bindPopover(r);
  keepPlanInView();
}

// Phones: a light's or furniture's details cover the bottom of the screen, so move the plan
// up to where it stays visible above them.
function keepPlanInView() {
  const open = Boolean(S.mobile && $('#popover'));
  document.body.classList.toggle('pop-open', open);
  if (!open) return;
  const plan = $('#plan');
  const tabs = $('.room-tabs');
  // where the sticky room tabs end once the page scrolls (header plus tabs)
  const top = (tabs ? (parseFloat(getComputedStyle(tabs).top) || 0) + tabs.offsetHeight : 60) + 8;
  const box = plan.getBoundingClientRect();
  const sheetTop = $('#popover').getBoundingClientRect().top;
  if (box.top < top - 1 || box.bottom > sheetTop) window.scrollTo({ top: window.scrollY + box.top - top });
}

function bindPopover(r) {
  const pop = $('#popover');
  if (!pop) return;
  const L = r.layout;
  const refreshThing = () => { updatePlanLook(); commit(); };

  if (S.sel.type === 'furn') {
    const f = L.furniture.find(x => x.id === S.sel.id);
    const el = $(`.thing.furn[data-id="${f.id}"]`);
    const apply = () => {
      el.style.width = pctX(f.w, L); el.style.height = pctY(f.d, L);
      el.style.transform = `translate(-50%,-50%) rotate(${f.rot}deg)`;
      $('span', el).textContent = f.label || FURNITURE[f.kind].label;
      refreshThing();
    };
    pop.addEventListener('input', e => {
      const k = e.target.dataset.fp;
      if (!k) return;
      if (k === 'label') f.label = e.target.value.slice(0, 40);
      else if (k === 'rot') { f.rot = Number(e.target.value); $('[data-out="rot"]', pop).textContent = `${f.rot}°`; }
      else if (e.target.value !== '') f[k] = clamp(Number(e.target.value), k === 'w' ? 0.5 : 0.1, 120);
      apply();
    });
    pop.addEventListener('click', e => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'close-pop') { S.sel = null; rerenderPlan(r); return; }
      if (a === 'rot-left' || a === 'rot-right') { f.rot = (f.rot + (a === 'rot-left' ? -90 : 90) + 360) % 360; apply(); rerenderPlan(r); }
      else if (a === 'dup-furn') addFurniture(r, f.kind, { x: clamp(f.x + 1.5, 0, L.width), y: clamp(f.y + 1.5, 0, L.depth) }, { ...f });
      else if (a === 'remove-furn') removeFurniture(r, f.id);
    });
    return;
  }

  const key = S.sel.key;
  const it = itemFor(r, key);
  const el = $(`.thing.light[data-key="${CSS.escape(key)}"]`);
  pop.addEventListener('input', e => {
    const k = e.target.dataset.lp;
    if (!k) return;
    it[k] = round1(Number(e.target.value));
    const out = $(`[data-out="${k}"]`, pop);
    if (out) out.textContent = k === 'rot' ? `${it.rot}°` : `${it[k]} ft`;
    if (k === 'len') el.style.width = pctX(it.len, L);
    if (k === 'rot') {
      el.style.transform = `translate(-50%,-50%) rotate(${it.rot}deg)`;
      const tag = $('.tag', el); if (tag) tag.style.transform = `translateX(-50%) rotate(${-it.rot}deg)`;
    }
    refreshThing();
  });
  pop.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'close-pop') { S.sel = null; rerenderPlan(r); return; }
    if (b.dataset.shape) { it.shape = b.dataset.shape; if (it.shape === 'strip' && !it.len) it.len = 6; commit(); rerenderPlan(r); }
    else if (b.dataset.h) { it.h = round1(Number(b.dataset.h)); commit(); rerenderPlan(r); }
    else if (b.dataset.act === 'snap-wall') {
      const d = { top: it.y, bottom: L.depth - it.y, left: it.x, right: L.width - it.x };
      const wall = Object.entries(d).sort((a, c) => a[1] - c[1])[0][0];
      if (wall === 'top') { it.y = 0.2; it.rot = 0; } else if (wall === 'bottom') { it.y = L.depth - 0.2; it.rot = 0; }
      else if (wall === 'left') { it.x = 0.2; it.rot = 90; } else { it.x = L.width - 0.2; it.rot = 90; }
      commit(); rerenderPlan(r);
    } else if (b.dataset.act === 'snap-edge') {
      const e2 = nearestEdge(L, it);
      if (e2) { Object.assign(it, { x: round1(clamp(e2.x, 0, L.width)), y: round1(clamp(e2.y, 0, L.depth)), rot: e2.rot, len: round1(e2.len), h: round1(Math.min(e2.h, L.height)) }); commit(); rerenderPlan(r); }
    } else if (b.dataset.act === 'behind-tv') {
      const tv = L.furniture.find(f => SCREEN_KINDS.includes(f.kind));
      // A hair toward the wall the TV hangs on, so the strip sits behind it.
      const back = (tv.rot || 0) * Math.PI / 180;
      Object.assign(it, { x: round1(clamp(tv.x + Math.sin(back) * 0.3, 0, L.width)), y: round1(clamp(tv.y - Math.cos(back) * 0.3, 0, L.depth)), rot: tv.rot, len: round1(tv.w * 0.9), h: tv.kind === 'screen' ? 5 : 4 });
      commit(); rerenderPlan(r);
    } else if (b.dataset.act === 'remove-light') removeLight(r, key);
    else if (b.dataset.act === 'flash') {
      b.disabled = true;
      try {
        await api('POST', '/api/test-action', { targets: [key], action: { type: 'state', brightness: 100, colorMode: 'color', color: '#38d9ff', transition: 0 } });
        toast(`${targetInfo(key).name} should be glowing cyan now. Run a behavior or Stop to put it back.`);
      } catch (err) { toast(err.message, true); }
      b.disabled = false;
    }
  });
}

function rerenderPlan(r) {
  $('#planWrap').innerHTML = planHtml(r);
  bindPlan(r);
  updatePlanLook();
}

function addTarget(r, key, pos) {
  const cov = coverage(r, key);
  if (cov) { toast(cov === 'In room' ? 'Already in this room.' : `Already in this room as part of ${cov.slice(3)}.`); return; }
  const L = r.layout;
  const t = targetInfo(key);
  const at = { x: pos?.x ?? L.width / 2, y: pos?.y ?? L.depth / 2 };

  if (t.members.length) {
    // Anything this group already covers comes out of the room as a separate target.
    r.targets = r.targets.filter(k => {
      const o = targetInfo(k);
      return !(t.members.includes(k) || (o.members.length && o.members.every(m => t.members.includes(m))));
    });
    t.members.forEach((m, i) => {
      if (L.items[m]) return; // keep where it was placed before
      const mi = targetInfo(m);
      const spread = (i - (t.members.length - 1) / 2) * 2;
      L.items[m] = { x: round1(clamp(at.x + spread, 0, L.width)), y: round1(clamp(at.y, 0, L.depth)), h: mi.shape === 'strip' ? 3 : 5, shape: mi.shape, len: 6, rot: 0 };
    });
  } else {
    L.items[key] = { ...(L.items[key] || {}), x: round1(at.x), y: round1(at.y), h: L.items[key]?.h ?? (t.shape === 'strip' ? 3 : 5), shape: L.items[key]?.shape || t.shape, len: L.items[key]?.len || 6, rot: L.items[key]?.rot || 0 };
  }
  r.targets.push(key);
  S.sel = t.members.length ? null : { type: 'light', key };
  S.sheet = null;
  commit();
  render();
}

// Removing a light that belongs to a group in the room removes the group.
function removeLight(r, key) {
  const pl = planLights(r).find(l => l.key === key);
  const target = pl?.group || key;
  r.targets = r.targets.filter(k => k !== target);
  const keep = new Set(planLights(r).map(l => l.key));
  for (const k of Object.keys(r.layout.items)) if (!keep.has(k) && !r.targets.includes(k)) delete r.layout.items[k];
  S.sel = null;
  commit();
  render();
}

function addFurniture(r, kind, pos, copy) {
  const def = FURNITURE[kind];
  const f = { id: uid(), kind, label: copy?.label || '', x: round1(pos.x), y: round1(pos.y), w: copy?.w ?? def.w, d: copy?.d ?? def.d, rot: copy?.rot ?? 0 };
  // Screens, doors and windows go against the nearest wall.
  if (['tv', 'screen', 'door', 'window'].includes(kind) && !copy) {
    const L = r.layout;
    const dist = { top: f.y, bottom: L.depth - f.y, left: f.x, right: L.width - f.x };
    const wall = Object.entries(dist).sort((a, b) => a[1] - b[1])[0][0];
    if (wall === 'top') { f.y = round1(f.d / 2); f.rot = 0; } else if (wall === 'bottom') { f.y = round1(L.depth - f.d / 2); f.rot = 180; }
    else if (wall === 'left') { f.x = round1(f.d / 2); f.rot = 270; } else { f.x = round1(L.width - f.d / 2); f.rot = 90; }
  }
  r.layout.furniture.push(f);
  S.sel = { type: 'furn', id: f.id };
  S.sheet = null;
  commit();
  render();
}

function removeFurniture(r, id) {
  r.layout.furniture = r.layout.furniture.filter(f => f.id !== id);
  S.sel = null;
  commit();
  render();
}

function moveById(list, fromId, beforeId) {
  const from = list.findIndex(x => x.id === fromId);
  if (from < 0 || fromId === beforeId) return;
  const [item] = list.splice(from, 1);
  const to = beforeId ? list.findIndex(x => x.id === beforeId) : -1;
  list.splice(to < 0 ? list.length : to, 0, item);
}

function bindRules(r) {
  const ul = $('#rules');
  $('[data-act="add-rule"]').addEventListener('click', () => {
    const rule = { id: uid(), name: 'New behavior', enabled: true, events: ['play'], schedule: { enabled: false, from: 'sunset', to: 'sunrise', days: [0, 1, 2, 3, 4, 5, 6] }, action: { type: 'state', brightness: 20, colorMode: 'temp', kelvin: 2700, color: '#38d9ff', scene: '', transition: 1 } };
    r.rules.push(rule);
    S.openRule = rule.id;
    commit(); render();
    $(`[data-rule="${rule.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const ruleOf = el => r.rules.find(x => x.id === el.closest('[data-rule]')?.dataset.rule);
  const rerenderRule = rule => {
    const li = $(`[data-rule="${rule.id}"]`, ul);
    const tmp = document.createElement('div');
    tmp.innerHTML = ruleHtml(r, rule);
    li.replaceWith(tmp.firstElementChild);
    markActiveRules();
  };
  const refreshRow = (rule, li) => {
    $('.rule-main b', li).textContent = rule.name;
    $('.rule-main span', li).textContent = ruleSummary(rule);
    $('.swatch', li).outerHTML = swatchHtml(rule.action);
    li.classList.toggle('off', !rule.enabled);
  };

  ul.addEventListener('click', e => {
    const rule = ruleOf(e.target);
    if (!rule) return;
    if (e.target.closest('.switch')) return;
    const toggle = e.target.closest('[data-toggle-rule]');
    if (toggle) { S.openRule = S.openRule === rule.id ? null : rule.id; rerenderRule(rule); return; }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.ev) { rule.events = toggleIn(rule.events, b.dataset.ev); b.setAttribute('aria-pressed', rule.events.includes(b.dataset.ev)); refreshRow(rule, b.closest('.rule')); commit(); }
    else if (b.dataset.day) { const d = Number(b.dataset.day); rule.schedule.days = toggleIn(rule.schedule.days, d).sort(); b.setAttribute('aria-pressed', rule.schedule.days.includes(d)); refreshRow(rule, b.closest('.rule')); commit(); }
    else if (b.dataset.atype) { rule.action.type = b.dataset.atype; if (rule.action.type === 'scene') loadTargets(); commit(); rerenderRule(rule); updatePlanLook(); }
    else if (b.dataset.cmode) { rule.action.colorMode = b.dataset.cmode; commit(); rerenderRule(rule); updatePlanLook(); }
    else if (b.dataset.paletteMode) {
      rule.action.palette = b.dataset.paletteMode === 'any' ? [] : rule.action.palette.length ? rule.action.palette : ['#ff3d6e', '#38d9ff', '#a44dff'];
      randomCache.clear(); commit(); rerenderRule(rule); updatePlanLook();
    } else if (b.dataset.palRemove != null) {
      rule.action.palette.splice(Number(b.dataset.palRemove), 1);
      randomCache.clear(); commit(); rerenderRule(rule); updatePlanLook();
    } else if (b.dataset.act === 'pal-add') {
      rule.action.palette.push(randomColorHex()); randomCache.clear(); commit(); rerenderRule(rule); updatePlanLook();
    } else if (b.dataset.act === 'shuffle') { randomCache.clear(); updatePlanLook(); rerenderRule(rule); }
    else if (b.dataset.act === 'del-rule') { r.rules = r.rules.filter(x => x !== rule); commit(); render(); }
    else if (b.dataset.act === 'move-up' || b.dataset.act === 'move-down') {
      const i = r.rules.indexOf(rule);
      const j = b.dataset.act === 'move-up' ? i - 1 : i + 1;
      if (j < 0 || j >= r.rules.length) return;
      [r.rules[i], r.rules[j]] = [r.rules[j], r.rules[i]];
      commit(); render();
      $(`[data-rule="${rule.id}"] [data-act="${b.dataset.act}"]`)?.focus();
    }
    else if (b.dataset.act === 'dup-rule') {
      const copy = { ...JSON.parse(JSON.stringify(rule)), id: uid(), name: `${rule.name} (copy)` };
      r.rules.splice(r.rules.indexOf(rule) + 1, 0, copy); S.openRule = copy.id; commit(); render();
    } else if (b.dataset.act === 'try-rule') {
      b.disabled = true;
      api('POST', '/api/test-action', { targets: r.targets, action: rule.action })
        .then(res => toast(res.message)).catch(err => toast(err.message, true)).finally(() => { b.disabled = false; });
    }
  });

  const onField = e => {
    if (e.target.dataset.pal != null) {
      const rule = ruleOf(e.target);
      rule.action.palette[Number(e.target.dataset.pal)] = e.target.value;
      randomCache.clear(); refreshRow(rule, e.target.closest('.rule')); updatePlanLook(); commit();
      return;
    }
    const f = e.target.dataset.rf;
    if (!f) return;
    const rule = ruleOf(e.target);
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'range' || e.target.type === 'number') v = Number(v);
    const [a, b] = f.split('.');
    if (b) rule[a][b] = v; else rule[a] = v;
    const li = e.target.closest('.rule');
    if (f === 'action.brightness') $('[data-out="brightness"]', li).textContent = `${v}%`;
    if (f === 'action.kelvin') $('[data-out="kelvin"]', li).textContent = `${v}K`;
    refreshRow(rule, li);
    if (f === 'schedule.enabled') rerenderRule(rule);
    if (f === 'action.randomEach') randomCache.clear();
    updatePlanLook();
    commit(f.startsWith('schedule.') && e.type === 'input' ? 900 : 500);
  };
  ul.addEventListener('input', e => { if (e.target.type !== 'checkbox') onField(e); });
  ul.addEventListener('change', e => { if (e.target.type === 'checkbox') onField(e); });

  ul.addEventListener('dragstart', e => {
    const li = e.target.closest('.rule');
    if (!li || !e.target.classList?.contains('rule-row')) return;
    S.drag = { kind: 'rule', id: li.dataset.rule };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.rule);
    li.classList.add('dragging');
  });
  ul.addEventListener('dragover', e => {
    if (S.drag?.kind !== 'rule') return;
    e.preventDefault();
    const li = e.target.closest('.rule');
    $$('.rule', ul).forEach(x => x.classList.toggle('drop-before', x === li && li.dataset.rule !== S.drag.id));
  });
  ul.addEventListener('drop', e => {
    if (S.drag?.kind !== 'rule') return;
    e.preventDefault();
    moveById(r.rules, S.drag.id, e.target.closest('.rule')?.dataset.rule);
    S.drag = null; commit(); render();
  });
  ul.addEventListener('dragend', () => { S.drag = null; $$('.rule', ul).forEach(x => x.classList.remove('dragging', 'drop-before')); });
}

function toggleIn(list, v) { return list.includes(v) ? list.filter(x => x !== v) : [...list, v]; }

function bindPlayers(r) {
  const zone = $('#playerZone');
  zone.addEventListener('click', e => {
    const b = e.target.closest('[data-remove-player]');
    if (b) {
      r.players = r.players.filter(k => k !== b.dataset.removePlayer);
      if (r.playerNames) delete r.playerNames[b.dataset.removePlayer];
      commit(); render();
    }
  });
  zone.addEventListener('dragover', e => { if (S.drag?.kind === 'player') { e.preventDefault(); zone.classList.add('over'); } });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    if (S.drag?.kind !== 'player') return;
    e.preventDefault();
    addPlayer(r, S.drag.key);
    S.drag = null;
  });
  $('[data-act="manual-player"]').addEventListener('click', () => {
    const id = $('#manualId').value.trim();
    if (id) addPlayer(r, `${$('#manualSource').value}:${id}`);
  });
}

function addPlayer(r, key, name) {
  if (!r.players.includes(key)) r.players.push(key);
  // Remember the name too: a TV you cast to can come back under a different ID.
  const n = name || S.players.find(p => p.key === key)?.name;
  if (n) r.playerNames = { ...(r.playerNames || {}), [key]: n };
  S.sheet = null;
  commit(); render();
}

function bindSettings(r) {
  $$('[data-layout]').forEach(inp => inp.addEventListener('change', () => {
    const k = inp.dataset.layout;
    const big = r.layout.outdoor ? 200 : 60;
    const lim = { width: [6, big], depth: [6, big], height: [7, r.layout.outdoor ? 40 : 20] }[k];
    const old = r.layout[k];
    r.layout[k] = clamp(Number(inp.value) || old, ...lim);
    const f = r.layout[k] / old;
    if (k !== 'height') {
      const axis = k === 'width' ? 'x' : 'y';
      for (const it of [...Object.values(r.layout.items), ...r.layout.furniture]) it[axis] = round1(it[axis] * f);
    } else for (const it of Object.values(r.layout.items)) it.h = round1(Math.min(it.h, r.layout.height));
    commit(); render();
  }));
  $('#mediaTypes').addEventListener('click', e => {
    const b = e.target.closest('[data-mtype]');
    if (!b) return;
    const all = S.meta.mediaTypes;
    let cur = r.mediaTypes.length ? r.mediaTypes : [...all];
    cur = toggleIn(cur, b.dataset.mtype);
    if (!cur.length) { toast('A room has to react to at least one kind of media.', true); return; }
    r.mediaTypes = cur.length === all.length ? [] : cur;
    const note = $('#filterNote');
    if (note) note.outerHTML = filterNoteHtml(r) || '<span id="filterNote" hidden></span>';
    else $('.room-head')?.insertAdjacentHTML('beforeend', filterNoteHtml(r));
    $$('[data-mtype]').forEach(x => x.setAttribute('aria-pressed', !r.mediaTypes.length || r.mediaTypes.includes(x.dataset.mtype)));
    commit();
  });

  const homeNames = () => (S.config.media.plex?.enabled ? S.plex.homeUsers || [] : []).map(u => u.title.toLowerCase());
  $('#homeUsers')?.addEventListener('click', e => {
    const b = e.target.closest('[data-user]');
    if (!b) return;
    const extra = r.users.filter(u => !homeNames().includes(u.toLowerCase()));
    let home = r.users.filter(u => homeNames().includes(u.toLowerCase()));
    if (b.dataset.user === '*') home = [];
    else home = home.some(u => u.toLowerCase() === b.dataset.user.toLowerCase()) ? home.filter(u => u.toLowerCase() !== b.dataset.user.toLowerCase()) : [...home, b.dataset.user];
    r.users = [...home, ...extra];
    $$('[data-user]').forEach(x => x.setAttribute('aria-pressed', x.dataset.user === '*' ? !r.users.length : r.users.some(u => u.toLowerCase() === x.dataset.user.toLowerCase())));
    commit();
  });
  $('#roomUsers').addEventListener('input', e => {
    const home = r.users.filter(u => homeNames().includes(u.toLowerCase()));
    r.users = [...home, ...e.target.value.split(',').map(s => s.trim()).filter(Boolean)];
    const all = $('[data-user="*"]'); if (all) all.setAttribute('aria-pressed', !r.users.length);
    commit(800);
  });
  $('#stopDelay').addEventListener('input', e => { r.stopDelaySeconds = clamp(Number(e.target.value) || 0, 0, 120); commit(); });
  $('#snapshot').addEventListener('change', e => { r.snapshotOnPlay = e.target.checked; commit(); });
  $('#outdoor')?.addEventListener('change', e => {
    const L = r.layout;
    L.outdoor = e.target.checked;
    if (!L.outdoor) { // back indoors: fit the old limits
      const sx = Math.min(1, 60 / L.width), sy = Math.min(1, 60 / L.depth);
      for (const it of [...Object.values(L.items), ...L.furniture]) { it.x = round1(it.x * sx); it.y = round1(it.y * sy); }
      L.width = Math.min(L.width, 60); L.depth = Math.min(L.depth, 60); L.height = Math.min(L.height, 20);
      for (const it of Object.values(L.items)) it.h = Math.min(it.h, L.height);
    } else if (L.height < 12) L.height = 12;
    commit(); render();
  });
  $('[data-act="delete-room"]').addEventListener('click', () => {
    if (!confirm(`Delete ${r.name}? Its layout and behaviors will be gone.`)) return;
    S.config.rooms = S.config.rooms.filter(x => x !== r);
    S.roomId = S.config.rooms[0]?.id || null;
    commit(0);
    location.hash = S.roomId ? `#rooms/${S.roomId}` : '#rooms';
    render();
    toast(`Deleted ${r.name}`);
  });
}

function bindLibrary(r) {
  const lib = $('#library');
  lib.addEventListener('dragstart', e => {
    const t = e.target.closest('[data-drag-target]');
    const p = e.target.closest('[data-drag-player]');
    const f = e.target.closest('[data-drag-furn]');
    let data = '';
    if (t) { S.drag = { kind: 'target', key: t.dataset.dragTarget }; data = t.dataset.dragTarget; }
    else if (p) { S.drag = { kind: 'player', key: p.dataset.dragPlayer }; data = p.dataset.dragPlayer; }
    else if (f) { S.drag = { kind: 'furn', furn: f.dataset.dragFurn }; data = f.dataset.dragFurn; }
    if (data) { e.dataTransfer.setData('text/plain', data); e.dataTransfer.effectAllowed = 'copy'; }
  });
  lib.addEventListener('dragend', () => { S.drag = null; $('#plan')?.classList.remove('drop-ok'); $('#playerZone')?.classList.remove('over'); });
  lib.addEventListener('click', e => {
    const tab = e.target.closest('[data-sheet-tab]');
    if (tab) { S.sheet = tab.dataset.sheetTab; lib.innerHTML = libraryHtml(r); lib.scrollTop = 0; return; }
    if (e.target.closest('[data-act="close-sheet"]')) { closeSheet(); return; }
    const at = e.target.closest('[data-add-target]');
    const ap = e.target.closest('[data-add-player]');
    const af = e.target.closest('[data-drag-furn]');
    const ex = e.target.closest('[data-expand]');
    // On a phone, tapping anywhere on a light or player adds it (rooms of lights open instead).
    const row = S.mobile && !at && !ap && !ex && !e.target.closest('button') ? e.target.closest('.lib-item:not(.in-room)') : null;
    if (row?.dataset.dragTarget) { addTarget(r, row.dataset.dragTarget); return; }
    if (row?.dataset.dragPlayer) { addPlayer(r, row.dataset.dragPlayer); return; }
    if (at) addTarget(r, at.dataset.addTarget);
    else if (ap) addPlayer(r, ap.dataset.addPlayer);
    else if (e.target.closest('[data-hide-player]')) {
      api('POST', '/api/players/hide', { key: e.target.closest('[data-hide-player]').dataset.hidePlayer })
        .then(() => { S.playersLoaded = false; loadPlayers(true); }).catch(err => toast(err.message, true));
    } else if (e.target.closest('[data-act="unhide-players"]')) {
      api('POST', '/api/players/unhide').then(() => { S.playersLoaded = false; loadPlayers(true); }).catch(err => toast(err.message, true));
    }
    else if (af) addFurniture(r, af.dataset.dragFurn, { x: r.layout.width / 2, y: r.layout.depth / 2 });
    else if (ex) {
      const k = ex.dataset.expand;
      if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k);
      lib.innerHTML = libraryHtml(r);
    } else if (e.target.closest('[data-act="refresh-lib"]')) { S.targetsLoaded = false; S.playersLoaded = false; loadTargets(true); loadPlayers(true); toast('Refreshing lights and players…'); }
  });
  lib.addEventListener('keydown', e => {
    const ex = e.target.closest('[data-expand]');
    if (ex && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ex.click(); }
  });
}

async function newRoom() {
  let rules = [];
  try { rules = await api('GET', '/api/default-rules'); } catch { /* start empty */ }
  const names = ['Living room', 'Bedroom', 'Basement', 'Den', 'Office', 'Game room'];
  const name = names.find(n => !S.config.rooms.some(r => r.name === n)) || `Room ${S.config.rooms.length + 1}`;
  const bedroom = name === 'Bedroom';
  const r = {
    id: uid(), name, enabled: true, players: [], users: [], mediaTypes: [], targets: [],
    snapshotOnPlay: true, stopDelaySeconds: 10, rules,
    layout: {
      width: bedroom ? 13 : 16, depth: bedroom ? 12 : 13, height: 9, items: {},
      furniture: bedroom
        ? [{ id: uid(), kind: 'tv', label: '', x: 6.5, y: 0.2, w: 4.3, d: 0.4, rot: 0 }, { id: uid(), kind: 'bed', label: '', x: 6.5, y: 8.2, w: 5, d: 7, rot: 0 },
          { id: uid(), kind: 'nightstand', label: '', x: 3.1, y: 11.1, w: 1.8, d: 1.5, rot: 0 }, { id: uid(), kind: 'nightstand', label: '', x: 9.9, y: 11.1, w: 1.8, d: 1.5, rot: 0 }]
        : [{ id: uid(), kind: 'tv', label: '', x: 8, y: 0.2, w: 4.8, d: 0.4, rot: 0 }, { id: uid(), kind: 'sofa', label: '', x: 8, y: 9.5, w: 7, d: 3, rot: 0 },
          { id: uid(), kind: 'coffeetable', label: '', x: 8, y: 6.8, w: 4, d: 2, rot: 0 }],
    },
  };
  S.config.rooms.push(r);
  S.roomId = r.id;
  commit(0);
  location.hash = `#rooms/${r.id}`;
  render();
  setTimeout(() => { const n = $('#roomName'); n?.focus(); n?.select(); }, 50);
}

// ---------------------------------------------------------------------------
// CONNECTIONS
function fieldHtml(kind, sysId, f, val) {
  const data = `data-kind="${kind}" data-sys="${sysId}" data-key="${f.key}"`;
  if (f.type === 'checkbox') return `<label class="switch"><input type="checkbox" ${data} ${val !== false && val !== '' ? 'checked' : ''}><i></i>${esc(f.label)}</label>`;
  if (f.type === 'select') return `<label class="field"><span>${esc(f.label)}</span><select ${data}>${(f.options || []).map(o => `<option value="${esc(o.value)}" ${String(val ?? f.default ?? '') === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
  const type = f.secret ? 'password' : f.type === 'number' ? 'number' : 'text';
  // Saved keys never come to the page. Leave the box alone to keep it, or type a new one.
  if (val === SAVED) return `<label class="field"><span>${esc(f.label)}</span><input type="${type}" ${data} value="" placeholder="Saved. Type a new one to replace it." autocomplete="off" spellcheck="false"></label>`;
  return `<label class="field"><span>${esc(f.label)}</span><input type="${type}" ${data} value="${esc(val ?? '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false"></label>`;
}

function plexAccountHtml() {
  const c = S.config.media.plex;
  if (!c.token) {
    return `<div class="plex-signin">
      <button class="btn primary" data-act="plex-signin">Sign in with Plex</button>
      <p class="muted small">Opens plex.tv in a new window. You sign in there, and Photon only receives a sign-in token, never your password.</p>
      <details><summary class="muted small" style="cursor:pointer">Use a token instead</summary>
        <div class="copy-row" style="margin-top:8px"><input type="password" id="plexToken" placeholder="X-Plex-Token" autocomplete="off"><button class="btn sm" data-act="plex-token">Save token</button></div>
      </details>
    </div>`;
  }
  const servers = S.plex.servers || [];
  const home = S.plex.homeUsers || [];
  return `<div class="plex-account">
    <div class="row-line"><span>Signed in as <b>${esc(c.account || S.plex.account?.name || 'your Plex account')}</b></span><button class="btn sm ghost" data-act="plex-signout">Sign out</button></div>
    <label class="field"><span>Your server</span>
      <select id="plexServer">
        ${servers.length ? '' : '<option value="">No servers found on this account</option>'}
        ${servers.map(s => `<option value="${esc(s.id)}" ${c.serverId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select></label>
    <div><div class="small muted" style="margin-bottom:6px">People in your Plex Home</div>
      <div class="chips">${home.map(u => `<span class="chip" aria-pressed="true">${esc(u.title)}${u.admin ? ' (owner)' : ''}</span>`).join('') || '<span class="muted small">Only you</span>'}</div></div>
  </div>`;
}

function plexHookHtml(c) {
  const w = S.plex.webhook;
  if (c.autoWebhook === false) return '';
  if ((!w || w.ok === null) && !S.plexHookPoll) {
    S.plexHookPoll = setTimeout(async () => { S.plexHookPoll = null; await loadPlex(); if (S.view === 'connections' && S.plex.webhook?.ok !== null) renderConnections(); }, 3000);
  }
  const line = !w || w.ok === null ? '<span class="muted small">Checking your Plex account\'s webhooks…</span>'
    : w.ok ? `<span class="small" style="color:var(--ok)">✓ Your Plex account sends events to Photon.</span>`
    : `<span class="small" style="color:var(--bad)">${esc(w.error || 'Could not set the webhook.')}</span>`;
  return `<div class="row-line">${line}<button class="btn sm" data-act="plex-webhook">${w?.ok ? 'Check again' : 'Set it up now'}</button></div>`;
}

function sysHtml(kind, sys) {
  const c = S.config[kind][sys.id];
  const open = S.openSys === sys.id;
  const res = S.results[sys.id];
  const isPlex = sys.id === 'plex';
  const status = isPlex && c.enabled ? (c.token ? `On, signed in as ${c.account || 'you'}` : 'On, not signed in') : c.enabled ? 'On' : 'Off';
  return `<section class="panel sys" style="--c:${brandColor(sys.id)}" data-sysbox="${sys.id}">
    <div class="sys-head" data-open-sys="${sys.id}" aria-expanded="${open}">
      <span class="dot"></span><h3>${esc(sys.label)}</h3>
      <span class="status ${c.enabled ? 'ok' : ''}">${esc(status)}</span>
      <span class="spacer"></span>
      <label class="switch" title="Turn ${esc(sys.label)} on or off"><input type="checkbox" data-kind="${kind}" data-sys="${sys.id}" data-key="enabled" ${c.enabled ? 'checked' : ''} aria-label="${esc(sys.label)} on"><i></i></label>
    </div>
    ${open ? `<div class="sys-body">
      <p class="blurb">${esc(sys.blurb)}</p>
      ${isPlex ? plexAccountHtml() : ''}
      ${sys.group === 'tv' && c.enabled ? `<div class="tv-status" id="tvstat-${sys.id}"><span class="muted small">Checking…</span></div>` : ''}
      <div class="fields">${sys.fields.map(f => fieldHtml(kind, sys.id, f, c[f.key])).join('')}
        <label class="field"><span>Color in Photon</span><input type="color" data-brand="${sys.id}" value="${brandColor(sys.id)}"></label>
      </div>
      ${kind === 'media' && sys.webhook !== false ? `
        <div class="field"><span class="muted small">Webhook address for ${esc(sys.label)}</span>
          <div class="copy-row"><input readonly value="${esc(sys.webhookUrl)}" id="wh-${sys.id}"><button class="btn sm" data-copy="wh-${sys.id}">Copy</button></div></div>
        <p class="help">${esc(sys.webhookHelp)}</p>
        ${isPlex && c.token ? plexHookHtml(c) : ''}` : ''}
      <div class="actions-row">
        ${(sys.actions || []).map(a => `<button class="btn sm" data-sys-action="${a.id}" data-kind="${kind}" data-sys="${sys.id}">${esc(a.label)}</button>`).join('')}
        ${isPlex && !c.token ? '' : `<button class="btn sm ${isPlex ? '' : 'primary'}" data-test="${sys.id}" data-kind="${kind}">Test connection</button>`}
      </div>
      ${res ? `<p class="result ${res.ok ? 'ok' : 'err'}">${esc(res.msg)}</p>` : ''}
    </div>` : ''}
  </section>`;
}

// What each TV reported on Photon's last check, shown in its card while it's open.
let tvStatusTimer = null;
async function refreshTvStatus() {
  clearTimeout(tvStatusTimer);
  const box = $('.tv-status');
  if (!box || S.view !== 'connections') return;
  const id = box.id.replace('tvstat-', '');
  try {
    const { devices } = await api('GET', `/api/media/${id}/status`);
    const cur = $(`#tvstat-${id}`);
    if (!cur) return;
    const word = { playing: 'playing', paused: 'paused', idle: 'nothing playing', off: 'off' };
    cur.innerHTML = devices.length ? `<ul class="tv-list">${devices.map(d => `<li><b>${esc(d.name)}</b> <span class="muted small">${esc(d.host)}</span><br>
      ${d.ok ? `<span class="small" style="color:var(--ok)">${esc(word[d.state] || d.state)}${d.title && ['playing', 'paused'].includes(d.state) ? `: ${esc(d.title)}` : ''}</span>`
             : `<span class="small" style="color:var(--bad)">${esc(d.error)}</span>`}</li>`).join('')}</ul>`
      : '<span class="muted small">No devices checked yet. Click "Find on my network" or type an IP address.</span>';
  } catch { /* try again shortly */ }
  tvStatusTimer = setTimeout(refreshTvStatus, 3000);
}

function renderConnections() {
  const c = S.config;
  const sun = S.meta.sun;
  const on = list => list.filter(x => S.config[x.kind]?.[x.id]?.enabled).length;
  const lightsOn = on(S.meta.lighting.map(x => ({ kind: 'lighting', id: x.id })));
  const mediaOn = on(S.meta.media.filter(x => x.group !== 'tv').map(x => ({ kind: 'media', id: x.id })));
  const tvsOn = on(S.meta.media.filter(x => x.group === 'tv').map(x => ({ kind: 'media', id: x.id })));
  const jump = [['conn-lights', 'Lights', lightsOn], ['conn-media', 'Media server', mediaOn], ['conn-tvs', 'Smart TVs', tvsOn]];
  app.innerHTML = `<nav class="jump" aria-label="Jump to">
    ${jump.map(([id, label, n]) => `<button data-jump="${id}">${label}${n ? `<span class="count">${n} on</span>` : ''}</button>`).join('')}
  </nav>
  <div class="conn">
    <section id="conn-lights">
      <header><h1>Lights</h1><p>Turn on each lighting system you have. Its color here is how you'll spot its lights in rooms.</p></header>
      ${S.meta.lighting.map(s => sysHtml('lighting', s)).join('')}
    </section>
    <section id="conn-media">
      <header><h1>Media server</h1><p>Photon listens for play, pause and stop from your server. Set up the webhook in your server, or for Jellyfin and Emby let Photon check in every couple of seconds.</p></header>
      ${S.meta.media.filter(s => s.group !== 'tv').map(s => sysHtml('media', s)).join('')}
    </section>
    <section id="conn-tvs">
      <header><h1>Smart TVs</h1><p>Lights can also follow whatever is playing on a TV or streaming box, from any app: Netflix, YouTube, Disney+ and the rest. Turn on the kinds you have, then pick the TV as a room's player.</p></header>
      ${S.meta.media.filter(s => s.group === 'tv').map(s => sysHtml('media', s)).join('')}
    </section>
  </div>`;
  bindJump();
  bindConnections();
  refreshTvStatus();
}

// The row of section buttons at the top of Connections and Settings (phones).
function bindJump() {
  $('.jump', app).addEventListener('click', e => {
    const b = e.target.closest('[data-jump]');
    const el = b && document.getElementById(b.dataset.jump);
    if (el) window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 112, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}

// ---------------------------------------------------------------------------
// SETTINGS: how Photon itself runs (sign-in, HTTPS, location, saved versions, webhook key).
// Connections is only for connecting lights, media servers and TVs.
function renderSettings() {
  const c = S.config;
  const sun = S.meta.sun;
  const jump = [['set-account', 'Password'], ['tlsBox', 'HTTPS'], ['set-location', 'Location'], ['backupBox', 'Saved versions'], ['set-webhook', 'Webhook key']];
  app.innerHTML = `<nav class="jump" aria-label="Jump to">
    ${jump.map(([id, label]) => `<button data-jump="${id}">${label}</button>`).join('')}
  </nav>
  <div class="conn settings">
    <header class="settings-head"><h1>Settings</h1><p>How Photon itself runs: signing in, secure connections, your location for sunrise and sunset, and saved copies of your setup.</p></header>
    <section class="panel block" id="set-account">
      <h2>Password and sign-in</h2>
      <p class="muted small">Photon asks for this password on each device you open it on. A device stays signed in for 30 days of use, until you sign it out.</p>
      <form id="pwForm" class="pw-form">
        <input type="text" autocomplete="username" value="Photon" class="sr-only" tabindex="-1" aria-hidden="true" readonly>
        <label class="field"><span>Current password</span><input type="password" id="pwCurrent" autocomplete="current-password" required></label>
        <label class="field"><span>New password</span><input type="password" id="pwNew" autocomplete="new-password" required></label>
        <label class="field"><span>Type the new one again</span><input type="password" id="pwAgain" autocomplete="new-password" required></label>
        <div class="actions-row"><button class="btn sm" type="submit">Change password</button></div>
        <p class="muted small">Changing it signs out every other device.</p>
      </form>
      ${bioSectionHtml()}
      <div class="actions-row"><button class="btn sm" data-act="sign-out">Sign out of this device</button>
        <button class="btn sm danger" data-act="sign-out-all">Sign out everywhere</button></div>
    </section>
    <section class="panel block" id="tlsBox">${tlsHtml()}</section>
    <section class="panel block" id="set-location">
      <h2>Your location</h2>
      <p class="muted small">Used only to work out sunrise and sunset for time-based behaviors. Today: dawn ${sun.dawn}, sunrise ${sun.sunrise}, sunset ${sun.sunset}, dusk ${sun.dusk}${sun.usingFallback ? ' (typical times until you set a location)' : ''}.</p>
      <div class="settings-grid">
        <label class="field"><span>Latitude</span><input type="number" step="0.0001" id="lat" value="${c.location.lat ?? ''}" placeholder="41.0534"></label>
        <label class="field"><span>Longitude</span><input type="number" step="0.0001" id="lon" value="${c.location.lon ?? ''}" placeholder="-73.5387"></label>
      </div>
      <div class="actions-row"><button class="btn sm" data-act="geo">Use this device's location</button></div>
    </section>
    <section class="panel block" id="backupBox">
      <h2>Saved versions</h2>
      <p class="muted small">Photon keeps a copy of your rooms, layouts and behaviors every 10 minutes while you make changes, and each time it starts. Bring back an older version here if something goes wrong. Your Plex sign-in and HTTPS settings stay as they are.</p>
      <div id="backupList"><p class="muted small">Loading…</p></div>
      <div class="actions-row"><button class="btn sm" data-act="backup-now">Save a copy now</button>
        <button class="btn sm" data-act="import-file">Import settings from another Photon…</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden></div>
      <p class="muted small">Moving from a copy you ran by hand? Pick the <b>config.json</b> in its <b>data</b> folder. Rooms, layouts, behaviors, Plex sign-in and light keys all come across.</p>
      <form class="export-row" id="exportForm" autocomplete="off">
        <label class="field"><span>Moving Photon to another computer or phone? Download everything, keys included. Keep the file somewhere safe.</span>
          <input type="password" id="exportPw" placeholder="Your Photon password" autocomplete="current-password" required></label>
        <button class="btn sm" type="submit">Download settings</button>
      </form>
    </section>
    <section class="panel block" id="set-webhook">
      <h2>Webhook security</h2>
      <p class="muted small">Each webhook address contains a secret key so only your server can trigger Photon. Make a new key if an address leaked, then update it in your media server.</p>
      <div><button class="btn sm danger" data-act="regen">Make a new key</button></div>
    </section>
  </div>`;
  bindJump();
  bindAccount();
  bindAppSettings();
  bindTls();
  loadBackups();
  api('GET', '/api/tls').then(t => { S.tls = t; if (S.view === 'settings') { $('#tlsBox').innerHTML = tlsHtml(); } }).catch(() => {});
}

function bindAppSettings() {
  $('.settings', app).addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'geo') {
      if (!navigator.geolocation) { toast('This browser cannot share its location. Type it in instead.', true); return; }
      navigator.geolocation.getCurrentPosition(pos => {
        S.config.location = { lat: round4(pos.coords.latitude), lon: round4(pos.coords.longitude) };
        commit(0); setTimeout(refreshMeta, 800);
      }, () => toast('Location was blocked. Browsers only share it on https or localhost, so type it in instead.', true));
    }
    if (act === 'regen') {
      if (!confirm('Make a new webhook key? The old webhook addresses stop working until you update them in your media server.')) return;
      try { const c = await api('POST', '/api/webhook-token/regenerate'); S.config.webhookToken = c.webhookToken; await refreshMeta(); toast('New key made. Update the webhook address in your media server (Connections shows it).'); } catch (err) { toast(err.message, true); }
    }
  });
  const locInput = () => {
    const lat = $('#lat').value, lon = $('#lon').value;
    S.config.location = { lat: lat === '' ? null : Number(lat), lon: lon === '' ? null : Number(lon) };
    commit(800); setTimeout(refreshMeta, 1600);
  };
  $('#lat').addEventListener('change', locInput);
  $('#lon').addEventListener('change', locInput);
}

// ---- saved versions ----
const REASON = { auto: 'While editing', startup: 'When Photon started', manual: 'Saved by you', 'before-restore': 'Before a restore', 'before-import': 'Before an import', unreadable: 'Unreadable file' };
async function loadBackups() {
  const box = $('#backupList');
  if (!box) return;
  let list = [];
  try { list = await api('GET', '/api/backups'); } catch { box.innerHTML = '<p class="muted small">Could not load the saved versions.</p>'; return; }
  box.innerHTML = list.length ? `<ul class="backups">${list.slice(0, 25).map(b => `
    <li><span><b>${b.time ? new Date(b.time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : esc(b.file)}</b>
      <span class="muted small">${esc(REASON[b.reason] || b.reason)}, ${b.unreadable ? "can't be read by this Photon" : `${b.rooms.length} room${b.rooms.length === 1 ? '' : 's'}`}${b.rooms.length ? `: ${esc(b.rooms.slice(0, 4).join(', '))}${b.rooms.length > 4 ? '…' : ''}` : ''}</span></span>
      <button class="btn sm" data-restore="${esc(b.file)}">Restore</button></li>`).join('')}</ul>`
    : '<p class="muted small">No saved versions yet. The first one is made the next time Photon starts or you change something.</p>';
  box.onclick = async e => {
    const btn = e.target.closest('[data-restore]');
    if (!btn) return;
    if (!confirm('Bring back this version? Your current rooms and layouts are saved as a copy first, so you can undo this.')) return;
    try {
      await saving;
      await api('POST', '/api/backups/restore', { file: btn.dataset.restore });
      S.config = await api('GET', '/api/config');
      S.dirty = false;
      toast('Restored. Your rooms and layouts are back to that version.');
      location.hash = '#rooms';
      render();
    } catch (err) { toast(err.message, true); }
  };
  const imp = $('[data-act="import-file"]'), file = $('#importFile');
  if (imp && file) {
    imp.onclick = () => { file.value = ''; file.click(); };
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { toast("That file isn't a Photon settings file (it isn't valid JSON).", true); return; }
      const n = Array.isArray(data?.rooms) ? data.rooms.length : 0;
      if (!confirm(`Replace the current settings with ${f.name} (${n} room${n === 1 ? '' : 's'})? The current settings are saved as a copy first, so you can undo this.`)) return;
      try {
        await saving;
        await api('POST', '/api/backups/import', { config: data });
        S.config = await api('GET', '/api/config');
        S.dirty = false; S.targetsLoaded = false; S.playersLoaded = false;
        await refreshMeta().catch(() => {});
        toast(`Imported ${n} room${n === 1 ? '' : 's'} and your connections.`);
        location.hash = '#rooms';
        render();
      } catch (err) { toast(err.message, true); }
    };
  }
  const exp = $('#exportForm');
  if (exp) exp.onsubmit = async e => {
    e.preventDefault();
    const btn = $('button', exp);
    btn.disabled = true;
    try {
      const res = await fetch('/api/backups/export', { method: 'POST', headers: apiHeaders('POST', true), body: JSON.stringify({ password: $('#exportPw').value }), credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'photon-settings.json';
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      exp.reset();
      toast('Downloaded. The file has your keys in it, so keep it private.');
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  };
  const now = $('[data-act="backup-now"]');
  if (now) now.onclick = async () => { try { await api('POST', '/api/backups/now'); toast('Saved a copy'); loadBackups(); } catch (err) { toast(err.message, true); } };
}

// ---- HTTPS ----
const fmtDate = iso => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

function certDetails(cert, { warnSelfSigned = false } = {}) {
  if (!cert) return '';
  return `<div class="cert">
    <div class="small muted">Covers these addresses</div>
    <div class="chips">${cert.names.map(n => `<span class="chip" aria-pressed="true">${esc(n)}</span>`).join('')}</div>
    <p class="small muted">Issued by ${esc(cert.issuer)}. Good until ${fmtDate(cert.validTo)} (${cert.daysLeft} days).</p>
    ${warnSelfSigned && cert.selfSigned ? '<p class="small warn-text">This certificate is self-signed, so each device has to trust it or browsers will keep warning.</p>' : ''}
  </div>`;
}

const INSTALL_STEPS = [
  ['Windows (Chrome, Edge)', 'Open the downloaded Photon-CA.crt and choose Install Certificate. Pick Current User, then "Place all certificates in the following store", choose Trusted Root Certification Authorities, and finish. Restart the browser.'],
  ['Mac (Safari, Chrome)', 'Open Photon-CA.crt to add it to Keychain Access. Find "Photon Local CA" in the login keychain, open it, expand Trust, and set "When using this certificate" to Always Trust. Close the window and enter your password.'],
  ['iPhone and iPad', 'Open this page in Safari and tap Download, then Allow. Go to Settings > General > VPN & Device Management, tap the Photon profile and Install. Then go to Settings > General > About > Certificate Trust Settings and turn on Photon Local CA.'],
  ['Android', 'Go to Settings > Security > More security settings > Encryption & credentials > Install a certificate > CA certificate, and pick Photon-CA.crt. The menu names vary a little between phone makers.'],
  ['Firefox (any computer)', 'Firefox can keep its own list. Go to Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import, pick Photon-CA.crt and tick "Trust this CA to identify websites".'],
  ['Linux (Chrome)', 'Go to chrome://certificate-manager (or Settings > Privacy and security > Security > Manage certificates), open Authorities or Custom, import Photon-CA.crt and allow it to identify websites.'],
];

function tlsHtml() {
  const t = S.tls;
  if (!t) return '<h2>Secure connection (HTTPS)</h2><p class="muted small">Checking…</p>';
  const view = S.tlsView || t.mode;
  const msg = S.tlsMsg;
  const status = t.active
    ? `<p class="tls-status on">HTTPS is on. Open Photon at ${t.urls.map(u => `<a href="${esc(u)}">${esc(u)}</a>`).join(' or ')}.</p>`
    : `<p class="tls-status">HTTPS is off. Browsers mark Photon "Not secure" and some features, like sharing your location, are blocked.</p>`;
  if (t.fromEnv) {
    return `<h2>Secure connection (HTTPS)</h2>${status}<p class="muted small">Photon is using the certificate set by the TLS_CERT_FILE and TLS_KEY_FILE settings, so it can't be changed here.</p>${certDetails(t.cert)}`;
  }
  let body = '';
  if (view === 'generated') {
    body = `
      <p class="small">Browsers only trust certificates from authorities they already know. Photon makes its own certificate authority. <b>Install it once on each device you use Photon from</b> and the warning goes away for good, including when Photon renews its certificate every year.</p>
      ${t.mode === 'generated' ? certDetails(t.cert) : ''}
      <label class="field"><span>Other names you use to reach Photon (optional, comma separated)</span>
        <input id="tlsNames" value="${esc((t.extraNames || []).join(', '))}" placeholder="photon.home.lan, media-pc"></label>
      <p class="muted small">Already covered: ${esc(t.suggestedNames.join(', '))}.</p>
      <div class="actions-row">
        <button class="btn sm ${t.mode === 'generated' ? '' : 'primary'}" data-tls="generate">${t.mode === 'generated' ? 'Update certificate' : 'Turn on HTTPS'}</button>
        ${t.ca ? '<a class="btn sm primary" href="/photon-ca.crt" download="Photon-CA.crt">Download Photon\'s certificate authority</a>' : ''}
      </div>
      ${t.ca ? `<p class="muted small">Authority fingerprint (SHA-256): <span class="mono">${esc(t.ca.fingerprint)}</span></p>
      <details class="install"><summary>How to install it on each device</summary>
        ${INSTALL_STEPS.map(([h, txt]) => `<div><b>${esc(h)}</b><p class="small">${esc(txt)}</p></div>`).join('')}
        <p class="small muted">After installing, close and reopen the browser, then open Photon with https.</p>
      </details>` : ''}`;
  } else if (view === 'custom') {
    body = `
      <p class="small">Use a certificate you already have, for example from your router, your company or Let's Encrypt. It has to include the address you type to open Photon, like photon.yourdomain.com.</p>
      ${t.hasCustom && t.mode === 'custom' ? certDetails(t.cert, { warnSelfSigned: true }) : ''}
      ${t.hasCustom && t.mode !== 'custom' ? '<div class="actions-row"><button class="btn sm" data-tls="use-custom">Use the certificate uploaded before</button></div>' : ''}
      <div class="upload-grid">
        <div class="upload-col">
          <b class="small">PEM files</b>
          <label class="field"><span>Certificate (.crt, .pem)</span><input type="file" id="tlsCert" accept=".crt,.pem,.cer"></label>
          <label class="field"><span>Private key (.key, .pem)</span><input type="file" id="tlsKey" accept=".key,.pem"></label>
          <label class="field"><span>Chain or intermediate (optional)</span><input type="file" id="tlsChain" accept=".crt,.pem,.cer"></label>
        </div>
        <div class="upload-col">
          <b class="small">Or one .pfx / .p12 file</b>
          <label class="field"><span>Certificate bundle</span><input type="file" id="tlsPfx" accept=".pfx,.p12"></label>
          <label class="field"><span>Bundle password</span><input type="password" id="tlsPass" autocomplete="off"></label>
        </div>
      </div>
      <div class="actions-row"><button class="btn sm primary" data-tls="upload">Use this certificate</button></div>`;
  } else {
    body = '<p class="small muted">Turn on HTTPS with a certificate Photon makes for you, or upload your own.</p>';
  }
  return `
    <h2>Secure connection (HTTPS)</h2>
    ${status}
    ${t.error ? `<p class="result err">${esc(t.error)}</p>` : ''}
    <div class="seg" role="group" aria-label="Certificate">
      <button data-tls-view="off" aria-pressed="${view === 'off'}">Off</button>
      <button data-tls-view="generated" aria-pressed="${view === 'generated'}">Photon's certificate</button>
      <button data-tls-view="custom" aria-pressed="${view === 'custom'}">My own certificate</button>
    </div>
    ${body}
    ${msg ? `<p class="result ${msg.ok ? 'ok' : 'err'}">${esc(msg.text)}</p>` : ''}
    ${view !== 'off' ? `<div class="settings-grid tls-settings">
      <label class="field"><span>HTTPS port</span><input type="number" min="1" max="65535" id="tlsPort" value="${t.httpsPort}"></label>
    </div>
    <label class="switch"><input type="checkbox" id="tlsRedirect" ${t.redirect ? 'checked' : ''} ${t.active ? '' : 'disabled'}><i></i>Always open Photon over HTTPS</label>
    <p class="muted small">Webhooks from your media server keep using plain HTTP on port ${S.meta.media[0]?.webhookUrl.match(/:(\d+)\//)?.[1] || '8787'}, so you don't need to change them.</p>` : ''}`;
}

function readFile(input, asBase64 = false) {
  const file = input?.files?.[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error(`Could not read ${file.name}`));
    fr.onload = () => resolve(asBase64 ? String(fr.result).split(',')[1] : fr.result);
    if (asBase64) fr.readAsDataURL(file); else fr.readAsText(file);
  });
}

function bindTls() {
  const box = $('#tlsBox');
  const done = (t, text, ok = true) => { S.tls = t; S.tlsView = null; S.tlsMsg = text ? { ok, text } : null; box.innerHTML = tlsHtml(); };
  const fail = err => { S.tlsMsg = { ok: false, text: err.message }; box.innerHTML = tlsHtml(); };
  const names = () => ($('#tlsNames')?.value || '').split(',').map(x => x.trim()).filter(Boolean);

  box.addEventListener('click', async e => {
    const v = e.target.closest('[data-tls-view]');
    if (v) {
      S.tlsMsg = null;
      if (v.dataset.tlsView === 'off') {
        if (S.tls.mode !== 'off') { try { done(await api('POST', '/api/tls/off'), 'HTTPS is off.'); } catch (err) { fail(err); } return; }
      }
      S.tlsView = v.dataset.tlsView;
      box.innerHTML = tlsHtml();
      return;
    }
    const b = e.target.closest('[data-tls]');
    if (!b) return;
    b.disabled = true;
    const label = b.textContent;
    try {
      if (b.dataset.tls === 'generate') {
        b.textContent = 'Making certificate…';
        const t = await api('POST', '/api/tls/generate', { extraNames: names() });
        done(t, t.active ? 'HTTPS is on. Now download the certificate authority and install it on your devices.' : (t.error || 'Certificate made, but HTTPS did not start.'), t.active);
      } else if (b.dataset.tls === 'use-custom') {
        done(await api('POST', '/api/tls/settings', { mode: 'custom' }), 'Using your certificate.');
      } else if (b.dataset.tls === 'upload') {
        const [cert, key, chain, pfx] = await Promise.all([readFile($('#tlsCert')), readFile($('#tlsKey')), readFile($('#tlsChain')), readFile($('#tlsPfx'), true)]);
        if (!pfx && (!cert || !key)) throw new Error('Pick a certificate and its private key, or a .pfx file.');
        const t = await api('POST', '/api/tls/custom', pfx ? { pfx, passphrase: $('#tlsPass').value } : { cert, key, chain });
        done(t, t.active ? 'HTTPS is on with your certificate.' : (t.error || 'Saved, but HTTPS did not start.'), t.active);
      }
    } catch (err) {
      b.disabled = false; b.textContent = label;
      fail(err);
    }
  });
  box.addEventListener('change', async e => {
    try {
      if (e.target.id === 'tlsPort') done(await api('POST', '/api/tls/settings', { httpsPort: Number(e.target.value) }), `HTTPS port is now ${e.target.value}.`);
      if (e.target.id === 'tlsRedirect') done(await api('POST', '/api/tls/settings', { redirect: e.target.checked }), e.target.checked ? 'Browsers opening the plain address are now sent to HTTPS.' : 'Plain HTTP works in the browser again.');
    } catch (err) { fail(err); }
  });
}

let plexPoll = null;
async function plexSignIn(btn) {
  // Open the window right away so the browser doesn't block it as a popup.
  const win = window.open('about:blank', 'plex-auth', 'width=520,height=720');
  btn.disabled = true;
  btn.textContent = 'Waiting for Plex…';
  try {
    const pin = await api('POST', '/api/plex/signin');
    if (win) win.location.href = pin.url; else window.open(pin.url, '_blank');
    const started = Date.now();
    clearInterval(plexPoll);
    plexPoll = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000) { clearInterval(plexPoll); S.results.plex = { ok: false, msg: 'Sign-in timed out. Try again.' }; renderConnections(); return; }
      try {
        const res = await api('GET', `/api/plex/signin/${pin.id}`);
        if (!res.done) return;
        clearInterval(plexPoll);
        try { win?.close(); } catch { /* cross-origin */ }
        S.config = await api('GET', '/api/config');
        S.plex = { account: res.account, servers: res.servers, homeUsers: res.homeUsers };
        S.playersLoaded = false;
        S.results.plex = { ok: true, msg: `Signed in as ${res.account?.name}. ${res.homeUsers.length} ${res.homeUsers.length === 1 ? 'person' : 'people'} in your Plex Home.` };
        renderConnections();
      } catch (err) {
        clearInterval(plexPoll);
        S.results.plex = { ok: false, msg: err.message };
        renderConnections();
      }
    }, 1500);
  } catch (err) {
    try { win?.close(); } catch { /* ignore */ }
    S.results.plex = { ok: false, msg: err.message };
    renderConnections();
  }
}

function bindConnections() {
  const root = $('.conn', app);
  const onField = e => {
    const { kind, sys, key } = e.target.dataset;
    if (!kind) return;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'number' && v !== '') v = Number(v);
    S.config[kind][sys][key] = v;
    if (key === 'enabled') {
      S.targetsLoaded = false; S.playersLoaded = false;
      if (v) S.openSys = sys;
      commit(0); renderConnections(); return;
    }
    commit(800);
  };
  root.addEventListener('input', e => { if (e.target.type !== 'checkbox') onField(e); });
  root.addEventListener('change', e => { if (e.target.type === 'checkbox') onField(e); });

  root.querySelectorAll('[data-brand]').forEach(inp => inp.addEventListener('input', () => {
    S.config.brandColors[inp.dataset.brand] = inp.value;
    inp.closest('.sys').style.setProperty('--c', inp.value);
    commit();
  }));

  $('#plexServer', root)?.addEventListener('change', e => { S.config.media.plex.serverId = e.target.value; commit(0); });

  root.addEventListener('click', async e => {
    const head = e.target.closest('[data-open-sys]');
    if (head && !e.target.closest('.switch')) { S.openSys = S.openSys === head.dataset.openSys ? null : head.dataset.openSys; renderConnections(); return; }
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      const inp = $(`#${copy.dataset.copy}`);
      try { await navigator.clipboard.writeText(inp.value); toast('Copied'); } catch { inp.select(); toast('Press Ctrl+C to copy'); }
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'plex-signin') { plexSignIn(e.target.closest('button')); return; }
    if (act === 'plex-signout') {
      const res = await api('POST', '/api/plex/signout');
      S.config.media.plex = res.config; S.plex = { account: null, servers: [], homeUsers: [] }; S.results.plex = null; S.playersLoaded = false;
      renderConnections(); return;
    }
    if (act === 'plex-webhook') {
      const b = e.target.closest('button'); b.disabled = true;
      try { const r = await api('POST', '/api/plex/webhook'); S.plex.webhook = r.webhook; S.results.plex = { ok: true, msg: r.message }; }
      catch (err) { S.results.plex = { ok: false, msg: err.message }; await loadPlex(); }
      renderConnections(); return;
    }
    if (act === 'plex-token') {
      try {
        const res = await api('POST', '/api/plex/token', { token: $('#plexToken').value });
        S.config.media.plex = res.config; S.plex = { account: res.account, servers: res.servers, homeUsers: res.homeUsers }; S.playersLoaded = false;
        S.results.plex = { ok: true, msg: `Signed in as ${res.account?.name}.` };
      } catch (err) { S.results.plex = { ok: false, msg: err.message }; }
      renderConnections(); return;
    }
    const sa = e.target.closest('[data-sys-action]');
    const test = e.target.closest('[data-test]');
    const btn = sa || test;
    if (btn) {
      const { kind } = btn.dataset;
      const id = sa ? sa.dataset.sys : test.dataset.test;
      btn.disabled = true;
      const PAIR_HINT = {
        dirigera: 'Now press the action button on the bottom of the DIRIGERA hub. You have a minute.',
        lutron: 'Now press the small black button on the back of the Lutron bridge.',
        lg: 'Now choose Accept on the TV screen. You have a minute.',
        androidtv: 'Now choose Allow on the TV screen and tick "Always allow". You have a minute.',
      };
      if (sa && PAIR_HINT[id] && sa.dataset.sysAction === 'pair') {
        btn.textContent = ['lg', 'androidtv'].includes(id) ? 'Waiting for the TV…' : 'Waiting for the hub button…';
        toast(PAIR_HINT[id]);
      }
      try {
        await saving;
        const path = sa ? `/api/${kind}/${id}/action/${sa.dataset.sysAction}` : `/api/${kind}/${id}/test`;
        const res = await api('POST', path, { config: S.config[kind][id] });
        if (res.patch) {
          // The server saved the new keys itself and only says they're saved.
          Object.assign(S.config[kind][id], res.patch);
          if (res.editRev) S.config.editRev = res.editRev;
          commit(0);
        }
        S.results[id] = { ok: true, msg: res.message };
        S.targetsLoaded = false; S.playersLoaded = false;
      } catch (err) {
        S.results[id] = { ok: false, msg: err.message };
      }
      renderConnections();
      return;
    }
  });
}
function bioSectionHtml() {
  if (!bio) return '';
  const st = bio.status().status;
  const why = { 'no-lock': 'Set a screen lock and add a fingerprint or face in the phone\'s settings first.', 'none-enrolled': 'Add a fingerprint or face in the phone\'s settings first.', unsupported: 'This phone can\'t do it (it needs Android 9 or newer and a fingerprint reader or secure face unlock).' }[st];
  return `<div class="bio-box" id="bioBox">
    <h3>Fingerprint or face on this phone</h3>
    ${st === 'on' ? `<p class="muted small">On. Photon asks for your fingerprint or face instead of the password in this app.</p>
      <div class="actions-row"><button class="btn sm" type="button" data-act="bio-off">Turn off</button></div>`
    : st === 'available' ? `<p class="muted small">Sign in to Photon in this app with your fingerprint or face instead of typing the password. It only works on this phone, and changing the password turns it off.</p>
      <form id="bioForm" class="export-row" autocomplete="off">
        <label class="field"><span>Your Photon password</span><input type="password" id="bioPw" autocomplete="current-password" required></label>
        <button class="btn sm" type="submit">Turn on</button></form>`
    : `<p class="muted small">${why}</p>`}
  </div>`;
}

function bindAccountBio() {
  $('#bioForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#bioForm button');
    btn.disabled = true;
    try {
      if (await bio.enable($('#bioPw').value)) toast('Fingerprint or face sign-in is on for this phone.');
      $('#bioBox').outerHTML = bioSectionHtml();
      bindAccountBio();
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  });
}

function bindAccount() {
  bindAccountBio();
  $('#pwForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const cur = $('#pwCurrent').value, next = $('#pwNew').value, again = $('#pwAgain').value;
    if (next !== again) { toast('The two new passwords are different.', true); return; }
    const btn = $('#pwForm button[type=submit]');
    btn.disabled = true;
    try {
      await api('POST', '/api/auth/password', { current: cur, password: next });
      S.csrf = (await api('GET', '/api/auth/state')).csrf; // a new session for this device
      $('#pwForm').reset();
      toast('Password changed. Every other device has to sign in again.');
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });
  $('#set-account')?.addEventListener('click', async e => {
    if (e.target.closest('[data-act="bio-off"]')) {
      await bio.disable();
      toast('Fingerprint or face sign-in is off for this phone.');
      $('#bioBox').outerHTML = bioSectionHtml();
      bindAccountBio();
      return;
    }
    const act = e.target.closest('[data-act="sign-out"], [data-act="sign-out-all"]')?.dataset.act;
    if (!act) return;
    if (act === 'sign-out-all' && !confirm('Sign out every device, including this one?')) return;
    try { await api('POST', act === 'sign-out' ? '/api/auth/logout' : '/api/auth/logout-all'); } catch { /* signed out either way */ }
    location.reload();
  });
}

// ---------------------------------------------------------------------------
// SIGN IN
// ---- Fingerprint or face sign-in (Photon's Android app) ----------------------------------
// The app keeps a device key that only the phone's fingerprint or face can unlock, using
// Android's keystore. Photon only ever gets the key, never anything about the fingerprint.
const bio = (() => {
  const A = window.PhotonAndroid;
  if (!A?.biometricStatus) return null;
  const pending = new Map();
  let seq = 0;
  window.__photonBiometric = r => { const p = pending.get(r.req); if (p) { pending.delete(r.req); p(r); } };
  const call = (method, ...args) => new Promise(resolve => { const req = ++seq; pending.set(req, resolve); A[method](req, ...args); });
  const status = () => { try { return JSON.parse(A.biometricStatus()); } catch { return { status: 'unsupported' }; } };
  return {
    status,
    usable: () => ['available', 'on'].includes(status().status),
    // Turns it on: Photon makes a device key (checking the password), the phone locks it
    // behind the fingerprint or face. If the phone part doesn't finish, the key is removed.
    async enable(password) {
      const st = status();
      const res = await fetch('/api/auth/devices', { method: 'POST', credentials: 'same-origin', headers: apiHeaders('POST', true), body: JSON.stringify({ password, name: st.model || 'Phone' }) });
      const dev = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(dev.error || `${res.status} ${res.statusText}`);
      const r = await call('biometricEnable', dev.id, dev.token);
      if (!r.ok) {
        fetch(`/api/auth/devices/${encodeURIComponent(dev.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: apiHeaders('DELETE', false) }).catch(() => {});
        if (r.canceled) return false;
        throw new Error(r.error || "The phone didn't turn on fingerprint or face sign-in.");
      }
      return true;
    },
    async disable() {
      const st = status();
      call('biometricDisable');
      if (st.id) await fetch(`/api/auth/devices/${encodeURIComponent(st.id)}`, { method: 'DELETE', credentials: 'same-origin', headers: apiHeaders('DELETE', false) }).catch(() => {});
    },
    // Asks for the fingerprint or face and signs in. Resolves true when signed in.
    async signIn() {
      const r = await call('biometricUnlock');
      if (!r.ok) {
        if (r.canceled) return false;
        throw new Error(r.error || "Fingerprint or face sign-in didn't work. Use your password.");
      }
      const res = await fetch('/api/auth/device-login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id, token: r.token }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.deviceGone) call('biometricDisable');
        throw new Error(data.error || `${res.status} ${res.statusText}`);
      }
      return true;
    },
  };
})();

// Right after signing in with the password in the app: offer fingerprint or face next time.
async function offerBiometric(password) {
  if (!bio || bio.status().status !== 'available') return;
  try { if (localStorage.getItem('photon.bioOffer') === 'no') return; } catch { /* no storage */ }
  if (!confirm('Use your fingerprint or face to sign in to Photon on this phone next time?')) {
    try { localStorage.setItem('photon.bioOffer', 'no'); } catch { /* no storage */ }
    return;
  }
  try {
    S.csrf = (await (await fetch('/api/auth/state', { credentials: 'same-origin' })).json()).csrf;
    await bio.enable(password);
  } catch (err) { alert(err.message); }
}

function showAuth(mode, { code = '', expired = false, minLength = 10 } = {}) {
  if (document.body.classList.contains('signed-out') && $('#authForm')?.dataset.mode === mode) return;
  S.config = null;
  if (view3d) { view3d.dispose(); view3d = null; }
  document.body.classList.add('signed-out');
  document.body.classList.remove('sheet-open', 'pop-open');
  $('#pageTitle').textContent = mode === 'setup' ? 'Welcome' : 'Sign in';
  setSaveState('');
  const hidden = '<input type="text" name="username" autocomplete="username" value="Photon" class="sr-only" tabindex="-1" aria-hidden="true" readonly>';
  app.innerHTML = `<section class="panel auth" aria-labelledby="authTitle">
    <img src="photon-hero.png" alt="Photon" width="1100" height="314">
    ${mode === 'setup' ? `
      <h1 id="authTitle">Choose a password for Photon</h1>
      <p class="muted">Photon keeps the keys to your lights, TVs and media server, so it needs a password. You'll use it to open Photon on any device.</p>
      <form id="authForm" data-mode="setup" novalidate>
        <label class="field"><span>Setup code</span><input id="setupCode" value="${esc(code)}" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" required></label>
        <p class="muted small">It's shown where Photon was installed or started, and kept in the file called setup-code in Photon's settings folder.</p>
        ${hidden}
        <label class="field"><span>New password</span><input type="password" id="pw1" autocomplete="new-password" required></label>
        <label class="field"><span>Type it again</span><input type="password" id="pw2" autocomplete="new-password" required></label>
        <p class="muted small">At least ${minLength} characters. A few unrelated words together make a password that's strong and easy to remember.</p>
        <label class="switch"><input type="checkbox" id="showPw"><i></i>Show password</label>
        <p class="result err" id="authErr" role="alert"></p>
        <button class="btn primary" type="submit">Save password and open Photon</button>
      </form>` : `
      <h1 id="authTitle">Sign in to Photon</h1>
      <p class="muted">${expired ? 'You were signed out on this device. Sign in again to carry on.' : 'Type the password chosen when Photon was installed.'}</p>
      <form id="authForm" data-mode="login" novalidate>
        ${hidden}
        <label class="field"><span>Password</span><input type="password" id="pw1" autocomplete="current-password" required></label>
        <label class="switch"><input type="checkbox" id="showPw"><i></i>Show password</label>
        <p class="result err" id="authErr" role="alert"></p>
        <button class="btn primary" type="submit">Sign in</button>
        ${bio?.status().status === 'on' ? '<button class="btn" type="button" id="bioSignIn">Sign in with fingerprint or face</button>' : ''}
        <p class="muted small">${window.PhotonAndroid ? 'Forgot it? See "Forgot your password?" in Photon\'s install guide.' : 'Forgot it? On the computer Photon runs on, run Photon\'s installer again and choose a new password, or see "Forgot the password" in the troubleshooting guide.'}</p>
      </form>`}
  </section>`;
  const form = $('#authForm');
  $('#showPw').addEventListener('change', e => $$('input[type=password], input[data-pw]', form).forEach(i => { i.type = e.target.checked ? 'text' : 'password'; i.dataset.pw = '1'; }));
  const bioBtn = $('#bioSignIn');
  if (bioBtn) {
    const tryBio = async () => {
      $('#authErr').textContent = '';
      bioBtn.disabled = true;
      try { if (await bio.signIn()) { location.reload(); return; } } catch (err) { $('#authErr').textContent = err.message; if (bio.status().status !== 'on') bioBtn.remove(); }
      bioBtn.disabled = false;
    };
    bioBtn.addEventListener('click', tryBio);
    tryBio(); // ask straight away, like other apps do; Cancel leaves the password field
  } else {
    (mode === 'setup' && !code ? $('#setupCode') : $('#pw1')).focus();
  }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#authErr');
    err.textContent = '';
    const pw = $('#pw1').value;
    if (mode === 'setup' && pw !== $('#pw2').value) { err.textContent = 'The two passwords are different.'; return; }
    if (!pw) { err.textContent = 'Type the password.'; return; }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const res = await fetch(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'setup' ? { code: $('#setupCode').value, password: pw } : { password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
      await offerBiometric(pw);
      location.reload();
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
      $('#pw1').select();
    }
  });
}

function randomColorHex() { return `#${randomRgb().map(v => v.toString(16).padStart(2, '0')).join('')}`; }
const round4 = v => Math.round(v * 1e4) / 1e4;

async function refreshMeta() {
  try { S.meta = await api('GET', '/api/meta'); } catch { return; }
  if (S.view === 'connections') renderConnections();
  else if (S.view === 'settings') renderSettings();
}

// ---------------------------------------------------------------------------
// ACTIVITY
function renderActivity() {
  const home = S.config.media.plex?.enabled && S.config.media.plex.homeOnly !== false && S.plex.homeUsers?.length;
  app.innerHTML = `<div class="activity">
    <div class="section-head"><h1>Activity</h1><p>${home ? 'Playback from the people in your Plex Home' : 'What Photon heard from your media server'} and what it did with the lights.</p></div>
    <section class="panel"><ul class="log" id="log"></ul></section>
  </div>`;
  fillLog();
  pollLog();
  $('#log').addEventListener('change', e => {
    const sel = e.target.closest('[data-log-player]');
    if (!sel || !sel.value) return;
    const r = S.config.rooms.find(x => x.id === sel.value);
    const key = sel.dataset.logPlayer;
    if (!r.players.includes(key)) r.players.push(key);
    if (sel.dataset.logName) r.playerNames = { ...(r.playerNames || {}), [key]: sel.dataset.logName };
    commit(0);
    S.playersLoaded = false;
    toast(`Added ${sel.dataset.logName || 'the player'} to ${r.name}. It will control those lights from now on.`);
    fillLog();
  });
}
function fillLog() {
  const ul = $('#log');
  if (!ul) return;
  ul.innerHTML = S.log.length
    ? S.log.map(l => {
      const canAdd = l.playerKey && S.config.rooms.length && !S.config.rooms.some(r => r.players.includes(l.playerKey));
      return `<li class="${l.level}"><time datetime="${l.time}">${new Date(l.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time><span class="dot"></span>
        <span>${esc(l.msg)}${canAdd ? `<select class="add-to-room" data-log-player="${esc(l.playerKey)}" data-log-name="${esc(l.playerName || '')}" aria-label="Add this player to a room">
          <option value="">Add to a room…</option>${S.config.rooms.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>` : ''}</span></li>`;
    }).join('')
    : `<li class="empty-state" style="display:block">Nothing yet. Play something on a player that's in a room, or use "Run on real lights" in a room.</li>`;
}
async function pollLog() {
  if (S.view !== 'activity') return;
  try {
    S.log = await api('GET', '/api/log');
    if (!document.activeElement?.matches?.('.add-to-room')) fillLog();
  } catch { /* retry */ }
  setTimeout(pollLog, 3000);
}

// ---------------------------------------------------------------------------
// live status
async function pollStatus() {
  try {
    const next = await api('GET', '/api/status');
    const changed = JSON.stringify(next) !== JSON.stringify(S.status);
    S.status = next;
    if (changed && S.view === 'rooms' && room()) {
      const list = $('#roomList');
      if (list) list.innerHTML = S.config.rooms.map(roomLink).join('');
      const np = $('#nowPlaying');
      if (np) np.outerHTML = nowPlayingHtml(room());
      updatePlanLook();
    }
  } catch { /* server restarting */ }
}

// ---------------------------------------------------------------------------
async function boot() {
  let st;
  try {
    const r = await fetch('/api/auth/state', { credentials: 'same-origin' });
    st = await r.json();
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Photon's server isn't answering (${esc(err.message)}). Check that it's running, then reload.</div>`;
    return;
  }
  // The installers and the Android app can hand over the setup code in the address.
  const m = /^#setup=([A-Za-z0-9-]+)/.exec(location.hash);
  if (m) history.replaceState(null, '', `${location.pathname}#rooms`);
  let fromApp = '';
  try { fromApp = st.setup && window.PhotonAndroid?.setupCode ? String(window.PhotonAndroid.setupCode() || '') : ''; } catch { /* not the app */ }
  if (st.setup) { showAuth('setup', { code: m?.[1] || fromApp, minLength: st.minLength }); return; }
  if (!st.signedIn) { showAuth('login', { minLength: st.minLength }); return; }
  S.csrf = st.csrf;
  document.body.classList.remove('signed-out');
  try {
    [S.meta, S.config, S.status, S.preview] = await Promise.all([api('GET', '/api/meta'), api('GET', '/api/config'), api('GET', '/api/status'), api('GET', '/api/preview')]);
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Photon's server isn't answering (${esc(err.message)}). Check that it's running, then reload.</div>`;
    return;
  }
  await loadPlex();
  // Show the version as 1.0 rather than 1.0.0, and the patch number only when it isn't 0.
  const v = String(S.meta.version || '').replace(/\.0$/, '');
  if (v) { const el = $('#appVersion'); el.textContent = `v${v}`; el.title = `Photon version ${S.meta.version}`; }
  const list = document.createElement('datalist');
  list.id = 'timePresets';
  list.innerHTML = ['sunset', 'sunset-30', 'sunset+30', 'sunrise', 'sunrise+30', 'dusk', 'dawn', '18:00', '20:00', '22:00', '23:00', '00:00', '06:00', '07:00', '08:00'].map(v => `<option value="${v}">`).join('');
  document.body.appendChild(list);
  if (!location.hash) location.hash = '#rooms';
  route();
  setSaveState('');
  setInterval(pollStatus, 4000);
  setInterval(syncFromServer, 4000);
  setInterval(refreshPreview, 60000); // time windows move with the clock
}
boot();
