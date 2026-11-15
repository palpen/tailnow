const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const AdmZip = require('adm-zip');
const { createServer } = require('../src/http');
const { loadConfig } = require('../src/validation');
const { checkCapacity } = require('../src/storage');
const { defaultLimits } = require('../src/publisher');
const { SESSION_MS } = require('../src/auth');

async function fixture(t, change, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnow-security-'));
  const configPath = path.join(root, 'config.json');
  const config = { baseUrl: 'https://admin.example/', allowedHosts: ['admin.example', 'legacy.example', '127.0.0.1:8080'], legacyOrigins: ['https://legacy.example'],
    sitesDirectory: path.join(root, 'sites'), dataDirectory: path.join(root, 'private'), serviceLabel: 'com.example.tailnow', apps: [],
    siteOrigins: { alpha: 'https://apps.example:8501', beta: 'https://apps.example:8502', assets: 'https://assets.example' }, siteOptions: {} };
  fs.mkdirSync(config.sitesDirectory);
  for (const slug of ['alpha', 'beta', 'assets']) { fs.mkdirSync(path.join(config.sitesDirectory, slug)); fs.writeFileSync(path.join(config.sitesDirectory, slug, 'index.html'), `ORIGINAL ${slug}`); }
  if (change) await change(config, root);
  const write = () => fs.writeFileSync(configPath, JSON.stringify(config)); write();
  const server = createServer({ configPath, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, key = fs.readFileSync(path.join(config.dataDirectory, 'admin-token'), 'utf8').trim();
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); fs.rmSync(root, { recursive: true, force: true }); });
  const request = (target = '/', { host = 'admin.example', method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: target, method, agent: false, headers: { Host: host, ...(body ? { 'Content-Length': body.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Test request timeout'))); req.on('error', reject); req.end(body);
  });
  const upload = (slug, contents = 'NEW', headers = { Authorization: `Bearer ${key}` }) => {
    const zip = new AdmZip(); zip.addFile('index.html', Buffer.from(contents));
    const body = Buffer.concat([Buffer.from('--TEST\r\nContent-Disposition: form-data; name="file"; filename="site.zip"\r\n\r\n'), zip.toBuffer(), Buffer.from('\r\n--TEST--\r\n')]);
    return request(`/api/publish/${slug}`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=TEST', ...headers }, body });
  };
  return { root, config, configPath, server, key, port, request, upload, write };
}

test('all administrator mutations require a bearer credential, including CLI publishing', async t => {
  const a = await fixture(t);
  for (const suffix of ['minimize', 'restore', 'remove', 'shutdown', 'last', 'before/beta']) {
    for (const headers of [{}, { 'X-Tailnow-Request': '1' }, { Cookie: `admin=${a.key}` }, { Authorization: 'Bearer ' + 'x'.repeat(43) }]) {
      assert.equal((await a.request(`/api/apps/alpha/${suffix}`, { method: 'POST', headers })).status, 401);
    }
  }
  assert.equal((await a.upload('alpha', 'ATTACK', {})).status, 401);
  assert.equal((await a.request('/alpha/', { host: 'apps.example:8501' })).body, 'ORIGINAL alpha');
  assert.equal((await a.request('/api/admin/session')).status, 401);
  assert.equal((await a.request('/')).headers['set-cookie'], undefined);
});

test('admin sessions expire, log out, are bounded, and fail login attempts are limited', async t => {
  let now = Date.now(); const a = await fixture(t, null, { authOptions: { now: () => now } });
  const login = token => a.request('/api/admin/login', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  let response = await login(a.key); assert.equal(response.status, 200);
  const session = JSON.parse(response.body).token; assert.notEqual(session, a.key);
  const headers = { Authorization: `Bearer ${session}` };
  assert.equal((await a.request('/api/admin/session', { headers })).status, 200);
  assert.equal((await a.request('/api/apps/alpha/minimize', { method: 'POST', headers })).status, 200);
  assert.equal((await a.request('/api/admin/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await a.request('/api/admin/session', { headers })).status, 401);
  const next = JSON.parse((await login(a.key)).body).token;
  now += SESSION_MS + 1;
  assert.equal((await a.request('/api/admin/session', { headers: { Authorization: `Bearer ${next}` } })).status, 401);
  for (let i = 0; i < 40; i++) assert.equal((await login(a.key)).status, 200);
  assert.equal(a.server.auth.sessions.size, 32);
  for (let i = 0; i < 20; i++) assert.equal((await login('x'.repeat(43))).status, 401);
  assert.equal((await login(a.key)).status, 429); now += 60001;
  assert.equal((await login(a.key)).status, 200);
});

test('each app origin serves only its own files and explicitly granted assets', async t => {
  const a = await fixture(t, c => { c.siteOptions.alpha = { dependencies: ['assets'] }; });
  assert.equal((await a.request('/alpha/', { host: 'apps.example:8501' })).status, 200);
  assert.equal((await a.request('/beta/', { host: 'apps.example:8501' })).status, 404);
  assert.equal((await a.request('/beta/', { host: 'apps.example:8501', headers: { 'Sec-Fetch-Mode': 'navigate' } })).headers.location, 'https://apps.example:8502/beta/');
  assert.equal((await a.request('/assets/', { host: 'apps.example:8501' })).status, 200);
  assert.equal((await a.request('/assets/', { host: 'apps.example:8502' })).status, 404);
  assert.equal((await a.request('/api/apps', { host: 'apps.example:8501' })).status, 404);
  assert.equal((await a.request('/api/apps/alpha/remove', { host: 'apps.example:8501', method: 'POST', headers: { Authorization: `Bearer ${a.key}` } })).status, 405);
  const redirect = await a.request('/alpha/nested/page.html?view=1', { host: 'legacy.example' });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.location, 'https://apps.example:8501/alpha/nested/page.html?view=1');
  assert.equal((await a.request('/alpha/')).status, 302);
  assert.equal((await a.request('/', { host: 'legacy.example' })).headers.location, 'https://admin.example/');
});

test('same-site other ports, wrong schemes, legacy hosts, and CORS cannot reach admin or peer data', async t => {
  const a = await fixture(t);
  for (const origin of ['https://apps.example:8501', 'http://admin.example', 'https://admin.example:8443', 'null']) {
    assert.equal((await a.request('/api/apps/alpha/remove', { method: 'POST', headers: { Authorization: `Bearer ${a.key}`, 'X-Tailnow-Request': '1', Origin: origin } })).status, 403);
  }
  for (const site of ['same-site', 'cross-site']) assert.equal((await a.request('/beta/', { host: 'apps.example:8502', headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors' } })).status, 403);
  assert.equal((await a.request('/beta/', { host: 'apps.example:8502', headers: { Origin: 'https://apps.example:8501' } })).status, 403);
  assert.equal((await a.request('/api/apps/alpha/remove', { host: 'legacy.example', method: 'POST', headers: { Authorization: `Bearer ${a.key}` } })).status, 403);
  assert.equal((await a.request('/api/admin/login', { method: 'OPTIONS' })).status, 405);
  assert.equal((await a.request('/api/admin/login', { method: 'POST', headers: { Authorization: `Bearer ${a.key}`, Origin: 'https://admin.example' } })).status, 403);
});

test('storage aliases are rejected at startup and when reloading configuration', async t => {
  const a = await fixture(t);
  const original = a.config.dataDirectory;
  fs.symlinkSync(a.config.sitesDirectory, path.join(a.root, 'alias'));
  a.config.dataDirectory = path.join(a.root, 'alias', 'private'); a.write();
  assert.throws(() => loadConfig(a.configPath), /overlap/);
  a.server.catalog.invalidate(); assert.equal((await a.request('/')).status, 503);
  a.config.dataDirectory = original; a.write(); a.server.catalog.invalidate(); assert.equal((await a.request('/')).status, 200);
  if (fs.existsSync(path.join(a.root, 'SITES'))) {
    a.config.dataDirectory = path.join(a.root, 'SITES', 'private'); a.write();
    assert.throws(() => loadConfig(a.configPath), /overlap/);
  }
  a.config.dataDirectory = original; a.config.sitesDirectory = path.join(original, 'releases'); a.write();
  assert.throws(() => loadConfig(a.configPath), /overlap/);
});

test('origin ownership survives restarts and prevents reassignment or administration on an app origin', async t => {
  const a = await fixture(t);
  const prior = a.config.siteOrigins.alpha;
  a.config.siteOrigins.alpha = 'https://replacement.example'; a.write(); a.server.catalog.invalidate();
  assert.equal((await a.request('/')).status, 200);
  a.config.siteOrigins.beta = prior; a.write(); a.server.catalog.invalidate();
  assert.equal((await a.request('/')).status, 503);
  a.config.siteOrigins.beta = 'https://apps.example:8502'; a.config.baseUrl = prior + '/'; a.config.allowedHosts.push('apps.example:8501'); a.write(); a.server.catalog.invalidate();
  assert.equal((await a.request('/')).status, 503);
});

test('retention preserves the active release, and quotas fail before reading an upload', async t => {
  const a = await fixture(t, c => { c.storage = { keepReleases: 2 }; });
  for (const content of ['one', 'two', 'three', 'four']) assert.equal((await a.upload('alpha', content)).status, 200);
  const folder = path.join(a.config.dataDirectory, 'releases/alpha');
  assert.equal(fs.readdirSync(folder).length, 2);
  assert.equal((await a.request('/alpha/', { host: 'apps.example:8501' })).body, 'four');
  a.config.storage.maxBytes = 64 * 1024 ** 2; a.write(); a.server.catalog.invalidate();
  assert.equal((await a.upload('alpha', 'NO SPACE')).status, 507);
  assert.equal(a.server.catalog.busy, false);
  assert.deepEqual(fs.readdirSync(path.join(a.config.dataDirectory, 'uploads')), []);
  assert.equal((await a.request('/alpha/', { host: 'apps.example:8501' })).body, 'four');
  a.config.storage.maxBytes = 5 * 1024 ** 3; a.write(); a.server.catalog.invalidate(); a.server.catalog.snapshot(true);
  assert.throws(() => checkCapacity(a.server.catalog, defaultLimits, () => ({ bsize: 4096, bavail: 1 })), /Not enough/);
});

test('fixed app API proxy preserves JSON requests and strips all credentials and upstream cookies', async t => {
  let seen;
  const backend = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen = { headers: req.headers, url: req.url, method: req.method, body };
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://other.example/' }); return res.end(); }
    if (req.url === '/oversize') return res.end(Buffer.alloc(4 * 1024 * 1024 + 1));
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Set-Cookie', 'secret=backend'); res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ saved: true }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const a = await fixture(t, c => { c.siteOptions.alpha = { apiProxies: [{ prefix: '/worksheet/', target: `http://127.0.0.1:${backend.address().port}`, methods: ['GET', 'PATCH'] }] }; });
  const result = await a.request('/worksheet/s/test/api/state', { host: 'apps.example:8501', method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: 'private=other-app', Authorization: `Bearer ${a.key}`, Origin: 'https://apps.example:8501', 'Tailscale-User-Login': 'forged@example.com' }, body: Buffer.from('{"revision":0}') });
  assert.equal(result.status, 200); assert.equal(seen.url, '/s/test/api/state'); assert.equal(seen.method, 'PATCH'); assert.equal(seen.body, '{"revision":0}');
  for (const name of ['cookie', 'authorization', 'tailscale-user-login']) assert.equal(seen.headers[name], undefined);
  assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal((await a.request('/worksheet/s/test/api/state', { host: 'apps.example:8502' })).status, 404);
  assert.equal((await a.request('/worksheet/s/test/api/state', { host: 'apps.example:8501', headers: { Origin: 'https://apps.example:8502' } })).status, 403);
  for (const target of ['/worksheet/%2e%2e/api/state', '/worksheet/x%5csecret', '/worksheet/x%00secret']) assert.equal((await a.request(target, { host: 'apps.example:8501' })).status, 404);
  for (const target of ['/worksheet/redirect', '/worksheet/oversize']) assert.equal((await a.request(target, { host: 'apps.example:8501' })).status, 502);
  assert.equal((await a.request('/worksheet/s/test/api/state', { host: 'apps.example:8501', method: 'DELETE' })).status, 405);
});

test('retired shared origins cannot become administrator or app origins on later reloads', async t => {
  const a = await fixture(t);
  a.config.legacyOrigins = []; a.config.baseUrl = 'https://legacy.example/'; a.write(); a.server.catalog.invalidate();
  assert.equal((await a.request('/')).status, 503);
  a.config.baseUrl = 'https://admin.example/'; a.config.allowedHosts = ['admin.example']; a.config.siteOrigins.alpha = 'https://legacy.example'; a.write(); a.server.catalog.invalidate();
  assert.equal((await a.request('/')).status, 503);
});

test('interrupted authenticated uploads clean up private files and release the write lock', async t => {
  const a = await fixture(t);
  const socket = net.connect(a.port, '127.0.0.1'); await once(socket, 'connect');
  socket.write(`POST /api/publish/alpha HTTP/1.1\r\nHost: admin.example\r\nAuthorization: Bearer ${a.key}\r\nContent-Type: multipart/form-data; boundary=TEST\r\nContent-Length: 100000\r\n\r\n--TEST\r\nContent-Disposition: form-data; name="file"; filename="x.zip"\r\n\r\nabc`);
  await new Promise(resolve => setTimeout(resolve, 50)); socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(a.server.catalog.busy, false); assert.deepEqual(fs.readdirSync(path.join(a.config.dataDirectory, 'uploads')), []);
  assert.equal((await a.upload('alpha')).status, 200);
});

test('unsafe isolation, storage migration ownership, and proxy configuration fail closed', async t => {
  const a = await fixture(t);
  for (const change of [
    c => { c.siteOrigins.beta = c.siteOrigins.alpha; },
    c => { c.siteOrigins.ALPHA = 'https://duplicate.example'; },
    c => { c.siteOrigins.alpha = 'https://admin.example'; },
    c => { c.siteOrigins.alpha = 'http://apps.example:8501'; },
    c => { c.siteOptions.alpha = { apiProxies: [{ prefix: '/api/', target: 'http://127.0.0.1:9999' }] }; },
    c => { c.siteOptions.alpha = { apiProxies: [{ prefix: '/x/', target: 'https://evil.example' }] }; },
    c => { c.siteOptions.alpha = { dependencies: ['missing'] }; },
    c => { c.siteOptions = { alpha: { storageKeys: ['same-key'] }, beta: { storageKeys: ['same-key'] } }; },
  ]) {
    const next = structuredClone(a.config); change(next); fs.writeFileSync(a.configPath, JSON.stringify(next)); assert.throws(() => loadConfig(a.configPath));
  }
});
