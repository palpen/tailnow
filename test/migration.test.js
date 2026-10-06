const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { importMini } = require('../scripts/import-mini-shortcuts');
const { loadConfig } = require('../src/validation');
const { StateStore } = require('../src/state-store');

test('migration preserves configured apps, service controls and hidden states without touching source files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnow-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const miniConfigPath = path.join(dir, 'mini.json'), miniStatePath = path.join(dir, 'mini.state.json');
  const configPath = path.join(dir, 'tailnow.json'), dataDirectory = path.join(dir, 'data'), sitesDirectory = path.join(dir, 'sites');
  const mini = { allowedHosts: ['mini', 'mini.example.ts.net', '127.0.0.1:8790'], apps: [{ slug: 'pigeon', name: 'Pigeon', url: 'https://mini.example.ts.net:8443/', service: { type: 'launchAgent', label: 'com.example.pigeon' } }], tailnow: { directory: sitesDirectory, url: 'https://mini.example.ts.net/' } };
  const state = { version: 1, apps: { weather: { name: 'Weather', visibility: 'minimized', shutdown: 'none' }, notes: { name: 'Notes', visibility: 'removed', shutdown: 'stopped' } } };
  fs.writeFileSync(miniConfigPath, JSON.stringify(mini)); fs.writeFileSync(miniStatePath, JSON.stringify(state));
  const options = { miniConfigPath, miniStatePath, configPath, dataDirectory, sitesDirectory, allowedHosts: ['127.0.0.1:8080'] };
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
