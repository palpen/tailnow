const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { createServer } = require('../src/http');

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath());
if (process.env.REQUIRE_BROWSER_TESTS === '1' && !fs.existsSync(chrome)) throw new Error('Install Chromium before running the required browser tests');
const browserOptions = { skip: !fs.existsSync(chrome), timeout: 30000 };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnow-browser-'));
  const keyPath = path.join(root, 'key.pem'), certPath = path.join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const tls = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  let backend;
  const proxies = [];
  for (let i = 0; i < 4; i++) {
    const proxy = https.createServer(tls, (req, res) => {
      const upstream = http.request({ hostname: '127.0.0.1', port: backend.address().port, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on('error', () => { res.statusCode = 502; res.end(); }); req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); proxies.push(proxy);
  }
  const [admin, alpha, beta, legacy] = proxies.map(proxy => `https://127.0.0.1:${proxy.address().port}`);
  const config = { baseUrl: admin + '/', allowedHosts: [new URL(admin).host, new URL(legacy).host], legacyOrigins: [legacy],
    sitesDirectory: path.join(root, 'sites'), dataDirectory: path.join(root, 'private'), serviceLabel: 'com.example.tailnow', apps: [],
    siteOrigins: { alpha, beta }, siteOptions: { alpha: { storageKeys: ['alpha-private'] }, beta: { storageKeys: ['beta-private'] } } };
  for (const slug of ['alpha', 'beta']) { fs.mkdirSync(path.join(config.sitesDirectory, slug), { recursive: true }); fs.writeFileSync(path.join(config.sitesDirectory, slug, 'index.html'), `<!doctype html><h1>${slug}</h1>`); }
  fs.writeFileSync(path.join(config.sitesDirectory, 'beta', 'private.json'), '{"secret":"BETA PRIVATE FILE"}');
  const configPath = path.join(root, 'config.json'); fs.writeFileSync(configPath, JSON.stringify(config));
  backend = createServer({ configPath }); await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  t.after(async () => {
    await browser.close();
    for (const server of [backend, ...proxies]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { context, backend, admin, alpha, beta, legacy, key: fs.readFileSync(path.join(config.dataDirectory, 'admin-token'), 'utf8').trim() };
}

test('browser: readers have no controls; login, authenticated changes, reload, and logout work', browserOptions, async t => {
  const a = await fixture(t), page = await a.context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(a.admin);
  assert.equal(await page.locator('#toggle-reorder').isVisible(), false);
  assert.equal(await page.locator('button[data-action="minimize"]').first().isVisible(), false);
  await page.locator('#sign-in').click(); await page.locator('#admin-key').fill(a.key); await page.locator('#submit-login').click();
  await page.waitForFunction(() => document.body.classList.contains('is-admin'));
  assert.equal(await page.locator('#admin-key').inputValue(), '');
  assert.equal(await page.locator('#toggle-reorder').isVisible(), true);
  await page.locator('[data-slug="alpha"][data-action="minimize"]').click();
  await page.waitForFunction(() => document.querySelector('#minimized'));
  await page.waitForFunction(() => document.body.classList.contains('is-admin'));
  assert.equal(a.backend.catalog.store.snapshot.apps.alpha.visibility, 'minimized');
  const session = await page.evaluate(() => sessionStorage.getItem('tailnow-admin-session'));
  assert.notEqual(session, a.key); assert.ok(session);
  assert.deepEqual(await a.context.cookies(), []);
  await page.locator('#sign-out').click(); await page.waitForFunction(() => !document.body.classList.contains('is-admin'));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tailnow-admin-session')), null);
  assert.equal(await page.evaluate(async token => (await fetch('/api/admin/session', { headers: { Authorization: `Bearer ${token}` } })).status, session), 401);
  assert.deepEqual(errors, []);
});

test('browser: independent ports isolate storage, block peer files, and cannot manage the directory', browserOptions, async t => {
  const a = await fixture(t), page = await a.context.newPage();
  await page.goto(a.beta + '/beta/'); await page.evaluate(() => localStorage.setItem('beta-private', 'SYNTHETIC SECRET'));
  await page.goto(a.admin); await page.evaluate(() => sessionStorage.setItem('tailnow-admin-session', 'SYNTHETIC SESSION'));
  await page.goto(a.alpha + '/alpha/');
  const result = await page.evaluate(async ({ beta, admin }) => {
    const read = async url => { try { const response = await fetch(url); return { status: response.status, body: await response.text() }; } catch { return { blocked: true }; } };
    const mutate = async url => { try { return (await fetch(url, { method: 'POST', headers: { 'X-Tailnow-Request': '1' } })).status; } catch { return 'blocked'; } };
    return { peerStorage: localStorage.getItem('beta-private'), adminSession: sessionStorage.getItem('tailnow-admin-session'), peerFile: await read(beta + '/beta/private.json'), peerPath: await read('/beta/private.json'), catalog: await read('/api/apps'), adminMutation: await mutate(admin + '/api/apps/beta/shutdown') };
  }, { beta: a.beta, admin: a.admin });
  assert.equal(result.peerStorage, null); assert.equal(result.adminSession, null); assert.deepEqual(result.peerFile, { blocked: true });
  assert.equal(result.peerPath.status, 404); assert.equal(result.catalog.status, 404); assert.equal(result.adminMutation, 'blocked');
  assert.equal(a.backend.catalog.store.snapshot.apps.beta, undefined);
});

test('browser: legacy storage migration copies only owned keys once and preserves newer data', browserOptions, async t => {
  const a = await fixture(t), page = await a.context.newPage();
  await a.context.addInitScript(({ legacy }) => {
    if (location.origin === legacy && !localStorage.getItem('seeded')) {
      localStorage.setItem('alpha-private', 'SAVED ALPHA DATA'); localStorage.setItem('beta-private', 'DO NOT SHARE'); localStorage.setItem('seeded', '1');
    }
  }, { legacy: a.legacy });
  await page.goto(a.legacy + '/alpha/'); await page.waitForURL(a.alpha + '/alpha/');
  assert.equal(await page.evaluate(() => localStorage.getItem('alpha-private')), 'SAVED ALPHA DATA');
  assert.equal(await page.evaluate(() => localStorage.getItem('beta-private')), null);
  await page.evaluate(() => localStorage.setItem('alpha-private', 'NEWER DATA'));
  await page.goto(a.legacy + '/_tailnow/migrate.js');
  assert.equal(await page.evaluate(() => localStorage.getItem('alpha-private')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('beta-private')), 'DO NOT SHARE');
  await page.evaluate(() => localStorage.setItem('alpha-private', 'STALE DATA'));
  await page.goto(a.legacy + '/alpha/'); await page.waitForURL(a.alpha + '/alpha/');
  assert.equal(await page.evaluate(() => localStorage.getItem('alpha-private')), 'NEWER DATA');
});
