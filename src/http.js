const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { loadConfig, hostName, escape } = require('./validation');
const { StateStore } = require('./state-store');
const { Catalog, AppError } = require('./catalog');
const { publish, defaultLimits } = require('./publisher');
const { stopApp } = require('./services');
const { home } = require('./view');
const { AdminAuth } = require('./auth');
const { checkCapacity, pruneReleases } = require('./storage');
const { proxyApi } = require('./proxy');

function dashboardHeaders(res) {
  res.set({
    'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });
}

function safeFile(root, segments) {
  if (!root || !fs.lstatSync(root).isDirectory()) return null;
  let location = root;
  for (const segment of segments.filter(Boolean)) {
    if (segment.startsWith('.') || /[\\\x00-\x1f\x7f]/.test(segment)) return null;
    location = path.join(location, segment);
    const stat = fs.lstatSync(location);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return null;
  }
  return location;
}

function decodedParts(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.split('/').some(part => part === '.' || part === '..') || /[\\\x00-\x1f\x7f]/.test(decoded)) throw new Error('Invalid path');
  return decoded.split('/').slice(1);
}

function noBody(req) {
  if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) throw new AppError(400, 'This request must have no body');
}

function migrationPage(config, slug, receiver, destination, sourceOrigin) {
  const settings = { slug, keys: config.storageKeys.get(slug) || [], targetOrigin: config.siteOrigins.get(slug), legacyOrigins: config.legacyOrigins, receiver, destination, sourceOrigin };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Opening your app</title><script src="/_tailnow/migrate.js" defer></script></head><body><p id="status">Moving this app’s saved preferences to its private address…</p><a id="continue" href="${escape(destination || '/')}" hidden>Continue to the app</a><div id="settings" data-value="${escape(JSON.stringify(settings))}" hidden></div></body></html>`;
}

function createServer({ configPath, reloadMs = 1000, shutdown = stopApp, limits = defaultLimits, authOptions } = {}) {
  let config = loadConfig(configPath);
  fs.mkdirSync(config.sitesDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  config = loadConfig(configPath);
  fs.chmodSync(config.dataDirectory, 0o700);
  const uploadDirectory = path.join(config.dataDirectory, 'uploads');
  fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(uploadDirectory).isDirectory()) throw new Error('Upload storage must not be a symlink');
  fs.chmodSync(uploadDirectory, 0o700);
  const store = new StateStore(path.join(config.dataDirectory, 'catalog.json'));
  const catalog = new Catalog({ configPath, store, reloadMs });
  const auth = new AdminAuth(config.dataDirectory, authOptions);
  const assets = new Map([
    ['/style.css', ['text/css', fs.readFileSync(path.join(__dirname, '../public/style.css'))]],
    ['/app.js', ['text/javascript', fs.readFileSync(path.join(__dirname, '../public/app.js'))]],
    ['/_tailnow/migrate.js', ['text/javascript', fs.readFileSync(path.join(__dirname, '../public/migrate.js'))]],
  ]);
  const upload = multer({ dest: uploadDirectory, limits: { fileSize: limits.uploadBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 32 } }).single('file');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Origin-Agent-Cluster': '?1', 'Cross-Origin-Opener-Policy': 'same-origin' });
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return res.status(405).send('Method not allowed');
    if (!req.url || req.url.length > 2048) return res.status(414).send('Request target too long');
    if (!/^\/(?!\/)/.test(req.url) || /[\\\x00-\x20\x7f]/.test(req.url)) return res.status(400).send('Invalid request target');
    try {
      req.catalog = catalog.snapshot(); req.hostKey = hostName(req.headers.host);
      const count = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host').length;
      req.site = req.catalog.originSites.get(req.hostKey);
      if (count !== 1 || (!req.site && !req.catalog.allowedHosts.has(req.hostKey))) throw new AppError(403, 'Unrecognized host');
      req.isAdminOrigin = req.hostKey === hostName(new URL(req.catalog.baseUrl).host);
      req.expectedOrigin = req.site ? req.catalog.siteOrigins.get(req.site) : new URL(req.catalog.baseUrl).origin;
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new AppError(403, 'Cross-origin request blocked'); }
        if (origin.origin !== req.expectedOrigin || req.headers.origin !== origin.origin) throw new AppError(403, 'Cross-origin request blocked');
      }
      const site = req.headers['sec-fetch-site'];
      const navigation = ['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-mode'] === 'navigate';
      // Different ports are same-site but not same-origin. Reject both types
      // of cross-origin subresource/API access, including credentialless loads.
      if (site && !['same-origin', 'none'].includes(site) && !navigation) throw new AppError(403, 'Cross-origin request blocked');
    } catch (error) { return next(error instanceof AppError ? error : new AppError(403, 'Invalid host or origin')); }
    next();
  });
  app.use(async (req, res, next) => {
    try {
      const pathname = req.url.split('?')[0], config = req.catalog;
      if (req.site) {
        if (pathname === '/_tailnow/migrate.js' && ['GET', 'HEAD'].includes(req.method)) {
          noBody(req); dashboardHeaders(res); return res.type('text/javascript').send(assets.get(pathname)[1]);
        }
        if (pathname === '/_tailnow/storage-import' && ['GET', 'HEAD'].includes(req.method)) {
          noBody(req); dashboardHeaders(res); res.removeHeader('X-Frame-Options');
          res.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; base-uri 'none'; frame-ancestors ${config.legacyOrigins.join(' ') || "'none'"}; form-action 'none'`);
          return res.type('html').send(migrationPage(config, req.site, true, `/${req.site}/`));
        }
        let parts;
        try { parts = decodedParts(pathname); } catch { throw new AppError(404, 'File not found'); }
        const proxy = (config.apiProxies.get(req.site) || []).find(item => pathname.startsWith(item.prefix));
        if (proxy) return await proxyApi(req, res, proxy);
        if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, 'Method not allowed');
        noBody(req);
        if (pathname === '/') return res.redirect(302, `/${req.site}/`);
        const slug = parts.shift();
        if (slug !== req.site && !config.dependencies.get(req.site)?.has(slug)) {
          const other = config.entries.get(slug);
          if (other && req.headers['sec-fetch-mode'] === 'navigate' && config.state[slug]?.visibility !== 'removed') {
            return res.redirect(302, other.kind === 'site' ? config.siteOrigins.get(slug) + req.url : other.url);
          }
          throw new AppError(404, 'App not found');
        }
        if (config.entries.get(slug)?.kind !== 'site') throw new AppError(404, 'App not found');
        try {
          let file = safeFile(catalog.siteRoot(slug), parts);
          if (!file) throw new Error();
          if (fs.lstatSync(file).isDirectory()) {
            if (!pathname.endsWith('/')) return res.redirect(302, pathname + '/' + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''));
            file = safeFile(file, ['index.html']);
          }
          if (!file || !fs.lstatSync(file).isFile()) throw new Error();
          res.set({ 'Cache-Control': 'no-cache', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'" });
          return res.sendFile(file, { dotfiles: 'deny', cacheControl: false }, error => {
            if (error && !res.headersSent) res.status(error.status === 416 ? 416 : 404).end();
          });
        } catch { throw new AppError(404, 'File not found'); }
      }
      dashboardHeaders(res);
      if (['GET', 'HEAD'].includes(req.method) && pathname === '/api/health') { noBody(req); return res.json({ service: 'tailnow', version: 3, status: 'ok' }); }
      if (!req.isAdminOrigin) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(403, 'Use the administration address');
        noBody(req);
        if (pathname === '/_tailnow/migrate.js') return res.type('text/javascript').send(assets.get(pathname)[1]);
      }
      const publishMatch = /^\/api\/publish\/([^/]+)$/.exec(pathname);
      const action = /^\/api\/apps\/([a-zA-Z0-9_-]{1,80})\/(minimize|restore|remove|shutdown)$/.exec(pathname);
      const reorder = /^\/api\/apps\/([a-zA-Z0-9_-]{1,80})\/(?:before\/([a-zA-Z0-9_-]{1,80})|last)$/.exec(pathname);
      if (req.method === 'POST') {
        if (req.url !== pathname) throw new AppError(405, 'Method not allowed');
        if ((req.headers.origin || req.headers['sec-fetch-site']) && req.headers['x-tailnow-request'] !== '1') throw new AppError(403, 'Management request blocked');
        if (pathname === '/api/admin/login') {
          noBody(req); const result = auth.login(req);
          if (result.status !== 200) return res.status(result.status).send(result.status === 429 ? 'Too many sign-in attempts. Wait a minute.' : 'Invalid administrator key');
          return res.json({ token: result.token, expiresAt: result.expiresAt });
        }
        if (!auth.authorized(req)) throw new AppError(401, 'Administrator sign-in required');
        if (pathname === '/api/admin/logout') { noBody(req); auth.logout(req); return res.send('Signed out'); }
        if (!publishMatch && !action && !reorder) throw new AppError(405, 'Method not allowed');
        if (publishMatch) {
          let release;
          try {
            catalog.assertPublishable(publishMatch[1]); release = catalog.acquire();
            pruneReleases(catalog); checkCapacity(catalog, limits);
            await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
            if (!req.file) throw new AppError(400, 'No ZIP file provided. Use the multipart field named file.');
            return res.json(await publish(catalog, publishMatch[1], req.file.path, limits));
          } finally {
            try { if (req.file?.path) fs.rmSync(req.file.path, { force: true }); }
            finally { release?.(); }
          }
        }
        noBody(req);
        if (reorder) catalog.reorder(reorder[1], reorder[2] || null);
        else await catalog.manage(action[1], action[2], shutdown);
        return res.type('text').send('Saved');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new AppError(405, 'Method not allowed');
      noBody(req);
      if (req.isAdminOrigin) {
        if (pathname === '/') return res.type('html').send(home(config.entries, config.state));
        if (pathname === '/app.js' || pathname === '/style.css') { const [type, content] = assets.get(pathname); return res.type(type).send(content); }
        if (pathname === '/api/admin/session') {
          if (!auth.authorized(req)) throw new AppError(401, 'Administrator sign-in required');
          return res.json({ admin: true });
        }
        if (pathname === '/api/apps') return res.json({ apps: [...config.entries.values()].map(({ slug, name, description, kind, url }) => ({ slug, name, description, kind, url, visibility: config.state[slug]?.visibility || 'visible' })) });
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/_tailnow/')) throw new AppError(404, 'Unknown endpoint');
      if (pathname === '/') return res.redirect(302, config.baseUrl);
      let parts;
      try { parts = decodedParts(pathname); } catch { throw new AppError(404, 'File not found'); }
      const entry = config.entries.get(parts[0]);
      if (!entry) throw new AppError(404, 'App not found');
      if (entry.kind === 'external') {
        if (parts.slice(1).some(Boolean) || config.state[entry.slug]?.visibility === 'removed') throw new AppError(404, 'Shortcut removed');
        return res.redirect(302, entry.url);
      }
      if (pathname === `/${entry.slug}` && config.state[entry.slug]?.visibility === 'removed') throw new AppError(404, 'Shortcut removed');
      const destination = config.siteOrigins.get(entry.slug) + req.url;
      const oldOrigin = config.legacyOrigins.find(origin => hostName(new URL(origin).host) === req.hostKey);
      if (oldOrigin && config.storageKeys.get(entry.slug)?.length && (pathname === `/${entry.slug}` || pathname === `/${entry.slug}/`)) {
        res.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; frame-src ${config.siteOrigins.get(entry.slug)}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
        return res.type('html').send(migrationPage(config, entry.slug, false, destination, oldOrigin));
      }
      return res.redirect(302, destination);
    } catch (error) { return next(error); }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === 'ECONNRESET' || req.aborted) return res.destroy();
    const status = error instanceof AppError ? error.status : error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : 503;
    const message = error instanceof AppError ? error.message : error instanceof multer.MulterError ? 'Upload exceeds the allowed size or multipart limits.' : 'This change could not be completed. Please try again.';
    res.status(status).type('text').send(message);
  });
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 120000, connectionsCheckingInterval: 1000 }, app);
  server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100; server.maxConnections = 128;
  server.setTimeout(120000, socket => socket.destroy());
  server.catalog = catalog; server.auth = auth;
  return server;
}
module.exports = { createServer };
