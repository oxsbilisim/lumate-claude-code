// lumate_request files: the proxy reads them from INSIDE the project only, uploads them and sends the ids. Run: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', 'plugins', 'lumate', 'scripts');
const PROXY = path.join(SCRIPTS, 'mcp-proxy.js');
const rf = require(path.join(SCRIPTS, 'request-files.js'));

// --- the secret list is the guard's list ---------------------------------------------------------------------------------------------
test('the secret names are the ones guard.sh refuses', () => {
  const guard = fs.readFileSync(path.join(SCRIPTS, 'guard.sh'), 'utf8');
  const line = guard.split('\n').find((l) => /^\s*\.env\* \|/.test(l));
  assert.ok(line, 'the secret_name case line was not found in guard.sh');
  const globs = line.trim().replace(/\) return 0 ;;.*$/, '').split('|').map((g) => g.trim());
  assert.deepEqual([...globs].sort(), [...rf.SECRET_GLOBS].sort());
  for (const name of ['.env', '.env.local', 'prod.env', '.lumate.env', 'k.PEM', 'id_rsa.pub', 'credentials.json', 'Secrets.yml', 'service_account_x.json', '.git', '.SSH']) {
    assert.ok(rf.isSecretName(name), name);
  }
  for (const name of ['sheet.xlsx', 'environment.md', 'keynote.pdf', 'notes.txt']) assert.ok(!rf.isSecretName(name), name);
});

// --- a project folder ------------------------------------------------------------------------------------------------------------------
function project() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lumate-req-'));
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'sheet.txt'), 'test sheet');
  fs.writeFileSync(path.join(root, '.lumate.env'), 'LUMATE_TOKEN=lmt_x\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(base, path.join(root, 'linkdir'));
  fs.symlinkSync(path.join(root, 'docs', 'sheet.txt'), path.join(root, 'inside-link.txt'));
  return { base, root, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const refused = (root, paths, re) => assert.throws(() => rf.prepare(root, paths), (e) => e instanceof rf.Refused && re.test(e.message));

test('a file inside the project is read, by its name only', () => {
  const p = project();
  try {
    const [f] = rf.prepare(p.root, ['docs/sheet.txt']);
    assert.equal(f.name, 'sheet.txt'); assert.equal(String(f.data), 'test sheet');
    assert.equal(rf.prepare(p.root, [path.join(p.root, 'docs', 'sheet.txt')]).length, 1); // an absolute path inside is fine
  } finally { p.done(); }
});

test('../ outside, absolute outside, symlinks and links through a folder are refused', () => {
  const p = project();
  try {
    refused(p.root, ['../outside.txt'], /outside the project/);
    refused(p.root, [path.join(p.base, 'outside.txt')], /outside the project/);
    refused(p.root, ['docs/../../outside.txt'], /outside the project/);
    refused(p.root, ['link.txt'], /link/);                 // a link as the file, to outside
    refused(p.root, ['inside-link.txt'], /link/);          // even one that ends inside
    refused(p.root, ['linkdir/outside.txt'], /outside the project/); // a link in the path that leaves the project
    refused(p.root, ['/etc/hosts'], /outside the project|not found/);
  } finally { p.done(); }
});

test('secret files, folders, empty, big, missing, many are refused (and nothing is read when one is)', () => {
  const p = project();
  try {
    refused(p.root, ['.lumate.env'], /secret/);
    refused(p.root, ['.env'], /secret/);
    refused(p.root, ['docs/sheet.txt', '.env'], /secret/);
    fs.mkdirSync(path.join(p.root, 'keys'));
    fs.writeFileSync(path.join(p.root, 'keys', 'a.pem'), 'x'); refused(p.root, ['keys/a.pem'], /secret/);
    fs.mkdirSync(path.join(p.root, '.ssh')); fs.writeFileSync(path.join(p.root, '.ssh', 'config'), 'x'); refused(p.root, ['.ssh/config'], /secret/);
    fs.writeFileSync(path.join(p.root, 'empty.txt'), ''); refused(p.root, ['empty.txt'], /empty/);
    fs.writeFileSync(path.join(p.root, 'big.bin'), Buffer.alloc(rf.MAX_BYTES + 1)); refused(p.root, ['big.bin'], /25 MB/);
    refused(p.root, ['docs'], /not a regular file/);
    refused(p.root, ['nope.txt'], /not found/);
    refused(p.root, [''], /empty or not plain/);
    refused(p.root, 'docs/sheet.txt', /list of paths/);
    const many = Array.from({ length: 11 }, (_, i) => { fs.writeFileSync(path.join(p.root, `f${i}.txt`), 'x'); return `f${i}.txt`; });
    refused(p.root, many, /At most 10/);
    assert.equal(rf.prepare(p.root, many.slice(0, 10)).length, 10);
  } finally { p.done(); }
});

test('the root of the disk and the home folder are never a project to send from', () => {
  assert.throws(() => rf.prepare('/', ['etc/hosts']), rf.Refused);
  assert.throws(() => rf.prepare(os.homedir(), ['x.txt']), rf.Refused);
});

// --- through the proxy, against a fake Lumate -------------------------------------------------------------------------------------------
async function fake(handlers = {}) {
  const s = { uploads: [], calls: [], server: null, url: '' };
  s.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/api/connector/request-files') {
        s.uploads.push({ auth: req.headers.authorization, name: decodeURIComponent(req.headers['x-lumate-filename'] || ''), data: body.toString(), type: req.headers['content-type'] });
        if (handlers.upload) return handlers.upload(req, res, s);
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: `up_${s.uploads.length}`, name: 'x', size: body.length }));
      }
      const m = JSON.parse(body.toString());
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      s.calls.push(m);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Lumate got it' }] } }));
    });
  });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${s.server.address().port}`;
  s.close = () => { s.server.closeAllConnections?.(); return new Promise((r) => s.server.close(r)); };
  return s;
}

function startProxy(srv, root) {
  const envFile = path.join(root, '.lumate.env');
  fs.writeFileSync(envFile, `LUMATE_URL=${srv.url}\nLUMATE_TOKEN=key-one\n`, { mode: 0o600 }); fs.chmodSync(envFile, 0o600);
  const child = spawn('node', [PROXY, root], { env: { ...process.env, LUMATE_PROXY_URL: srv.url, LUMATE_TOKEN: '', LUMATE_URL: '', LUMATE_PROXY_BACKOFF_MS: '40', LUMATE_PROXY_RETRY_MS: '4000' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let buf = '';
  child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const reply = async (id) => { for (let n = 0; n < 100; n += 1) { const f = lines.find((m) => m.id === id); if (f) return f; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`no reply: ${JSON.stringify(lines)}`); };
  return { child, reply, send: (o) => child.stdin.write(`${JSON.stringify(o)}\n`), stop: () => child.kill() };
}
const call = (id, args, name = 'lumate_request') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('through the proxy: the files are uploaded by name with the key, and the call carries ids, never paths', async () => {
  const p = project(); const srv = await fake(); const px = startProxy(srv, p.root);
  try {
    px.send(call(1, { text: 'send it to Can', files: ['docs/sheet.txt'] }));
    assert.equal((await px.reply(1)).result.content[0].text, 'Lumate got it');
    assert.deepEqual(srv.uploads.map((u) => [u.auth, u.name, u.data, u.type]), [['Bearer key-one', 'sheet.txt', 'test sheet', 'application/octet-stream']]);
    assert.deepEqual(srv.calls[0].params.arguments, { text: 'send it to Can', files: ['up_1'] });
    assert.ok(!JSON.stringify(srv.calls).includes(p.root) && !JSON.stringify(srv.calls).includes('docs/'));
  } finally { px.stop(); await srv.close(); p.done(); }
});

test('through the proxy: a refused file ends the call as a tool error and nothing is uploaded or requested', async () => {
  const p = project(); const srv = await fake(); const px = startProxy(srv, p.root);
  try {
    for (const [id, files, re] of [[1, ['../outside.txt'], /outside the project/], [2, ['link.txt'], /link/], [3, ['docs/sheet.txt', '.lumate.env'], /secret/]]) {
      px.send(call(id, { text: 'x', files }));
      const r = (await px.reply(id)).result;
      assert.ok(r.isError && re.test(r.content[0].text) && /Nothing was requested/.test(r.content[0].text), JSON.stringify(r));
    }
    assert.equal(srv.uploads.length, 0); assert.equal(srv.calls.length, 0);
  } finally { px.stop(); await srv.close(); p.done(); }
});

test('through the proxy: the server refusing a file (422, 403) is shown, and the request is not sent', async () => {
  const p = project();
  const srv = await fake({ upload: (req, res) => { res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: 'sheet.txt is not a type Lumate can read.' })); } });
  const px = startProxy(srv, p.root);
  try {
    px.send(call(1, { text: 'x', files: ['docs/sheet.txt'] }));
    const r = (await px.reply(1)).result;
    assert.ok(r.isError && /not a type Lumate can read/.test(r.content[0].text)); assert.equal(srv.calls.length, 0);
  } finally { px.stop(); await srv.close(); p.done(); }
});

test('through the proxy: a request without files, and other tools, are passed on untouched', async () => {
  const p = project(); const srv = await fake(); const px = startProxy(srv, p.root);
  try {
    px.send(call(1, { text: 'just words' })); await px.reply(1);
    px.send(call(2, { summary: 'done', files: ['../x'] }, 'lumate_report')); await px.reply(2);
    assert.equal(srv.uploads.length, 0);
    assert.deepEqual(srv.calls.map((c) => c.params.arguments), [{ text: 'just words' }, { summary: 'done', files: ['../x'] }]);
  } finally { px.stop(); await srv.close(); p.done(); }
});
