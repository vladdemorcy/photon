#!/usr/bin/env node
// Quinn: a voice-driven HUD for Claude Code.
// Serves the interface and relays requests to the local `claude` CLI.
// No dependencies: Node 18+ built-ins only.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.env.QUINN_PORT) || 7777;
const HOST = '127.0.0.1';
const WORKDIR = path.resolve(process.env.QUINN_CWD || process.cwd());
const CLAUDE_BIN = process.env.QUINN_CLAUDE_BIN || 'claude';
const PERMISSION_MODE = process.env.QUINN_PERMISSION_MODE || 'default';
const MODEL = process.env.QUINN_MODEL || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = require('./package.json').version;

const SYSTEM_PROMPT = [
  'You are Quinn, a voice-driven assistant running inside Claude Code.',
  'Your replies are read aloud, so lead with a short, spoken-style answer of one to three sentences.',
  'Avoid markdown tables and long code blocks in that opening; put any detail after it.',
  'Address the user directly and keep a calm, capable, slightly dry tone.',
].join(' ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function claudeAvailable() {
  try {
    execFileSync(CLAUDE_BIN, ['--version'], { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// Only answer requests addressed to this machine by name. This blocks DNS
// rebinding, where a web page points its own hostname at 127.0.0.1.
function hostAllowed(req) {
  const host = (req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
}

// API calls must carry a custom header. Browsers won't send one cross-origin
// without a CORS preflight, which Quinn never approves, so other sites can't
// drive Claude Code through it.
function apiAllowed(req) {
  return req.headers['x-quinn'] === '1';
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let lastCpu = os.cpus().map((c) => c.times);
function cpuUsage() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] || t;
    const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq;
    idle += t.idle - p.idle;
    total += sum(t) - sum(p);
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function systemStatus() {
  const nets = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).filter((n) => !n.internal && n.family === 'IPv4').map((n) => ({ name, address: n.address })));
  return {
    version: VERSION,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: (os.cpus()[0] || {}).model || 'Unknown',
    cores: os.cpus().length,
    cpu: cpuUsage(),
    load: os.loadavg(),
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: os.uptime(),
    node: process.version,
    workdir: WORKDIR,
    network: nets,
    claude: claudeReady,
  };
}

const running = new Set();

// Runs one Claude Code turn and streams its events to the browser as
// newline-delimited JSON.
async function handleAsk(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Send JSON with a "prompt" field.' });
  }
  const prompt = String(body.prompt || '').trim();
  const sessionId = typeof body.sessionId === 'string' && /^[0-9a-f-]{8,64}$/i.test(body.sessionId) ? body.sessionId : null;
  if (!prompt) return sendJson(res, 400, { error: 'The prompt is empty.' });
  if (!claudeReady) {
    return sendJson(res, 503, { error: `I can't find the Claude Code CLI ("${CLAUDE_BIN}"). Install it, or set QUINN_CLAUDE_BIN.` });
  }

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', PERMISSION_MODE,
    '--append-system-prompt', SYSTEM_PROMPT];
  if (MODEL) args.push('--model', MODEL);
  if (sessionId) args.push('--resume', sessionId);

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  child.stdin.end(prompt);

  let buf = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        forwardEvent(JSON.parse(line), send);
      } catch {
        // Ignore anything that isn't a JSON event.
      }
    }
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-4000); });
  child.on('error', (err) => {
    send({ type: 'error', message: err.message });
    res.end();
  });
  child.on('close', (code) => {
    running.delete(child);
    if (code && code !== 0 && !res.writableEnded) send({ type: 'error', message: stderr.trim() || `Claude Code exited with code ${code}.` });
    send({ type: 'done', code });
    res.end();
  });
  // Stop Claude if the browser goes away mid-answer.
  res.on('close', () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });
}

// Reduces Claude Code's stream-json events to what the HUD shows.
function forwardEvent(ev, send) {
  if (ev.type === 'system' && ev.subtype === 'init') {
    send({ type: 'session', sessionId: ev.session_id, model: ev.model, tools: (ev.tools || []).length });
  } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const part of ev.message.content) {
      if (part.type === 'text' && part.text) send({ type: 'text', text: part.text });
      else if (part.type === 'tool_use') send({ type: 'tool', name: part.name, summary: summarizeTool(part.input) });
    }
  } else if (ev.type === 'result') {
    send({
      type: 'result',
      sessionId: ev.session_id,
      text: ev.result || '',
      isError: !!ev.is_error,
      costUsd: ev.total_cost_usd,
      durationMs: ev.duration_ms,
      turns: ev.num_turns,
    });
  }
}

function summarizeTool(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.pattern || input.url || input.query || input.description || '';
  return String(v).slice(0, 140);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  });
}

const claudeReady = claudeAvailable();

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) {
    res.writeHead(421, { 'Content-Type': 'text/plain' });
    return res.end('Open Quinn at http://localhost:' + PORT);
  }
  if (req.url.startsWith('/api/')) {
    if (!apiAllowed(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (req.method === 'GET' && req.url === '/api/system') return sendJson(res, 200, systemStatus());
    if (req.method === 'POST' && req.url === '/api/ask') return handleAsk(req, res).catch((e) => sendJson(res, 500, { error: e.message }));
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  serveStatic(req, res);
});

function shutdown() {
  for (const child of running) child.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`\n  QUINN ${VERSION} online`);
  console.log(`  Interface:   http://localhost:${PORT}`);
  console.log(`  Workspace:   ${WORKDIR}`);
  console.log(`  Claude Code: ${claudeReady ? 'connected' : `not found (${CLAUDE_BIN})`}`);
  console.log(`  Permissions: ${PERMISSION_MODE}\n`);
});
