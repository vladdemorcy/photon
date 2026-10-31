/* QUINN: voice-driven HUD for Claude Code */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('quinn.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('quinn.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const settings = {
    voice: store.get('voice', ''),
    rate: store.get('rate', 1.0),
    pitch: store.get('pitch', 0.95),
    wake: store.get('wake', true),
    speak: store.get('speak', true),
    sfx: store.get('sfx', true),
  };

  const state = {
    mode: 'idle',           // idle | listening | thinking | speaking | error
    sessionId: store.get('sessionId', null),
    spend: store.get('spend', 0),
    controller: null,
    capture: false,         // next utterance is a command, no wake word needed
    captureTimer: null,
    level: 0,               // 0..1 audio level that drives the visuals
    freq: new Uint8Array(64),
    cpuHistory: [],
    opsCount: 0,
    logCount: 0,
  };

  const WAKE = /\b(quinn|quin|qwin|quinne|queen)\b[,.!?]?\s*/i;

  /* ---------- Sound effects ---------- */
  let actx = null;
  function tone(freq, dur = 0.08, type = 'sine', gain = 0.05, when = 0) {
    if (!settings.sfx || !actx) return;
    const t = actx.currentTime + when;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sfx = {
    listen() { tone(880, 0.07, 'sine'); tone(1320, 0.09, 'sine', 0.05, 0.07); },
    accept() { tone(660, 0.06, 'triangle'); tone(990, 0.06, 'triangle', 0.04, 0.06); tone(1480, 0.1, 'triangle', 0.03, 0.12); },
    done() { tone(1200, 0.08, 'sine', 0.035); tone(800, 0.14, 'sine', 0.03, 0.08); },
    error() { tone(220, 0.18, 'sawtooth', 0.04); tone(165, 0.25, 'sawtooth', 0.04, 0.16); },
    boot() { [220, 330, 440, 660, 880].forEach((f, i) => tone(f, 0.12, 'triangle', 0.035, i * 0.09)); },
  };

  /* ---------- Microphone level (for the visuals) ---------- */
  let analyser = null;
  async function startMicMeter() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const src = actx.createMediaStreamSource(stream);
      analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      setChip('chipMic', 'on');
      return true;
    } catch (e) {
      setChip('chipMic', 'bad');
      logMsg('sys', `Microphone unavailable: ${e.message}. You can still type directives.`);
      return false;
    }
  }

  const freqBuf = new Uint8Array(128);
  function sampleAudio(t) {
    let target = 0;
    if (state.mode === 'speaking') {
      // Speech synthesis output can't be tapped, so synthesise a lively level.
      target = 0.35 + 0.3 * Math.abs(Math.sin(t / 90)) * Math.abs(Math.sin(t / 37)) + Math.random() * 0.15;
      for (let i = 0; i < 64; i++) state.freq[i] = 255 * Math.max(0, target - i / 90 + Math.random() * 0.25);
    } else if (analyser && (state.mode === 'listening' || state.mode === 'idle')) {
      analyser.getByteFrequencyData(freqBuf);
      let sum = 0;
      for (let i = 0; i < 64; i++) { state.freq[i] = freqBuf[i + 2]; sum += freqBuf[i + 2]; }
      target = Math.min(1, (sum / 64 / 255) * 2.6);
      if (state.mode === 'idle') target *= 0.5;
    } else if (state.mode === 'thinking') {
      target = 0.25 + 0.12 * Math.sin(t / 160);
      for (let i = 0; i < 64; i++) state.freq[i] = 90 + 80 * Math.sin(t / 120 + i / 3);
    } else {
      state.freq.fill(0);
    }
    state.level += (target - state.level) * 0.18;
  }

  /* ---------- Reactor ---------- */
  const reactor = $('reactor');
  const rctx = reactor.getContext('2d');
  const wave = $('wave');
  const wctx = wave.getContext('2d');
  let accent = '#38e8ff';

  function fitCanvas(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = c.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return dpr;
  }

  function rgba(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function arc(ctx, r, a0, a1, width, color, blur = 0) {
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a1);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.shadowBlur = blur;
    ctx.shadowColor = color;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawReactor(t) {
    fitCanvas(reactor);
    const w = reactor.width, h = reactor.height;
    const R = Math.min(w, h) / 2 * 0.96;
    const L = state.level;
    const speed = state.mode === 'thinking' ? 3.2 : state.mode === 'listening' ? 1.6 : 1;
    const ctx = rctx;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);

    // Outer tick ring
    ctx.save();
    ctx.rotate(t / 24000 * speed);
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * Math.PI * 2;
      const long = i % 15 === 0;
      const r1 = R * (long ? 0.9 : 0.935);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * R * 0.96, Math.sin(a) * R * 0.96);
      ctx.lineWidth = long ? 2.2 : 1;
      ctx.strokeStyle = rgba(accent, long ? 0.9 : 0.35);
      ctx.stroke();
    }
    ctx.restore();

    // Segmented arcs, counter-rotating
    ctx.save();
    ctx.rotate(-t / 9000 * speed);
    const segs = [[0, 1.1], [1.35, 2.6], [2.85, 3.5], [3.75, 5.3], [5.55, 6.05]];
    segs.forEach(([a, b], i) => arc(ctx, R * 0.84, a, b, R * 0.022, rgba(accent, i === 2 ? 0.95 : 0.55), 12));
    arc(ctx, R * 0.84, 3.5, 3.75, R * 0.04, rgba('#ffb547', 0.9), 14);
    ctx.restore();

    // Thin dashed ring with a scanner sweep
    ctx.save();
    ctx.rotate(t / 5000 * speed);
    ctx.setLineDash([R * 0.01, R * 0.02]);
    arc(ctx, R * 0.76, 0, Math.PI * 2, 1.5, rgba(accent, 0.45));
    ctx.setLineDash([]);
    const grad = ctx.createConicGradient ? ctx.createConicGradient(0, 0, 0) : null;
    if (grad) {
      grad.addColorStop(0, rgba(accent, 0));
      grad.addColorStop(0.18, rgba(accent, 0.35));
      grad.addColorStop(0.19, rgba(accent, 0));
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.76, 0, Math.PI * 2);
      ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2, true);
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.restore();

    // Audio bars radiating from the coil ring
    const bars = 64;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const v = state.freq[i < 32 ? i : 63 - i] / 255;
      const r0 = R * 0.56;
      const r1 = r0 + R * (0.015 + v * 0.17);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineWidth = R * 0.012;
      ctx.strokeStyle = rgba(accent, 0.25 + v * 0.75);
      ctx.stroke();
    }

    // Arc-reactor coils
    ctx.save();
    ctx.rotate(t / 14000 * speed);
    const coils = 10;
    for (let i = 0; i < coils; i++) {
      const a0 = (i / coils) * Math.PI * 2 + 0.06;
      const a1 = ((i + 1) / coils) * Math.PI * 2 - 0.06;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.52, a0, a1);
      ctx.arc(0, 0, R * 0.38, a1 - 0.03, a0 + 0.03, true);
      ctx.closePath();
      const lit = 0.18 + L * 0.6 + (Math.sin(t / 400 + i) + 1) * 0.06;
      ctx.fillStyle = rgba(accent, Math.min(0.85, lit));
      ctx.shadowBlur = 18 * (0.4 + L);
      ctx.shadowColor = accent;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba('#e8ffff', 0.5);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.restore();

    // Orbiting markers while thinking
    if (state.mode === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const a = t / 300 + (i * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R * 0.66, Math.sin(a) * R * 0.66, R * 0.018, 0, Math.PI * 2);
        ctx.fillStyle = '#ffb547';
        ctx.shadowBlur = 16;
        ctx.shadowColor = '#ffb547';
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // Core
    const coreR = R * (0.3 + L * 0.06);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    g.addColorStop(0, 'rgba(240,255,255,0.95)');
    g.addColorStop(0.25, rgba(accent, 0.55 + L * 0.3));
    g.addColorStop(0.7, rgba(accent, 0.12));
    g.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, Math.PI * 2);
    ctx.fill();
    arc(ctx, R * 0.33, 0, Math.PI * 2, 1.5, rgba('#e8ffff', 0.5), 10);

    ctx.restore();
  }

  function drawWave(t) {
    const dpr = fitCanvas(wave);
    const w = wave.width, h = wave.height;
    wctx.clearRect(0, 0, w, h);
    wctx.lineWidth = 1.5 * dpr;
    for (let k = 0; k < 3; k++) {
      wctx.beginPath();
      for (let x = 0; x <= w; x += 3 * dpr) {
        const p = x / w;
        const env = Math.sin(p * Math.PI);
        const amp = (h / 2 - 2) * (0.06 + state.level) * env;
        const y = h / 2 + Math.sin(p * (10 + k * 4) + t / (180 - k * 40)) * amp * (1 - k * 0.25);
        if (x === 0) wctx.moveTo(x, y); else wctx.lineTo(x, y);
      }
      wctx.strokeStyle = rgba(accent, 0.8 - k * 0.25);
      wctx.stroke();
    }
  }

  function frame(t) {
    sampleAudio(t);
    drawReactor(t);
    drawWave(t);
    requestAnimationFrame(frame);
  }

  /* ---------- State + UI helpers ---------- */
  const SUBS = {
    idle: () => (settings.wake && recognizer ? 'Say “Quinn” to begin' : 'Click the mic or hold Space'),
    listening: () => 'Listening…',
    thinking: () => 'Processing directive',
    speaking: () => 'Transmitting',
    error: () => 'Fault detected',
  };
  const LABELS = { idle: 'Standby', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', error: 'Alert' };

  function setMode(mode, sub) {
    state.mode = mode;
    document.body.className = 'state-' + mode;
    $('stateLabel').textContent = LABELS[mode];
    $('stateSub').textContent = sub || SUBS[mode]();
    accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#38e8ff';
    $('abortBtn').hidden = !(mode === 'thinking' || mode === 'speaking');
  }

  function setChip(id, cls) {
    const el = $(id);
    el.classList.remove('on', 'warn', 'bad');
    if (cls) el.classList.add(cls);
  }

  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Small, safe markdown subset: code blocks, inline code, bold, italics, paragraphs.
  function md(text) {
    const parts = String(text).split(/```[\w-]*\n?/);
    return parts.map((chunk, i) => {
      if (i % 2) return `<pre><code>${esc(chunk.replace(/\n$/, ''))}</code></pre>`;
      return esc(chunk)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
        .split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    }).join('');
  }

  const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function logMsg(kind, text, { html = false } = {}) {
    const names = { user: 'You', quinn: 'Quinn', sys: 'System', err: 'Fault' };
    const el = document.createElement('div');
    el.className = 'msg ' + kind;
    el.innerHTML = `<header><b>${names[kind]}</b><time>${now()}</time></header><div class="body"></div>`;
    el.querySelector('.body').innerHTML = html ? text : md(text);
    const log = $('log');
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    $('logCount').textContent = ++state.logCount;
    return el;
  }

  function addOp(name, summary) {
    const li = document.createElement('li');
    li.innerHTML = `<b></b><time>${now()}</time><span></span>`;
    li.querySelector('b').textContent = name;
    li.querySelector('span').textContent = summary || '—';
    const ops = $('ops');
    ops.prepend(li);
    while (ops.children.length > 60) ops.lastChild.remove();
    $('opsCount').textContent = ++state.opsCount;
  }

  function showReply(text) {
    $('reply').innerHTML = md(text);
  }

  function updateSession(extra = {}) {
    $('sessId').textContent = state.sessionId ? state.sessionId.slice(0, 8) + '…' : 'new';
    $('sessCost').textContent = '$' + state.spend.toFixed(4);
    if (extra.model) $('sessModel').textContent = extra.model;
    if (extra.run) $('sessRun').textContent = extra.run;
  }

  /* ---------- Speech output ---------- */
  const synth = window.speechSynthesis;
  let voices = [];
  const PREFERRED = [/Google UK English Female/i, /Sonia.*Online/i, /Libby.*Online/i, /Aria.*Online/i, /Jenny.*Online/i, /Samantha/i, /Serena/i, /Karen/i, /Moira/i, /Female/i];

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices().filter((v) => /^en/i.test(v.lang));
    const sel = $('setVoice');
    sel.innerHTML = '';
    voices.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(o);
    });
    if (!settings.voice || !voices.some((v) => v.name === settings.voice)) {
      const pick = PREFERRED.map((re) => voices.find((v) => re.test(v.name))).find(Boolean) || voices[0];
      if (pick) settings.voice = pick.name;
    }
    sel.value = settings.voice;
    setChip('chipVoice', voices.length ? (settings.speak ? 'on' : 'warn') : 'bad');
  }

  // Turns a reply into something worth hearing: the opening, minus markup.
  function spokenText(text) {
    let s = String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');
    s = s.split(/\n\s*\n/).find((p) => p.trim() && !/^\s*[|#-]/.test(p)) || s;
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_#>|]/g, '').replace(/\s+/g, ' ').trim();
    if (s.length > 480) s = s.slice(0, 480).replace(/[^.!?]*$/, '') || s.slice(0, 480);
    return s;
  }

  let speechToken = 0;
  function speak(text, { force = false } = {}) {
    return new Promise((resolve) => {
      if (!synth || (!settings.speak && !force) || !text) return resolve();
      synth.cancel();
      const token = ++speechToken;
      // Chrome drops long utterances, so speak sentence by sentence.
      const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
      const voice = voices.find((v) => v.name === settings.voice);
      let left = chunks.length;
      setMode('speaking');
      chunks.forEach((c) => {
        const u = new SpeechSynthesisUtterance(c.trim());
        if (voice) u.voice = voice;
        u.rate = settings.rate;
        u.pitch = settings.pitch;
        u.onend = u.onerror = () => {
          if (--left === 0) {
            if (token === speechToken && state.mode === 'speaking') setMode('idle');
            resolve();
          }
        };
        synth.speak(u);
      });
    });
  }

  function stopSpeaking() {
    if (synth) synth.cancel();
    if (state.mode === 'speaking') setMode('idle');
  }

  /* ---------- Speech input ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let recogRunning = false;
  let wantRecog = false;

  function initRecognition() {
    if (!SR) {
      setChip('chipWake', 'bad');
      logMsg('sys', 'This browser has no speech recognition. Use Chrome or Edge for voice control; typing works everywhere.');
      return;
    }
    recognizer = new SR();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.lang = navigator.language || 'en-US';

    recognizer.onstart = () => { recogRunning = true; };
    recognizer.onend = () => {
      recogRunning = false;
      // Chrome ends sessions on its own after a while; keep going if we still want it.
      if (wantRecog) setTimeout(startRecognition, 250);
    };
    recognizer.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRecog = false;
        setChip('chipWake', 'bad');
        logMsg('err', 'Speech recognition was blocked. Allow the microphone for this page and reload.');
      }
    };
    recognizer.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0].transcript.trim();
        if (r.isFinal) handleHeard(txt);
        else interim += txt + ' ';
      }
      interim = interim.trim();
      if (interim && (state.capture || WAKE.test(interim))) {
        $('heard').textContent = interim;
        if (state.mode === 'idle') setMode('listening');
        armCaptureTimeout();
      }
    };
    syncRecognition();
  }

  function startRecognition() {
    if (!recognizer || recogRunning || !wantRecog) return;
    try { recognizer.start(); } catch { /* already started */ }
  }

  function syncRecognition() {
    wantRecog = !!recognizer && (settings.wake || state.capture);
    setChip('chipWake', !recognizer ? 'bad' : settings.wake ? 'on' : null);
    if (wantRecog) startRecognition();
    else if (recogRunning) recognizer.stop();
    if (state.mode === 'idle') setMode('idle');
  }

  function armCaptureTimeout() {
    clearTimeout(state.captureTimer);
    state.captureTimer = setTimeout(() => endCapture(), 8000);
  }

  function beginCapture() {
    stopSpeaking();
    state.capture = true;
    $('heard').textContent = '';
    setMode('listening');
    sfx.listen();
    syncRecognition();
    armCaptureTimeout();
  }

  function endCapture() {
    clearTimeout(state.captureTimer);
    if (!state.capture) return;
    state.capture = false;
    if (state.mode === 'listening') setMode('idle');
    syncRecognition();
  }

  function handleHeard(raw) {
    if (!raw) return;
    const busy = state.mode === 'thinking' || state.mode === 'speaking';
    const m = raw.match(WAKE);

    if (busy) {
      // While Quinn talks or works, only listen for an interruption,
      // so it never answers its own voice.
      if (m && /\b(stop|cancel|abort|enough|quiet|hold on|wait)\b/i.test(raw)) {
        $('heard').textContent = raw;
        abortAll('Standing by.');
      }
      return;
    }

    let command = null;
    if (state.capture) {
      command = m ? raw.slice(m.index + m[0].length) : raw;
    } else if (m) {
      command = raw.slice(m.index + m[0].length);
    }
    if (command === null) return;

    command = command.trim();
    $('heard').textContent = raw;
    if (!command) {
      // Just the wake word: wait for the actual request.
      const acks = ['Yes?', 'Go ahead.', 'Listening.', 'At your service.'];
      beginCapture();
      speakAck(acks[Math.floor(Math.random() * acks.length)]);
      return;
    }
    endCapture();
    execute(command, 'voice');
  }

  function speakAck(text) {
    // A quick acknowledgement that keeps the listening state visible.
    if (!synth || !settings.speak) return;
    const u = new SpeechSynthesisUtterance(text);
    const v = voices.find((x) => x.name === settings.voice);
    if (v) u.voice = v;
    u.rate = settings.rate * 1.05;
    u.pitch = settings.pitch;
    synth.speak(u);
  }

  /* ---------- Local commands ---------- */
  const fmtDur = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return [d && d + 'd', (d || h) && h + 'h', m + 'm'].filter(Boolean).join(' ');
  };
  const fmtBytes = (b) => (b / 1073741824).toFixed(1) + ' GB';
  let lastSys = null;

  function localCommand(text) {
    const t = text.toLowerCase().replace(/[.!?]+$/, '').trim();
    const short = t.split(/\s+/).length <= 6;

    if (/^(stop|cancel|abort|enough|never ?mind|quiet|shut up)\b/.test(t)) {
      abortAll('Standing by.');
      return true;
    }
    if (/^(clear|clear (the )?(screen|log|display))$/.test(t)) {
      $('log').innerHTML = '';
      $('ops').innerHTML = '';
      showReply('');
      state.logCount = state.opsCount = 0;
      $('logCount').textContent = $('opsCount').textContent = '0';
      reply('Display cleared.');
      return true;
    }
    if (short && /\b(new|fresh|reset( the)?) session\b|^start over$/.test(t)) {
      state.sessionId = null;
      store.set('sessionId', null);
      updateSession({ run: '—' });
      $('sessState').textContent = 'ready';
      reply('New session. Clean slate.');
      return true;
    }
    if (/^(mute|stop talking|silence|silent mode)$/.test(t)) {
      settings.speak = false;
      store.set('speak', false);
      $('setSpeak').checked = false;
      loadVoices();
      reply('Voice output muted. I’ll keep it on screen.');
      return true;
    }
    if (/^(unmute|speak( again)?|voice on)$/.test(t)) {
      settings.speak = true;
      store.set('speak', true);
      $('setSpeak').checked = true;
      loadVoices();
      reply('Voice output restored.');
      return true;
    }
    if (/^(go to sleep|sleep|stand down|stop listening)$/.test(t)) {
      settings.wake = false;
      store.set('wake', false);
      $('setWake').checked = false;
      syncRecognition();
      reply('Going quiet. Click the mic or hold Space when you need me.');
      return true;
    }
    if (short && /\b(what time|the time|time is it)\b/.test(t)) {
      reply(`It’s ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
      return true;
    }
    if (short && /\b(what('s| is) the date|what day|today'?s date)\b/.test(t)) {
      reply(`Today is ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.`);
      return true;
    }
    if (short && /\b(system status|status report|diagnostics|systems? check|how are (you|things))\b/.test(t)) {
      if (!lastSys) { reply('Telemetry is still coming online.'); return true; }
      const s = lastSys;
      const mem = Math.round((1 - s.memFree / s.memTotal) * 100);
      reply(`All systems nominal. CPU at ${s.cpu} percent across ${s.cores} cores, memory at ${mem} percent, and ${s.hostname} has been up ${fmtDur(s.uptime).replace(/d/, ' days').replace(/h/, ' hours').replace(/m/, ' minutes')}. Claude Code link is ${s.claude ? 'online' : 'offline'}.`);
      return true;
    }
    return false;
  }

  function reply(text) {
    logMsg('quinn', text);
    showReply(text);
    speak(text);
  }

  function abortAll(msg) {
    if (state.controller) state.controller.abort();
    state.controller = null;
    endCapture();
    if (synth) synth.cancel();
    setMode('idle');
    if (msg) {
      showReply(msg);
      speakAck(msg);
    }
  }

  /* ---------- Claude Code ---------- */
  async function execute(text, via = 'typed') {
    text = text.trim();
    if (!text) return;
    logMsg('user', text);
    $('heard').textContent = via === 'voice' ? text : '';
    if (localCommand(text)) return;

    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    sfx.accept();
    setMode('thinking');
    showReply('');
    $('sessState').textContent = 'active';

    let full = '';
    let live = null;
    const started = performance.now();
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Quinn': '1' },
        body: JSON.stringify({ prompt: text, sessionId: state.sessionId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let result = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'session') {
            state.sessionId = ev.sessionId;
            store.set('sessionId', ev.sessionId);
            updateSession({ model: ev.model });
          } else if (ev.type === 'text') {
            full += (full ? '\n\n' : '') + ev.text;
            if (!live) live = logMsg('quinn', '');
            live.querySelector('.body').innerHTML = md(full);
            $('log').scrollTop = $('log').scrollHeight;
            showReply(spokenText(full));
            $('stateSub').textContent = 'Composing response';
          } else if (ev.type === 'tool') {
            addOp(ev.name, ev.summary);
            $('stateSub').textContent = `Running ${ev.name}`;
          } else if (ev.type === 'result') {
            result = ev;
          } else if (ev.type === 'error') {
            throw new Error(ev.message);
          }
        }
      }
      if (state.controller !== controller) return;
      state.controller = null;

      if (result) {
        if (result.sessionId) { state.sessionId = result.sessionId; store.set('sessionId', result.sessionId); }
        if (typeof result.costUsd === 'number') { state.spend += result.costUsd; store.set('spend', state.spend); }
        updateSession({ run: `${((result.durationMs || performance.now() - started) / 1000).toFixed(1)}s · ${result.turns || 1} turn${result.turns === 1 ? '' : 's'}` });
        if (result.isError) throw new Error(result.text || 'Claude Code reported an error.');
        if (!full && result.text) {
          full = result.text;
          logMsg('quinn', full);
        }
      }
      $('sessState').textContent = 'ready';
      const say = spokenText(full) || 'Done.';
      showReply(say);
      sfx.done();
      await speak(say);
      if (state.mode === 'thinking') setMode('idle');
    } catch (e) {
      if (e.name === 'AbortError') {
        logMsg('sys', 'Directive aborted.');
        $('sessState').textContent = 'ready';
        return;
      }
      if (state.controller === controller) state.controller = null;
      fault(e.message);
    }
  }

  function fault(message) {
    sfx.error();
    logMsg('err', message);
    showReply(message);
    setMode('error');
    speak('I ran into a problem. ' + message.split(/[.\n]/)[0] + '.');
    setTimeout(() => { if (state.mode === 'error') setMode('idle'); }, 4000);
  }

  /* ---------- Telemetry ---------- */
  function setGauge(id, frac, label) {
    const g = $(id);
    g.querySelector('.g-fill').style.strokeDashoffset = String(251.3 * (1 - Math.max(0, Math.min(1, frac))));
    g.querySelector('b').textContent = label;
  }

  function drawSpark() {
    const c = $('spark');
    const dpr = fitCanvas(c);
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height, d = state.cpuHistory;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(56,232,255,.12)';
    ctx.lineWidth = 1;
    for (let y = 0; y <= 4; y++) { ctx.beginPath(); ctx.moveTo(0, (h / 4) * y); ctx.lineTo(w, (h / 4) * y); ctx.stroke(); }
    if (d.length < 2) return;
    ctx.beginPath();
    d.forEach((v, i) => {
      const x = (i / 59) * w;
      const y = h - (v / 100) * (h - 4) - 2;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = '#38e8ff';
    ctx.lineWidth = 1.5 * dpr;
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#38e8ff';
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(((d.length - 1) / 59) * w, h);
    ctx.lineTo(0, h);
    ctx.fillStyle = 'rgba(56,232,255,.08)';
    ctx.fill();
  }

  async function pollSystem() {
    try {
      const res = await fetch('/api/system', { headers: { 'X-Quinn': '1' } });
      const s = await res.json();
      lastSys = s;
      const mem = 1 - s.memFree / s.memTotal;
      setGauge('gCpu', s.cpu / 100, s.cpu + '%');
      setGauge('gMem', mem, Math.round(mem * 100) + '%');
      setGauge('gLoad', s.load[0] / s.cores, s.load[0].toFixed(1));
      state.cpuHistory.push(s.cpu);
      if (state.cpuHistory.length > 60) state.cpuHistory.shift();
      drawSpark();
      $('ver').textContent = 'v' + s.version;
      $('hostName').textContent = s.hostname;
      $('kvPlatform').textContent = `${s.platform} · ${s.arch}`;
      $('kvCpu').textContent = `${s.cores}× ${s.cpuModel.replace(/\s+/g, ' ')}`;
      $('kvUptime').textContent = fmtDur(s.uptime);
      $('kvNet').textContent = s.network.length ? s.network.map((n) => `${n.address}`).join(', ') : 'offline';
      $('kvWork').textContent = s.workdir;
      $('kvWork').title = s.workdir;
      setChip('chipLink', s.claude ? 'on' : 'bad');
      if ($('sessState').textContent === 'offline') $('sessState').textContent = s.claude ? 'ready' : 'no CLI';
    } catch {
      setChip('chipLink', 'bad');
      $('sessState').textContent = 'offline';
    }
  }

  function tickClock() {
    const d = new Date();
    $('clockTime').textContent = d.toLocaleTimeString([], { hour12: false });
    $('clockDate').textContent = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
  }

  /* ---------- Boot ---------- */
  const BOOT_LINES = [
    '> QUINN kernel ............................ loaded',
    '> Holographic renderer .................... online',
    '> Neural speech lattice ................... calibrating',
    '> Claude Code uplink ...................... handshake',
    '> Telemetry daemons ....................... spawned',
    '> Voice print matrix ...................... standing by',
    '> Awaiting operator authorisation_',
  ];
  async function bootLog() {
    const el = $('bootLog');
    for (const line of BOOT_LINES) {
      el.textContent += line + '\n';
      await new Promise((r) => setTimeout(r, 260 + Math.random() * 200));
    }
  }

  function greeting() {
    const h = new Date().getHours();
    const part = h < 5 ? 'Working late, I see' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return `${part}. Quinn online. All systems are nominal${lastSys && !lastSys.claude ? ', except I can’t reach Claude Code on this machine' : ''}. ${settings.wake && SR ? 'Say my name when you need me.' : 'Click the mic when you need me.'}`;
  }

  async function engage() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) actx = new Ctx();
    $('boot').classList.add('gone');
    sfx.boot();
    loadVoices();
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && actx) await startMicMeter();
    initRecognition();
    updateSession();
    const g = greeting();
    logMsg('quinn', g);
    showReply(g);
    speak(g);
  }

  /* ---------- Wiring ---------- */
  function bindSettings() {
    const rate = $('setRate'), pitch = $('setPitch');
    rate.value = settings.rate; $('rateOut').textContent = Number(settings.rate).toFixed(2);
    pitch.value = settings.pitch; $('pitchOut').textContent = Number(settings.pitch).toFixed(2);
    $('setWake').checked = settings.wake;
    $('setSpeak').checked = settings.speak;
    $('setSfx').checked = settings.sfx;

    rate.oninput = () => { settings.rate = +rate.value; $('rateOut').textContent = settings.rate.toFixed(2); store.set('rate', settings.rate); };
    pitch.oninput = () => { settings.pitch = +pitch.value; $('pitchOut').textContent = settings.pitch.toFixed(2); store.set('pitch', settings.pitch); };
    rate.onchange = pitch.onchange = () => speak('Voice calibrated.', { force: true });
    $('setVoice').onchange = (e) => { settings.voice = e.target.value; store.set('voice', settings.voice); speak('This is how I sound now.', { force: true }); };
    $('setWake').onchange = (e) => { settings.wake = e.target.checked; store.set('wake', settings.wake); syncRecognition(); };
    $('setSpeak').onchange = (e) => { settings.speak = e.target.checked; store.set('speak', settings.speak); if (!settings.speak) stopSpeaking(); loadVoices(); };
    $('setSfx').onchange = (e) => { settings.sfx = e.target.checked; store.set('sfx', settings.sfx); };
    $('openSettings').onclick = () => $('settings').showModal();
  }

  function bindControls() {
    $('engage').onclick = engage;
    $('cmdForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('cmd').value;
      $('cmd').value = '';
      execute(v, 'typed');
    };
    $('abortBtn').onclick = () => abortAll('Aborted.');
    $('micBtn').onclick = () => {
      if (!recognizer) return logMsg('sys', 'Voice input needs Chrome or Edge. You can type directives below.');
      if (state.capture) endCapture(); else beginCapture();
    };
    $('directives').onclick = (e) => {
      const b = e.target.closest('button[data-cmd]');
      if (b) execute(b.dataset.cmd, 'typed');
    };

    // Hold Space to talk (when not typing), Esc to abort.
    let spaceHeld = false;
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || $('settings').open;
      if (e.key === 'Escape' && !$('settings').open) { abortAll(); return; }
      if (e.code === 'Space' && !typing && !e.repeat && recognizer && $('boot').classList.contains('gone')) {
        e.preventDefault();
        spaceHeld = true;
        $('micBtn').classList.add('hot');
        beginCapture();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && spaceHeld) {
        spaceHeld = false;
        $('micBtn').classList.remove('hot');
        // Leave a moment for the final result to arrive.
        clearTimeout(state.captureTimer);
        state.captureTimer = setTimeout(endCapture, 1800);
      }
    });
  }

  if (synth) synth.onvoiceschanged = loadVoices;
  bindSettings();
  bindControls();
  setMode('idle');
  tickClock();
  setInterval(tickClock, 1000);
  pollSystem();
  setInterval(pollSystem, 3000);
  bootLog();
  requestAnimationFrame(frame);
})();
