const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { createServer } = require('../server');
const { loadConfig } = require('../src/validation');
const { StateStore } = require('../src/state-store');
const { defaultLimits } = require('../src/publisher');
const { stopApp } = require('../src/services');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnow-test-'));
  const configPath = path.join(dir, 'config.json');
  const config = {
    allowedHosts: ['mini', 'published.example'], baseUrl: 'https://published.example/',
    sitesDirectory: path.join(dir, 'sites'), dataDirectory: path.join(dir, 'data'),
    serviceLabel: 'com.example.tailnow',
    apps: [{ slug: 'pigeon', name: 'Pigeon', description: 'Files', url: 'https://external.example:8443/', service: { type: 'launchAgent', label: 'com.example.pigeon' } }],
  };
  fs.mkdirSync(config.sitesDirectory);
  const write = () => fs.writeFileSync(configPath, JSON.stringify(config));
  const legacy = (slug, content = slug) => {
    fs.mkdirSync(path.join(config.sitesDirectory, slug), { recursive: true });
    fs.writeFileSync(path.join(config.sitesDirectory, slug, 'index.html'), content);
  };
  legacy('weather', '<h1>Original weather</h1>');
  write();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, configPath, config, write, legacy };
}
async function running(t, options = {}, files = fixture(t)) {
  const server = createServer({ configPath: files.configPath, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (target = '/', headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: target, method,
      headers: { Host: 'mini', ...(body ? { 'Content-Length': body.length } : {}), ...headers }, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const upload = (slug, archive = zip(), headers = {}) => {
    const boundary = 'TailnowTestBoundary';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="site.zip"\r\nContent-Type: application/zip\r\n\r\n`), archive, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return request(`/api/publish/${slug}`, { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...headers }, 'POST', body);
  };
  const manage = (slug, action, headers = {}) => request(`/api/apps/${slug}/${action}`, { 'X-Tailnow-Request': '1', ...headers }, 'POST');
  return { ...files, server, request, upload, manage };
}
function zip(files = { 'index.html': '<h1>Fresh release</h1>', 'assets/app.js': 'console.log("ready")' }) {
  const archive = new AdmZip();
  for (const [name, body] of Object.entries(files)) archive.addFile(name, Buffer.from(body));
  return archive.toBuffer();
}

test('one service lists legacy sites and external apps and preserves existing routes', async t => {
  const { request } = await running(t);
  const home = await request();
  assert.equal(home.status, 200);
  assert.match(home.body, /TailNow · Your apps/);
  assert.match(home.body, /Pigeon/);
  assert.match(home.body, /https:\/\/published.example\/weather\//);
  assert.match(home.body, /id="publish-form"/);
  assert.equal((await request('/weather/')).body, '<h1>Original weather</h1>');
  assert.equal((await request('/weather?next=//evil.example')).headers.location, 'https://published.example/weather/');
  assert.equal((await request('/pigeon')).headers.location, 'https://external.example:8443/');
  assert.equal((await request('/pigeon/')).status, 302);
  assert.equal(JSON.parse((await request('/api/health')).body).service, 'tailnow');
});

test('publishing makes a validated release and catalog entry visible together', async t => {
  const { upload, request, config, server } = await running(t, { reloadMs: 60000 });
  const result = await upload('new-app', zip(), { 'X-Forwarded-Host': 'evil.example' });
  assert.equal(result.status, 200, result.body);
  assert.equal(JSON.parse(result.body).url, 'https://published.example/new-app/');
  assert.match((await request()).body, /new-app/);
  assert.equal((await request('/new-app/')).body, '<h1>Fresh release</h1>');
  assert.equal((await request('/new-app/assets/app.js')).status, 200);
  assert.equal((await request('/new-app/assets')).headers.location, '/new-app/assets/');
  assert.equal((await request('/new-app/', {}, 'HEAD')).body, '');
  assert.equal((await request('/new-app/', { Range: 'bytes=0-3' })).status, 206);
  const state = JSON.parse(fs.readFileSync(path.join(config.dataDirectory, 'catalog.json')));
  assert.ok(state.deployments['new-app'].release);
  assert.equal(fs.statSync(path.join(config.dataDirectory, 'catalog.json')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(config.sitesDirectory, 'new-app')), false);
  assert.equal(server.catalog.busy, false);
  assert.deepEqual(fs.readdirSync(path.join(config.dataDirectory, 'uploads')), []);
});

test('updating a legacy app retains its files and previous versions', async t => {
  const { upload, request, config } = await running(t);
  assert.equal((await upload('weather')).status, 200);
  assert.equal((await request('/weather/')).body, '<h1>Fresh release</h1>');
  assert.equal(fs.readFileSync(path.join(config.sitesDirectory, 'weather/index.html'), 'utf8'), '<h1>Original weather</h1>');
  assert.equal((await upload('weather', zip({ 'index.html': 'Version 3' }))).status, 200);
  assert.equal((await request('/weather/')).body, 'Version 3');
  assert.equal(fs.readdirSync(path.join(config.dataDirectory, 'releases/weather')).length, 2);
});

test('invalid, missing-index, traversal, hidden-file and symlink archives preserve the active app', async t => {
  const { upload, request, config } = await running(t);
  const symlink = new AdmZip();
  symlink.addFile('index.html', Buffer.from('ok'));
  symlink.addFile('linked', Buffer.from('/etc/passwd'));
  symlink.getEntry('linked').attr = (0xa1ff << 16) >>> 0;
  const traversal = zip({ 'index.html': 'ok', 'safe.txt': 'bad' });
  for (let i = 0; (i = traversal.indexOf('safe.txt', i)) !== -1; i += 8) traversal.write('../p.txt', i);
  for (const archive of [Buffer.from('not a zip'), zip({ 'nested/index.html': 'wrong root' }), zip({ 'index.html': 'ok', '.env': 'secret' }), traversal, symlink.toBuffer()]) {
    const result = await upload('weather', archive);
    assert.equal(result.status, 400, result.body);
    assert.equal((await request('/weather/')).body, '<h1>Original weather</h1>');
  }
  assert.deepEqual(fs.readdirSync(path.join(config.dataDirectory, 'uploads')), []);
});

test('upload, file, expanded-size and entry limits reject ZIP bombs before activation', async t => {
  const limits = { ...defaultLimits, uploadBytes: 4096, fileBytes: 100, expandedBytes: 150, entries: 4 };
  const { upload, request } = await running(t, { limits });
  for (const archive of [zip({ 'index.html': 'x'.repeat(101) }), zip({ 'index.html': 'x'.repeat(80), 'a.txt': 'y'.repeat(80) }), zip({ 'index.html': 'ok', a: '', b: '', c: '', d: '' })]) assert.equal((await upload('weather', archive)).status, 400);
  assert.equal((await upload('weather', Buffer.alloc(4097))).status, 413);
  assert.equal((await request('/weather/')).body, '<h1>Original weather</h1>');
});

test('a lying decompressed-size header is bounded by actual output', async t => {
  const { upload } = await running(t, { limits: { ...defaultLimits, fileBytes: 100 } });
  const data = zip({ 'index.html': 'x'.repeat(1000000) });
  const central = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  data.writeUInt32LE(1, central + 24);
  assert.equal((await upload('attack', data)).status, 400);
});

test('reserved and external app names cannot replace management or shortcuts', async t => {
  const { upload, request } = await running(t);
  for (const slug of ['api', 'API', '_tailnow', 'resume-data', 'bad.name', '%2e%2e', 'x'.repeat(81)]) assert.equal((await upload(slug)).status, 400, slug);
  assert.equal((await upload('pigeon')).status, 409);
  assert.equal((await request('/pigeon')).status, 302);
});

test('minimize, removal, restore and shutdown have distinct persistent semantics', async t => {
  const files = fixture(t);
  const { request, manage, upload } = await running(t, {}, files);
  assert.equal((await manage('weather', 'minimize')).status, 200);
  assert.match((await request()).body, /id="minimized"/);
  assert.equal((await upload('weather')).status, 200);
  assert.match((await request()).body, /id="minimized"/);
  assert.equal((await manage('weather', 'remove')).status, 200);
  assert.equal((await request('/weather')).status, 404);
  assert.equal((await request('/weather/')).status, 200);
  assert.equal((await manage('weather', 'restore')).status, 200);
  assert.equal((await request('/weather')).status, 302);
  assert.equal((await manage('weather', 'shutdown')).status, 200);
  assert.equal((await request('/weather/')).status, 404);
  assert.equal((await request('/pigeon')).status, 302);
  const restarted = await running(t, {}, files);
  assert.equal((await restarted.request('/weather/')).status, 404);
  assert.match((await restarted.request()).body, /Shut down/);
  assert.equal((await upload('weather')).status, 200);
  assert.equal((await request('/weather/')).status, 200);
  assert.doesNotMatch((await request()).body, /id="removed"/);
});

test('external shutdown persists removal first, sanitizes failures and supports retry', async t => {
  let count = 0, runtime;
  runtime = await running(t, { shutdown: async app => {
    assert.equal(app.shutdown.label, 'com.example.pigeon');
    assert.equal(runtime.server.catalog.store.snapshot.apps.pigeon.shutdown, 'pending');
    if (++count === 1) throw new Error('/private/secret');
  } });
  const result = await runtime.manage('pigeon', 'shutdown');
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.body, /secret/);
  assert.equal((await runtime.request('/pigeon')).status, 404);
  assert.equal((await runtime.manage('pigeon', 'restore')).status, 409);
  assert.equal((await runtime.manage('pigeon', 'shutdown')).status, 200);
  assert.equal(runtime.server.catalog.store.snapshot.apps.pigeon.shutdown, 'stopped');
});

test('a catalog write failure never stops a service or replaces an active release', async t => {
  let stops = 0;
  const { manage, upload, request, config } = await running(t, { shutdown: async () => stops++ });
  fs.mkdirSync(path.join(config.dataDirectory, 'catalog.json'));
  assert.equal((await manage('pigeon', 'shutdown')).status, 503);
  assert.equal(stops, 0);
  assert.equal((await request('/pigeon')).status, 302);
  assert.equal((await upload('weather')).status, 503);
  assert.equal((await request('/weather/')).body, '<h1>Original weather</h1>');
  assert.equal(fs.readdirSync(config.dataDirectory).some(name => name.endsWith('.tmp')), false);
});

test('publishing and management share a lock while serving stays available', async t => {
  let started, finish;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const { manage, upload, request } = await running(t, { shutdown: async () => { started(); await gate; } });
  const first = manage('pigeon', 'shutdown');
  await began;
  try {
    assert.equal((await upload('new-app')).status, 409);
    assert.equal((await manage('weather', 'remove')).status, 409);
    assert.equal((await request('/weather/')).status, 200);
  } finally { finish(); }
  assert.equal((await first).status, 200);
});

test('host, origin and browser write checks protect the whole HTTP surface', async t => {
  const { request, upload, manage, server } = await running(t);
  for (const host of ['evil.example', 'mini.evil.example', 'mini:9999', '']) assert.equal((await request('/', { Host: host })).status, 403);
  for (const origin of ['null', 'https://evil.example']) assert.equal((await manage('weather', 'remove', { Origin: origin })).status, 403);
  assert.equal((await upload('weather', zip(), { Origin: 'http://mini' })).status, 403);
  assert.equal((await upload('weather', zip(), { Origin: 'http://mini', 'X-Tailnow-Request': '1' })).status, 200);
  assert.equal((await request('/api/apps/weather/remove', {}, 'POST')).status, 403);
  assert.equal((await manage('weather', 'remove', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' })).status, 403);
  assert.equal((await request('/api/publish/x', {}, 'OPTIONS')).status, 405);
  assert.equal((await request('/weather', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' })).status, 302);
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: mini\r\nHost: evil.example\r\nConnection: close\r\n\r\n'));
    let data = '';
    socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data)); socket.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 (400|403)/);
});

test('private files, traversal, symlinks and unexpected methods are not exposed', async t => {
  const { request, config } = await running(t);
  fs.symlinkSync(config.dataDirectory, path.join(config.sitesDirectory, 'weather/private'));
  fs.symlinkSync(path.join(config.sitesDirectory, 'weather'), path.join(config.sitesDirectory, 'linked-site'));
  for (const target of ['/tailnow.json', '/server.js', '/.git/config', '/data/catalog.json', '/weather/%2e%2e/index.html', '/weather/private/catalog.json', '/linked-site/', '/api/apps/weather/remove']) assert.equal((await request(target)).status, 404, target);
  for (const target of ['//evil.example', '/\\evil.example', 'http://evil.example/']) assert.equal((await request(target)).status, 400);
  assert.equal((await request('/', {}, 'DELETE')).status, 405);
  assert.equal((await request('/', { 'Content-Length': '1' })).status, 400);
  assert.equal((await request('/' + 'x'.repeat(2100))).status, 414);
  assert.equal((await request('/', { 'X-Large': 'x'.repeat(10000) })).status, 431);
});

test('dashboard escapes app text and isolates its CSP from hosted app scripts', async t => {
  const files = fixture(t);
  files.config.apps[0].name = '<script>alert(1)</script>';
  files.config.apps[0].description = '" onmouseover="bad';
  files.write();
  const { request } = await running(t, {}, files);
  const home = await request();
  assert.match(home.body, /&lt;script&gt;/);
  assert.doesNotMatch(home.body, /<script>alert/);
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await request('/weather/')).headers['content-security-policy'], undefined);
  assert.equal((await request('/app.js')).status, 200);
});

test('configuration reload fails closed and recovers, and caching avoids repeated reads', async t => {
  const live = await running(t, { reloadMs: 0 });
  fs.writeFileSync(live.configPath, '{private-value');
  assert.equal((await live.request()).status, 503);
  assert.doesNotMatch((await live.request()).body, /private-value/);
  live.write();
  assert.equal((await live.request()).status, 200);
  const cached = await running(t, { reloadMs: 60000 });
  fs.writeFileSync(cached.configPath, 'broken');
  assert.equal((await cached.request()).status, 200);
});

test('configuration rejects unsafe destinations, service mappings and storage locations', t => {
  const files = fixture(t);
  for (const url of ['http://external.example/', 'javascript:alert(1)', 'https://user:password@external.example/']) {
    files.config.apps[0].url = url; files.write(); assert.throws(() => loadConfig(files.configPath));
  }
  files.config.apps[0].url = 'https://external.example/';
  for (const label of ['../x', 'x;reboot', 'com.example.tailnow']) {
    files.config.apps[0].service.label = label; files.write(); assert.throws(() => loadConfig(files.configPath));
  }
  files.config.apps[0].service.label = 'com.example.pigeon';
  files.config.dataDirectory = path.join(files.config.sitesDirectory, 'private');
  files.write(); assert.throws(() => loadConfig(files.configPath));
});

test('invalid catalog state fails startup without silently restoring removed entries', t => {
  const { dir } = fixture(t);
  const file = path.join(dir, 'state.json');
  for (const state of ['invalid private value', '{"version":1,"apps":[],"deployments":{}}', '{"version":1,"apps":{},"deployments":{"weather":{"release":"../../secret"}}}']) {
    fs.writeFileSync(file, state); assert.throws(() => new StateStore(file));
  }
});

test('special property names work as app names and persisted state keys', async t => {
  const { upload, request, manage } = await running(t);
  assert.equal((await upload('__proto__')).status, 200);
  assert.equal((await manage('__proto__', 'minimize')).status, 200);
  assert.equal((await request('/__proto__/')).status, 200);
  assert.equal((await manage('__proto__', 'shutdown')).status, 200);
  assert.equal((await request('/__proto__/')).status, 404);
});

test('LaunchAgent shutdown disables, unloads and verifies the exact configured service', async () => {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push(args); assert.equal(file, '/bin/launchctl'); assert.equal(options.shell, undefined);
    if (args[0] === 'print') throw Object.assign(new Error('missing'), { code: 113, stderr: 'Could not find service' });
  };
  const app = { shutdown: { type: 'launchAgent', label: 'com.example.pigeon' } };
  await stopApp(app, { run, platform: 'darwin', uid: 501 });
  assert.deepEqual(calls, ['disable', 'bootout', 'print'].map(action => [action, 'gui/501/com.example.pigeon']));
  await assert.rejects(stopApp(app, { run: async () => {}, platform: 'darwin', uid: 501 }));
  await assert.rejects(stopApp(app, { run, platform: 'linux', uid: 501 }));
});

test('startup failures and occupied ports return only a sanitized diagnostic', async t => {
  const files = fixture(t);
  const { server } = await running(t, {}, files);
  const script = path.resolve(__dirname, '../server.js');
  for (const env of [{ PORT: 'invalid' }, { HOST: '0.0.0.0' }, { TAILNOW_CONFIG: '/missing/private-config' }, { PORT: String(server.address().port) }]) {
    const result = spawnSync(process.execPath, [script], { env: { ...process.env, TAILNOW_CONFIG: files.configPath, ...env }, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'TailNow could not start; check the local configuration, files, and port.\n');
  }
});
