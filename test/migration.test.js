const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { importMini } = require('../scripts/import-mini-shortcuts');
const { loadConfig } = require('../src/validation');
const { StateStore } = require('../src/state-store');
const { prepare } = require('../scripts/migrate-security');

test('migration preserves configured apps, service controls and hidden states without touching source files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnow-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const miniConfigPath = path.join(dir, 'mini.json'), miniStatePath = path.join(dir, 'mini.state.json');
  const configPath = path.join(dir, 'tailnow.json'), dataDirectory = path.join(dir, 'data'), sitesDirectory = path.join(dir, 'sites');
  const mini = { allowedHosts: ['mini', 'mini.example.ts.net', '127.0.0.1:8790'], apps: [{ slug: 'pigeon', name: 'Pigeon', url: 'https://mini.example.ts.net:8443/', service: { type: 'launchAgent', label: 'com.example.pigeon' } }], tailnow: { directory: sitesDirectory, url: 'https://mini.example.ts.net/' } };
  const state = { version: 1, apps: { weather: { name: 'Weather', visibility: 'minimized', shutdown: 'none' }, notes: { name: 'Notes', visibility: 'removed', shutdown: 'stopped' } } };
  fs.writeFileSync(miniConfigPath, JSON.stringify(mini)); fs.writeFileSync(miniStatePath, JSON.stringify(state));
  const options = { miniConfigPath, miniStatePath, configPath, dataDirectory, sitesDirectory, allowedHosts: ['127.0.0.1:8080'], baseUrl: 'https://mini.example.ts.net:8446/' };
  assert.throws(() => importMini({ ...options, baseUrl: mini.tailnow.url }), /fresh/);
  importMini(options);
  const config = loadConfig(configPath);
  assert.equal(config.entries.get('pigeon').shutdown.label, 'com.example.pigeon');
  assert.equal(config.allowedHosts.has('127.0.0.1:8790'), false);
  assert.equal(config.allowedHosts.has('127.0.0.1:8080'), true);
  assert.deepEqual(new StateStore(path.join(dataDirectory, 'catalog.json')).snapshot.apps, state.apps);
  assert.deepEqual(JSON.parse(fs.readFileSync(miniConfigPath)), mini);
  assert.deepEqual(JSON.parse(fs.readFileSync(miniStatePath)), state);
  assert.throws(() => importMini(options), /already initialized/);
});

test('security migration assigns fresh origins, preserves state and files, and avoids existing services', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnow-origins-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sitesDirectory = path.join(root, 'sites'), dataDirectory = path.join(root, 'data');
  fs.mkdirSync(path.join(sitesDirectory, '__proto__'), { recursive: true });
  fs.mkdirSync(path.join(sitesDirectory, 'legacy')); fs.mkdirSync(dataDirectory);
  const state = { version: 1, apps: { stopped: { name: 'Stopped', visibility: 'removed', shutdown: 'stopped' } }, deployments: { stopped: { release: null } }, order: ['stopped', 'legacy'] };
  const stateFile = path.join(dataDirectory, 'catalog.json'); fs.writeFileSync(stateFile, JSON.stringify(state));
  const configPath = path.join(root, 'old.json'), outputPath = path.join(root, 'new.json');
  const old = { baseUrl: 'https://mini.example/', allowedHosts: ['mini.example'], serviceLabel: 'com.example.tailnow', sitesDirectory, dataDirectory,
    apps: [{ slug: 'linked', name: 'Linked', url: 'https://mini.example:8500/' }] };
  fs.writeFileSync(configPath, JSON.stringify(old));
  const next = prepare({ configPath, outputPath, reservedPorts: [8501] });
  assert.equal(next.baseUrl, 'https://mini.example:8446/');
  assert.deepEqual(next.legacyOrigins, ['https://mini.example']);
  assert.deepEqual(Object.keys(next.siteOrigins).sort(), ['__proto__', 'legacy', 'stopped']);
  assert.equal(next.siteOrigins.__proto__, 'https://mini.example:8502');
  assert.deepEqual(loadConfig(outputPath).entries.get('linked').url, old.apps[0].url);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), old);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)), state);
  assert.throws(() => prepare({ configPath, outputPath }), /EEXIST/);
  assert.throws(() => prepare({ configPath, outputPath: path.join(root, 'bad.json'), adminPort: 8500 }), /reserved/);
  assert.throws(() => prepare({ configPath: outputPath, outputPath: path.join(root, 'again.json') }), /already/);
});
