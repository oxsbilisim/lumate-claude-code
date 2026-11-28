#!/usr/bin/env node
// Lumate's MCP proxy: Claude Code starts this as a stdio MCP server and it forwards every JSON-RPC message to
// <LUMATE_PROXY_URL>/mcp over HTTP. Lumate's server is stateless, so a request after a server restart just works; this proxy
// is what keeps Claude Code from marking the server "failed" while Lumate is restarting (a deploy): it retries connection
// errors and 502/503/504 for about 3 minutes and never exits on a failed request.
//
// Node 18+, no dependencies. Arguments: [project dir] (default $CLAUDE_PROJECT_DIR, else the working folder).
// Environment: LUMATE_PROXY_URL (the Lumate address), LUMATE_PROXY_HEADERS (a headers script to run with `sh`, default
// headers.sh next to this file; it is run again for every attempt, so a new key in .lumate.env is used without a restart),
// LUMATE_PROXY_DEBUG=<file> (optional debug log, off by default; never holds a key or a message body).
// Tuning (milliseconds, for tests): LUMATE_PROXY_RETRY_MS (180000), LUMATE_PROXY_BACKOFF_MS (500), LUMATE_PROXY_BACKOFF_MAX_MS
// (10000), LUMATE_PROXY_FAST_MS (8000: how long initialize / tools/list wait before they are answered locally),
// LUMATE_PROXY_ATTEMPT_MS (300000: one HTTP attempt).
'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const http = require('node:http');
const https = require('node:https');
const requestFiles = require('./request-files.js');

const VERSION = '0.7.0';
const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 && process.env[name] !== '' && process.env[name] != null ? v : dflt; };
const RETRY_MS = num('LUMATE_PROXY_RETRY_MS', 180000);
const BACKOFF_MS = Math.max(1, num('LUMATE_PROXY_BACKOFF_MS', 500));
const BACKOFF_MAX_MS = Math.max(BACKOFF_MS, num('LUMATE_PROXY_BACKOFF_MAX_MS', 10000));
const FAST_MS = num('LUMATE_PROXY_FAST_MS', 8000);
const ATTEMPT_MS = num('LUMATE_PROXY_ATTEMPT_MS', 300000);
const CONNECT_MS = Math.max(1, num('LUMATE_PROXY_CONNECT_MS', 15000)); // a connect that takes longer is a connect-phase timeout (fresh connections only)

const ERR_PARSE = -32700, ERR_REQUEST = -32600, ERR_AUTH = -32001, ERR_DOWN = -32002, ERR_HTTP = -32003, ERR_CONFIG = -32004;
const MSG_DOWN = 'Lumate is restarting or unreachable; try again in a minute.';
const MSG_DROPPED = 'The connection to Lumate dropped during the call; check whether it was done before trying again (it is not repeated automatically).';
const MSG_FORBIDDEN = 'Lumate says this key is not allowed to do that (HTTP 403: a permission problem). Check that the key belongs to this project ' +
  'and your account (Connect to Claude Code in the project dialog gives a new one).';
const MSG_KEYREAD = 'The Lumate plugin could not read the key (its headers script failed or timed out). Check .lumate.env in the project folder (mode 600, not tracked by git) and that `sh` works.';
const MSG_AUTH = 'Lumate did not accept the key: it is missing or has expired. Open the project in Lumate, choose Connect to Claude Code, ' +
  'and paste the new prompt into Claude Code in the project folder (or run /lumate-link <address> <code>). No restart is needed afterwards.';
const RETRY_STATUS = new Set([408, 429, 502, 503, 504]);

const debugFile = process.env.LUMATE_PROXY_DEBUG || '';
function debug(text) {
  if (!debugFile) return;
  try { fs.appendFileSync(debugFile, `${new Date().toISOString()} ${text}\n`); } catch { /* the log is optional */ }
}

// The address, checked like the hook scripts do: https, or http only for this computer (the key would travel in the clear).
function endpoint() {
  const raw = (process.env.LUMATE_PROXY_URL || '').trim();
  let u;
  try { u = new URL(raw); } catch { return { error: 'The Lumate address is not set or not valid. Set it again with: claude plugin config lumate (for example https://lumate.example.com).' }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.username || u.password || !(u.protocol === 'https:' || (u.protocol === 'http:' && local))) {
    return { error: 'The Lumate address must start with https:// (http:// only for this computer) and have no user name in it.' };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}/mcp` };
}

// The headers of one attempt: run headers.sh, which prints {"Authorization": "Bearer <key>"} or {} (null: it failed or timed out).
const projectDir = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const headersScript = process.env.LUMATE_PROXY_HEADERS || path.join(__dirname, 'headers.sh');
function readHeaders() {
  return new Promise((resolve) => {
    execFile('sh', [headersScript, projectDir], { timeout: 5000, maxBuffer: 16384, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const h = JSON.parse(stdout);
        const out = {};
        if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) if (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(k) && !/[\r\n]/.test(v)) out[k] = v;
        resolve(out);
      } catch { resolve(null); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => { process.stdout.write(`${JSON.stringify(obj)}\n`); };
const fail = (id, code, message) => out({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

let protocolVersion = null; // from the server's initialize answer, sent back as MCP-Protocol-Version
let cachedTools = null;     // the last full tools/list result
let serverDown = false;     // true after initialize or tools/list was answered locally; cleared by any success
let staleList = false;      // the client holds a local (cached or empty) tools list and must be told when the real one is back

// Methods that do nothing twice when repeated: these keep the broad retry. Everything else (tools/call above all) is sent again only
// when it certainly never reached Lumate's application.
const SAFE_METHODS = new Set(['initialize', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const isSafe = (items) => items.every((m) => !m || typeof m !== 'object' || typeof m.method !== 'string' || m.id === undefined || m.id === null || SAFE_METHODS.has(m.method));
// Errors of the connection phase: nothing was sent yet.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
function errorCodes(e) {
  const codes = [];
  for (let c = e, d = 0; c && d < 4; c = c.cause, d += 1) { if (c.code) codes.push(c.code); if (Array.isArray(c.errors)) for (const x of c.errors) if (x && x.code) codes.push(x.code); }
  return codes;
}
// ETIMEDOUT counts only when it happened while connecting (e.connectPhase, set by freshPost), never on a connection that was up.
const isConnectPhase = (codes, e) => codes.length > 0 && codes.every((c) => CONNECT_CODES.has(c) || (c === 'ETIMEDOUT' && !!(e && e.connectPhase)) || /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL_)/.test(c));

class Outcome { constructor(kind, extra) { this.kind = kind; Object.assign(this, extra); } }

// One POST on a NEW connection (no keep-alive reuse, Connection: close): a stale idle socket can then never fail it. For requests that must
// not be repeated. Resolves {status, headers: {get}, text}; rejects with the socket error (e.connectPhase: it never finished connecting).
function freshPost(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let connected = false, done = false, timer = null;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'POST', agent: false, headers: { ...headers, Connection: 'close', 'Content-Length': Buffer.byteLength(body) }, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } }, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, Object.assign(new Error('aborted'), { code: 'ECONNRESET' })));
    });
    req.on('error', (e) => { e.connectPhase = !connected; finish(reject, e); });
    req.on('socket', (sock) => {
      const up = () => { connected = true; clearTimeout(timer); };
      if (sock.connecting) {
        sock.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', up);
        timer = setTimeout(() => req.destroy(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), CONNECT_MS);
      } else up();
    });
    req.end(body);
  });
}

// One attempt. Returns Outcome: ok{status,type,text} | retry{why} | auth{status} | keyread | dropped | http{status}.
// safe: the request may be sent again whatever happened (see SAFE_METHODS); else only when it never reached the application.
async function attempt(url, body, safe) {
  const headers = await readHeaders();
  if (headers === null) return new Outcome('keyread');
  if (!headers.Authorization) return new Outcome('auth', { status: 401 });
  headers['Content-Type'] = 'application/json';
  headers.Accept = 'application/json, text/event-stream';
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
  let res;
  try {
    const signal = AbortSignal.timeout(ATTEMPT_MS);
    res = safe ? await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal }) : await freshPost(url, headers, body, signal);
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ABORT_ERR')) return new Outcome('http', { status: 'timeout', safe });
    const codes = errorCodes(e);
    const why = codes[0] || (e && e.name) || 'error';
    return safe || isConnectPhase(codes, e) ? new Outcome('retry', { why }) : new Outcome('dropped', { why });
  }
  if (res.status === 401 || res.status === 403) { await res.body?.cancel?.().catch(() => {}); return new Outcome('auth', { status: res.status }); }
  if (res.status >= 300 && res.status < 400) { await res.body?.cancel?.().catch(() => {}); return new Outcome('http', { status: res.status, redirect: true }); }
  let text;
  try { text = res.text === undefined ? '' : typeof res.text === 'string' ? res.text : await res.text(); } catch (e) { return safe ? new Outcome('retry', { why: errorCodes(e)[0] || 'read' }) : new Outcome('dropped', { why: 'read' }); }
  const type = res.headers.get('content-type') || '';
  if (RETRY_STATUS.has(res.status)) {
    if (safe) return new Outcome('retry', { why: `HTTP ${res.status}` });
    // Not safe: only a gateway in front of the application (502/503/429 with no JSON-RPC answer) means it never ran; 504/408 may have run.
    const fromApp = (messages({ text, type }) || []).some((m) => m && m.jsonrpc);
    if (!fromApp && (res.status === 502 || res.status === 503 || res.status === 429)) return new Outcome('retry', { why: `HTTP ${res.status}` });
    if (!fromApp) return new Outcome('dropped', { why: `HTTP ${res.status}` });
  }
  return new Outcome('ok', { status: res.status, type, text });
}

// Retries until the deadline (ms from now). Returns the last Outcome (never 'retry' unless the time is up).
async function send(url, body, budgetMs, safe = true) {
  const deadline = Date.now() + budgetMs;
  let delay = BACKOFF_MS, n = 0;
  for (;;) {
    n += 1;
    const o = await attempt(url, body, safe);
    if (o.kind !== 'retry') { if (n > 1) debug(`recovered after ${n} attempts`); return o; }
    debug(`attempt ${n}: ${o.why}`);
    const left = deadline - Date.now();
    if (left <= 0) return o;
    await sleep(Math.min(delay * (0.75 + Math.random() * 0.5), left));
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
  }
}

// The JSON-RPC messages inside a response body: plain JSON, or a text/event-stream's data: events.
function messages(o) {
  const t = o.text.trim();
  if (!t) return [];
  if (/text\/event-stream/i.test(o.type)) {
    const found = [];
    for (const block of t.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { found.push(JSON.parse(data)); } catch { /* skip a broken event */ }
    }
    return found;
  }
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch { return null; }
}

function failFrom(id, o) {
  if (o.kind === 'auth') return fail(id, ERR_AUTH, o.status === 403 ? MSG_FORBIDDEN : MSG_AUTH);
  if (o.kind === 'keyread') return fail(id, ERR_CONFIG, MSG_KEYREAD);
  if (o.kind === 'dropped') return fail(id, ERR_HTTP, MSG_DROPPED);
  if (o.kind === 'retry') return fail(id, ERR_DOWN, MSG_DOWN);
  if (o.kind === 'http' && o.redirect) return fail(id, ERR_HTTP, `Lumate answered with a redirect (HTTP ${o.status}); check the Lumate address (https, no extra path).`);
  if (o.kind === 'http' && o.status === 'timeout') return fail(id, ERR_HTTP, o.safe === false ? 'Lumate did not answer in time; check whether it was done before trying again (it is not repeated automatically).' : 'Lumate did not answer in time; try again.');
  return fail(id, ERR_HTTP, `Lumate answered with HTTP ${o.status}.`);
}

// Local answers while Lumate is unreachable at start (Claude Code gives a server only ~30 s to connect).
function localInitialize(msg) {
  const v = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18';
  out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: v, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'lumate', version: `${VERSION}-proxy` } } });
}

// lumate_request with files: the files are read from INSIDE the project folder only (request-files.js), uploaded one by one to Lumate, and the call
// goes on with the ids Lumate gave back in place of the paths (a path never leaves this computer). Returns {msg} or {error: <sentence>}.
const toolError = (id, text) => out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
async function uploadOne(base, file) {
  const url = `${base.replace(/\/mcp$/, '')}/api/connector/request-files`;
  for (let n = 1; ; n += 1) {
    const headers = await readHeaders();
    if (headers === null) return { error: MSG_KEYREAD };
    if (!headers.Authorization) return { error: MSG_AUTH };
    let res;
    try {
      res = await freshPost(url, { ...headers, 'Content-Type': 'application/octet-stream', 'X-Lumate-Filename': encodeURIComponent(file.name), Accept: 'application/json' }, file.data, AbortSignal.timeout(ATTEMPT_MS));
    } catch (e) {
      if (isConnectPhase(errorCodes(e), e) && n < 4) { await sleep(Math.min(BACKOFF_MS * 2 ** n, BACKOFF_MAX_MS)); continue; } // nothing was sent: safe to try again
      return { error: `${file.name} could not be uploaded (${errorCodes(e)[0] || 'connection'}); nothing was requested. Try again in a minute.` };
    }
    let detail = ''; let body = null;
    try { body = JSON.parse(res.text); detail = typeof body.detail === 'string' ? body.detail : ''; } catch { /* not JSON */ }
    if (res.status === 201 && body && typeof body.id === 'string') return { id: body.id };
    if (res.status === 401) return { error: MSG_AUTH };
    if (res.status === 403) return { error: detail || MSG_FORBIDDEN };
    if (res.status === 413 || res.status === 422) return { error: `${file.name}: ${detail || 'Lumate did not accept this file.'}` };
    return { error: `${file.name} could not be uploaded (HTTP ${res.status}); nothing was requested.` };
  }
}
async function withUploads(url, msg) {
  let files;
  try { files = requestFiles.prepare(projectDir, msg.params.arguments.files); } catch (e) {
    if (e instanceof requestFiles.Refused) return { error: `${e.message} Nothing was requested.` };
    return { error: 'The files could not be read; nothing was requested.' };
  }
  const ids = [];
  for (const f of files) { const r = await uploadOne(url, f); if (r.error) return { error: `${r.error}${ids.length ? ' (files already uploaded are not used.)' : ''}` }; ids.push(r.id); }
  return { msg: { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, files: ids } } } };
}
const isRequestWithFiles = (m) => m && typeof m === 'object' && m.method === 'tools/call' && m.params && m.params.name === 'lumate_request'
  && m.params.arguments && Array.isArray(m.params.arguments.files) && m.params.arguments.files.length > 0;

let recovering = false;
// After a local answer: ask for the real tools list until it comes, then tell the client it changed.
async function recover(url) {
  if (recovering) return;
  recovering = true;
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: `lumate-proxy-recover`, method: 'tools/list', params: {} });
    let authDelay = Math.max(BACKOFF_MAX_MS, 1000);
    for (;;) {
      const o = await send(url, body, RETRY_MS);
      if (o.kind === 'ok') {
        const m = messages(o);
        const r = m && m.find((x) => x && x.result && Array.isArray(x.result.tools));
        if (r) { cachedTools = r.result; serverDown = false; if (staleList) { staleList = false; out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); } return; }
        return;
      }
      if (o.kind === 'auth') { await sleep(authDelay); authDelay = Math.min(authDelay * 2, Math.max(BACKOFF_MAX_MS * 6, 60000)); continue; } // a key may still be written; slower each time
      if (o.kind !== 'retry') return;
    }
  } finally { recovering = false; }
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, ERR_PARSE, 'Parse error: the message is not valid JSON.'); }
  if (msg === null || typeof msg !== 'object') return fail(null, ERR_REQUEST, 'Invalid request: a JSON-RPC message is an object or an array of them.');
  const batch = Array.isArray(msg);
  const items = batch ? msg : [msg];
  if (batch && items.length === 0) return fail(null, ERR_REQUEST, 'Invalid request: empty batch.');
  const first = batch ? null : msg;
  const hasId = (m) => m && typeof m === 'object' && m.id !== undefined && m.id !== null && typeof m.method === 'string';
  const wantsReply = items.some(hasId);
  if (!batch && typeof first.method !== 'string' && first.result === undefined && first.error === undefined) {
    return fail(first.id, ERR_REQUEST, 'Invalid request: no method.');
  }

  const ep = endpoint();
  if (ep.error) return wantsReply ? fail(first && first.id, ERR_CONFIG, ep.error) : undefined;
  let body = line;
  if (batch && items.some(isRequestWithFiles)) return fail(null, ERR_REQUEST, 'lumate_request with files cannot be sent in a batch: send it on its own.');
  if (isRequestWithFiles(first)) {
    const r = await withUploads(ep.url, first);
    if (r.error) return toolError(first.id, r.error);
    body = JSON.stringify(r.msg);
  }

  if (!batch && first.method === 'ping' && hasId(first)) return out({ jsonrpc: '2.0', id: first.id, result: {} });

  // A notification (or a client's answer to a server request): forwarded, no body awaited, nothing written back.
  if (!wantsReply) {
    send(ep.url, body, RETRY_MS).then((o) => { if (o.kind !== 'ok') debug(`notification dropped (${o.kind})`); }).catch(() => {});
    return;
  }

  const method = first && first.method;
  const early = method === 'initialize' || (method === 'tools/list' && !(first.params && first.params.cursor));
  const budget = early ? (serverDown ? Math.min(FAST_MS, 2000) : FAST_MS) : RETRY_MS;
  const o = await send(ep.url, body, budget, isSafe(items));

  if (o.kind === 'retry' && early) { // not reachable yet: answer locally and keep trying in the background
    serverDown = true;
    if (method === 'initialize') { recover(ep.url); return localInitialize(first); }
    staleList = true; recover(ep.url);
    return out({ jsonrpc: '2.0', id: first.id, result: cachedTools || { tools: [] } });
  }
  if (o.kind !== 'ok') return failFrom(first && first.id, o);

  serverDown = false;
  const msgs = messages(o);
  if (msgs === null) return fail(first && first.id, ERR_HTTP, `Lumate answered with HTTP ${o.status} and something that is not JSON.`);
  if (msgs.length === 0) return fail(first && first.id, ERR_HTTP, `Lumate answered with HTTP ${o.status} and no message.`);
  if (method === 'initialize') {
    const r = msgs.find((m) => m && m.result);
    if (r && r.result && typeof r.result.protocolVersion === 'string') protocolVersion = r.result.protocolVersion;
  }
  if (method === 'tools/list') {
    const r = msgs.find((m) => m && m.result && Array.isArray(m.result.tools));
    if (r && !(first.params && first.params.cursor)) { cachedTools = r.result; staleList = false; }
  }
  if (!batch && o.status >= 400 && !msgs.some((m) => m && (m.result !== undefined || m.error !== undefined))) return failFrom(first.id, new Outcome('http', { status: o.status }));
  for (const m of msgs) out(m);
}

if (typeof fetch !== 'function') {
  process.stderr.write('The Lumate plugin needs Node 18 or newer.\n');
  process.exit(1);
}
process.stdout.on('error', () => process.exit(0));
process.on('uncaughtException', (e) => debug(`uncaught: ${e && e.name}`));
process.on('unhandledRejection', (e) => debug(`unhandled: ${e && e.name}`));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  handle(line).catch((e) => { debug(`handler: ${e && e.name}`); try { fail(null, ERR_HTTP, 'The Lumate proxy failed on this message; try again.'); } catch { /* nothing more to do */ } });
});
rl.on('close', () => process.exit(0));
debug(`started ${VERSION}`);
