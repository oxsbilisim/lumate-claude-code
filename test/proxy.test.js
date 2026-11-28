// Tests of plugins/lumate/scripts/mcp-proxy.js against a fake HTTP server. Run: node --test test/   (Node 18+, no dependencies)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROXY = path.join(__dirname, '..', 'plugins', 'lumate', 'scripts', 'mcp-proxy.js');
const TOOLS = [{ name: 'lumate_report', description: 'x', inputSchema: { type: 'object' } }];

// A fake Lumate. mode: 'ok' | 'down' (502) | 'refuse' (the socket is destroyed) ; keys: the Bearer tokens it accepts.
async function fakeServer() {
  const s = { mode: 'ok', keys: new Set(['key-one']), seen: [], server: null, url: '' };
  s.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      s.seen.push({ port: req.socket.remotePort, conn: req.headers.connection, url: req.url, auth, body, accept: req.headers.accept });
      if (s.mode === 'refuse' || s.mode === 'drop') return req.socket.destroy(); // 'drop': the body was read, then the connection dies
      if (s.mode === 'stall') return; // the body was read, no answer ever
      if (s.mode === 'gw504') { res.writeHead(504); return res.end('Gateway Timeout'); }
      if (s.mode === 'forbidden') { res.writeHead(403); return res.end('{}'); }
      if (s.mode === 'down') { res.writeHead(502); return res.end('Bad Gateway'); }
      if (!s.keys.has(auth.replace(/^Bearer /, ''))) { res.writeHead(401); return res.end('{"detail":"bad key"}'); }
      let m; try { m = JSON.parse(body); } catch { res.writeHead(400); return res.end('{}'); }
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
      if (m.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'real', version: '1' } });
      if (m.method === 'tools/list') return reply({ tools: TOOLS });
      if (m.method === 'tools/call') return reply({ content: [{ type: 'text', text: `done ${m.params.name}` }] });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } }));
    });
  });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${s.server.address().port}`;
  s.close = () => { s.server.closeAllConnections?.(); return new Promise((r) => s.server.close(r)); };
  return s;
}

// A project folder with a .lumate.env (mode 600), and the proxy running against it.
function startProxy(srv, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumate-proxy-'));
  const envFile = path.join(dir, '.lumate.env');
  const writeKey = (k) => { fs.writeFileSync(envFile, `LUMATE_URL=${srv.url}\nLUMATE_TOKEN=${k}\n`, { mode: 0o600 }); fs.chmodSync(envFile, 0o600); };
  writeKey('key-one');
  const child = spawn('node', [PROXY, dir], {
    env: { ...process.env, LUMATE_PROXY_URL: srv.url, LUMATE_TOKEN: '', LUMATE_URL: '', LUMATE_PROXY_BACKOFF_MS: '40', LUMATE_PROXY_BACKOFF_MAX_MS: '200',
      LUMATE_PROXY_RETRY_MS: '8000', LUMATE_PROXY_FAST_MS: '600', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = []; const waiters = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const j = JSON.parse(l); lines.push(j); waiters.splice(0).forEach((w) => w()); }
  });
  const stderr = []; child.stderr.on('data', (c) => stderr.push(String(c)));
  const waitFor = async (pred, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const f = lines.find(pred); if (f) return f;
      if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(lines)}`);
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  const p = {
    child, lines, stderr, writeKey, dir,
    send: (o) => child.stdin.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`),
    reply: (id, ms) => waitFor((m) => m.id === id, ms),
    waitFor,
    stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return p;
}
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });

test('a normal call goes to /mcp with the key and the answer comes back', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    p.send(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
    assert.equal((await p.reply(1)).result.serverInfo.name, 'real');
    p.send(rpc(2, 'tools/list'));
    assert.deepEqual((await p.reply(2)).result.tools, TOOLS);
    p.send(rpc(3, 'tools/call', { name: 'lumate_report' }));
    assert.equal((await p.reply(3)).result.content[0].text, 'done lumate_report');
    assert.ok(srv.seen.every((r) => r.url === '/mcp' && r.auth === 'Bearer key-one' && /event-stream/.test(r.accept)));
    assert.equal(p.stderr.join(''), '');
  } finally { p.stop(); await srv.close(); }
});

test('server down for a while, then back: the call succeeds after retry', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    p.send(rpc(1, 'initialize', {})); await p.reply(1);
    srv.mode = 'down';
    p.send(rpc(2, 'tools/call', { name: 'lumate_report' }));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(p.lines.find((m) => m.id === 2), undefined, 'still waiting while the server is down');
    srv.mode = 'ok';
    assert.equal((await p.reply(2)).result.content[0].text, 'done lumate_report');
    assert.ok(srv.seen.filter((r) => r.body.includes('tools/call')).length >= 3, 'it retried');
    p.send(rpc(3, 'tools/call', { name: 'lumate_reply' })); // and it is still running
    assert.equal((await p.reply(3)).result.content[0].text, 'done lumate_reply');
  } finally { p.stop(); await srv.close(); }
});

test('a tools/call whose connection drops after the body was sent is sent exactly once, with a clear error', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    srv.mode = 'drop';
    p.send(rpc(1, 'tools/call', { name: 'lumate_report' }));
    const r = await p.reply(1);
    assert.match(r.error.message, /dropped during the call; check whether it was done/);
    await new Promise((x) => setTimeout(x, 600));
    assert.equal(srv.seen.filter((q) => q.body.includes('tools/call')).length, 1, 'sent once');
    srv.mode = 'ok';
    p.send(rpc(2, 'tools/call', { name: 'lumate_report' }));
    assert.ok((await p.reply(2)).result, 'still running');
  } finally { p.stop(); await srv.close(); }
});

test('a tools/call answered 504 (the app may have run it) is not retried; tools/list is', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    srv.mode = 'gw504';
    p.send(rpc(1, 'tools/call', { name: 'a' }));
    assert.match((await p.reply(1)).error.message, /check whether it was done/);
    assert.equal(srv.seen.length, 1);
    p.send(rpc(2, 'tools/list'));
    await new Promise((x) => setTimeout(x, 500));
    srv.mode = 'ok';
    assert.deepEqual((await p.reply(2)).result.tools, TOOLS);
    assert.ok(srv.seen.length > 3);
  } finally { p.stop(); await srv.close(); }
});

test('initialize and tools/list keep the broad retry: a dropped connection is retried', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    srv.mode = 'drop';
    p.send(rpc(1, 'tools/list'));
    await new Promise((x) => setTimeout(x, 300));
    srv.mode = 'ok';
    assert.deepEqual((await p.reply(1)).result.tools, TOOLS);
    assert.ok(srv.seen.length >= 2);
  } finally { p.stop(); await srv.close(); }
});

test('a tools/call is retried while nothing listens (connection refused), then sent once', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    const port = srv.server.address().port;
    await srv.close();
    p.send(rpc(1, 'tools/call', { name: 'a' }));
    await new Promise((x) => setTimeout(x, 700));
    assert.equal(p.lines.length, 0, 'still waiting');
    await new Promise((r) => srv.server.listen(port, '127.0.0.1', r));
    assert.equal((await p.reply(1)).result.content[0].text, 'done a');
    assert.equal(srv.seen.filter((q) => q.body.includes('tools/call')).length, 1);
  } finally { p.stop(); await srv.close().catch(() => {}); }
});

test('a tools/call answered 502 by the proxy in front (no app body) is retried', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    srv.mode = 'down';
    p.send(rpc(1, 'tools/call', { name: 'a' }));
    await new Promise((x) => setTimeout(x, 400));
    srv.mode = 'ok';
    assert.ok((await p.reply(1)).result);
  } finally { p.stop(); await srv.close(); }
});

test('403 is worded as a permission problem, not an expired key', async () => {
  const srv = await fakeServer(); srv.mode = 'forbidden'; const p = startProxy(srv);
  try {
    p.send(rpc(1, 'tools/call', { name: 'a' }));
    const m = (await p.reply(1)).error.message;
    assert.match(m, /not allowed|permission/i);
    assert.doesNotMatch(m, /expired/);
  } finally { p.stop(); await srv.close(); }
});

test('a headers script that fails says the key could not be read, not that it expired', async () => {
  const srv = await fakeServer(); const bad = path.join(os.tmpdir(), `lumate-bad-headers-${process.pid}.sh`);
  fs.writeFileSync(bad, 'exit 1\n');
  const p = startProxy(srv, { LUMATE_PROXY_HEADERS: bad });
  try {
    p.send(rpc(1, 'tools/call', { name: 'a' }));
    const m = (await p.reply(1)).error.message;
    assert.match(m, /could not read the key/i);
    assert.doesNotMatch(m, /expired/);
    assert.equal(srv.seen.length, 0);
  } finally { p.stop(); fs.rmSync(bad, { force: true }); await srv.close(); }
});

test('every tools/call goes on a fresh connection; a stale idle keep-alive socket cannot fail it', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    p.send(rpc(1, 'tools/list')); await p.reply(1);
    p.send(rpc(2, 'tools/list')); await p.reply(2);
    srv.server.closeAllConnections(); // the idle socket the list calls kept is now dead
    p.send(rpc(3, 'tools/call', { name: 'a' }));
    assert.ok((await p.reply(3)).result, 'no spurious dropped error');
    p.send(rpc(4, 'tools/call', { name: 'b' }));
    assert.ok((await p.reply(4)).result);
    const calls = srv.seen.filter((q) => q.body.includes('tools/call'));
    const listPorts = new Set(srv.seen.filter((q) => q.body.includes('tools/list')).map((q) => q.port));
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].port, calls[1].port, 'each call has its own connection');
    assert.ok(calls.every((q) => !listPorts.has(q.port)), 'not on a list call\'s socket');
    assert.ok(calls.every((q) => /close/i.test(q.conn)));
  } finally { p.stop(); await srv.close(); }
});

test('a tools/call that stalls after the body was sent times out once and is never sent again', async () => {
  const srv = await fakeServer(); srv.mode = 'stall'; const p = startProxy(srv, { LUMATE_PROXY_ATTEMPT_MS: '500', LUMATE_PROXY_RETRY_MS: '8000' });
  try {
    p.send(rpc(1, 'tools/call', { name: 'lumate_report' }));
    const m = (await p.reply(1)).error.message;
    assert.match(m, /did not answer in time; check whether it was done/);
    await new Promise((x) => setTimeout(x, 700));
    assert.equal(srv.seen.filter((q) => q.body.includes('tools/call')).length, 1, 'sent exactly once');
    srv.mode = 'ok';
    p.send(rpc(2, 'tools/call', { name: 'lumate_report' }));
    assert.ok((await p.reply(2)).result, 'still running');
  } finally { p.stop(); await srv.close(); }
});

test('a connect that never completes (TLS handshake stalls) is a connection-phase timeout: the tools/call is retried, not reported as dropped', async () => {
  const net = require('node:net');
  const sockets = []; let accepted = 0;
  const hole = net.createServer((sock) => { accepted += 1; sockets.push(sock); sock.on('error', () => {}); }); // accepts, never answers the handshake
  await new Promise((r) => hole.listen(0, '127.0.0.1', r));
  const srv = await fakeServer();
  const p = startProxy(srv, { LUMATE_PROXY_URL: `https://127.0.0.1:${hole.address().port}`, LUMATE_PROXY_CONNECT_MS: '150', LUMATE_PROXY_RETRY_MS: '1200' });
  try {
    p.send(rpc(1, 'tools/call', { name: 'a' }));
    const m = (await p.reply(1, 15000)).error.message;
    assert.match(m, /restarting or unreachable/);
    assert.doesNotMatch(m, /dropped/);
    assert.ok(accepted >= 3, `retried (connections: ${accepted})`);
    assert.equal(srv.seen.length, 0);
  } finally { p.stop(); sockets.forEach((x) => x.destroy()); hole.close(); await srv.close(); }
});

test('server down longer than the budget: a clear error, the proxy keeps running', async () => {
  const srv = await fakeServer(); const p = startProxy(srv, { LUMATE_PROXY_RETRY_MS: '700' });
  try {
    p.send(rpc(1, 'initialize', {})); await p.reply(1);
    srv.mode = 'down';
    p.send(rpc(2, 'tools/call', { name: 'lumate_report' }));
    const r = await p.reply(2);
    assert.match(r.error.message, /Lumate is restarting or unreachable; try again in a minute/);
    srv.mode = 'ok';
    p.send(rpc(3, 'tools/call', { name: 'lumate_report' }));
    assert.ok((await p.reply(3)).result);
    assert.equal(p.child.exitCode, null);
  } finally { p.stop(); await srv.close(); }
});

test('401 gives a clear error about the key and the Connect dialog, without retrying', async () => {
  const srv = await fakeServer(); srv.keys = new Set(['another']); const p = startProxy(srv);
  try {
    p.send(rpc(1, 'tools/call', { name: 'lumate_report' }));
    const r = await p.reply(1);
    assert.match(r.error.message, /missing or has expired/);
    assert.match(r.error.message, /Connect to Claude Code/);
    assert.equal(srv.seen.length, 1);
    assert.ok(!JSON.stringify(p.lines).includes('key-one'), 'the key is not in any message');
    assert.ok(!p.stderr.join('').includes('key-one'));
  } finally { p.stop(); await srv.close(); }
});

test('no key at all: the same clear error, no request sent', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    fs.rmSync(path.join(p.dir, '.lumate.env'));
    p.send(rpc(1, 'tools/call', { name: 'lumate_report' }));
    assert.match((await p.reply(1)).error.message, /Connect to Claude Code/);
    assert.equal(srv.seen.length, 0);
  } finally { p.stop(); await srv.close(); }
});

test('the key file changed: the next request uses the new key, no restart', async () => {
  const srv = await fakeServer(); srv.keys = new Set(['key-one', 'key-two']); const p = startProxy(srv);
  try {
    p.send(rpc(1, 'tools/call', { name: 'a' })); await p.reply(1);
    p.writeKey('key-two');
    p.send(rpc(2, 'tools/call', { name: 'b' })); await p.reply(2);
    assert.deepEqual(srv.seen.map((r) => r.auth), ['Bearer key-one', 'Bearer key-two']);
  } finally { p.stop(); await srv.close(); }
});

test('an expired key answered with the error, then replaced: the next call works without a restart', async () => {
  const srv = await fakeServer(); srv.keys = new Set(['key-two']); const p = startProxy(srv);
  try {
    p.send(rpc(1, 'tools/call', { name: 'a' }));
    assert.match((await p.reply(1)).error.message, /expired/);
    p.writeKey('key-two');
    p.send(rpc(2, 'tools/call', { name: 'b' }));
    assert.ok((await p.reply(2)).result);
  } finally { p.stop(); await srv.close(); }
});

test('malformed input: an error, and the proxy keeps running', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    p.send('{this is not json');
    assert.equal((await p.waitFor((m) => m.error && m.error.code === -32700)).id, null);
    p.send('42');
    await p.waitFor((m) => m.error && m.error.code === -32600);
    p.send('[]');
    p.send({ jsonrpc: '2.0', id: 9 });
    assert.equal((await p.reply(9)).error.code, -32600);
    p.send(rpc(10, 'tools/list'));
    assert.deepEqual((await p.reply(10)).result.tools, TOOLS);
    assert.equal(p.child.exitCode, null);
  } finally { p.stop(); await srv.close(); }
});

test('a notification is forwarded and nothing is written back', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    p.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    p.send(rpc(1, 'tools/list')); await p.reply(1);
    assert.ok(srv.seen.some((r) => r.body.includes('notifications/initialized')));
    assert.equal(p.lines.length, 1, 'only the tools/list answer');
  } finally { p.stop(); await srv.close(); }
});

test('a notification sent while the server is down is still delivered when it is back', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    srv.mode = 'down';
    p.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    await new Promise((r) => setTimeout(r, 400));
    srv.mode = 'ok';
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(srv.seen.some((r) => r.body.includes('notifications/cancelled') && r.auth === 'Bearer key-one'));
    assert.equal(p.lines.length, 0);
  } finally { p.stop(); await srv.close(); }
});

test('the server is down at start: initialize and tools/list are answered locally, and the tools return when it is back', async () => {
  const srv = await fakeServer(); srv.mode = 'down'; const p = startProxy(srv);
  try {
    p.send(rpc(1, 'initialize', { protocolVersion: '2025-03-26' }));
    const i = await p.reply(1);
    assert.equal(i.result.protocolVersion, '2025-03-26');
    p.send(rpc(2, 'tools/list'));
    assert.deepEqual((await p.reply(2)).result.tools, []);
    srv.mode = 'ok';
    await p.waitFor((m) => m.method === 'notifications/tools/list_changed');
    p.send(rpc(3, 'tools/list'));
    assert.deepEqual((await p.reply(3)).result.tools, TOOLS);
  } finally { p.stop(); await srv.close(); }
});

test('tools/list is answered from the last good list while the server is briefly down', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  try {
    p.send(rpc(1, 'tools/list')); await p.reply(1);
    srv.mode = 'down';
    p.send(rpc(2, 'tools/list'));
    assert.deepEqual((await p.reply(2)).result.tools, TOOLS);
  } finally { p.stop(); await srv.close(); }
});

test('an event-stream answer is unpacked into JSON-RPC lines', async () => {
  const srv = await fakeServer(); const p = startProxy(srv);
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"ok":true}}\n\n');
  }); });
  try { p.send(rpc(5, 'tools/call', { name: 'x' })); assert.deepEqual((await p.reply(5)).result, { ok: true }); }
  finally { p.stop(); await srv.close(); }
});

test('a plain-http address that is not this computer is refused (the key would travel in the clear)', async () => {
  const srv = await fakeServer(); const p = startProxy(srv, { LUMATE_PROXY_URL: 'http://lumate.example.com' });
  try {
    p.send(rpc(1, 'tools/call', { name: 'x' }));
    assert.match((await p.reply(1)).error.message, /must start with https/);
    assert.equal(srv.seen.length, 0);
  } finally { p.stop(); await srv.close(); }
});

test('the debug log is off by default and writes no key or body when on', async () => {
  const srv = await fakeServer(); const log = path.join(os.tmpdir(), `lumate-proxy-debug-${process.pid}.log`);
  const off = startProxy(srv);
  try { off.send(rpc(1, 'tools/list')); await off.reply(1); } finally { off.stop(); }
  assert.equal(fs.existsSync(log), false);
  const on = startProxy(srv, { LUMATE_PROXY_DEBUG: log });
  try { srv.mode = 'down'; on.send(rpc(2, 'tools/call', { name: 'secret-arg' })); await new Promise((r) => setTimeout(r, 400)); srv.mode = 'ok'; await on.reply(2); }
  finally { on.stop(); await srv.close(); }
  const text = fs.readFileSync(log, 'utf8'); fs.rmSync(log);
  assert.match(text, /attempt 1/);
  assert.ok(!text.includes('key-one') && !text.includes('secret-arg'));
});
