const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { loadConfig, hostName } = require('./validation');
const { StateStore } = require('./state-store');
const { Catalog, AppError } = require('./catalog');
const { publish, defaultLimits } = require('./publisher');
const { stopApp } = require('./services');
const { home } = require('./view');

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

function createServer({ configPath, reloadMs = 1000, shutdown = stopApp, limits = defaultLimits } = {}) {
  const config = loadConfig(configPath);
  fs.mkdirSync(config.sitesDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  for (const location of [config.sitesDirectory, config.dataDirectory]) if (!fs.lstatSync(location).isDirectory()) throw new Error('Storage must not be a symlink');
  const uploadDirectory = path.join(config.dataDirectory, 'uploads');
  fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
  const store = new StateStore(path.join(config.dataDirectory, 'catalog.json'));
  const catalog = new Catalog({ configPath, store, reloadMs });
  const assets = new Map([
    ['/style.css', ['text/css', fs.readFileSync(path.join(__dirname, '../public/style.css'))]],
    ['/app.js', ['text/javascript', fs.readFileSync(path.join(__dirname, '../public/app.js'))]],
  ]);
  const upload = multer({ dest: uploadDirectory, limits: { fileSize: limits.uploadBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 32 } }).single('file');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD, POST').send('Method not allowed');
    if (!req.url || req.url.length > 2048) return res.status(414).send('Request target too long');
    if (!/^\/(?!\/)/.test(req.url) || /[\\\x00-\x20\x7f]/.test(req.url)) return res.status(400).send('Invalid request target');
    try {
      req.catalog = catalog.snapshot();
      const host = hostName(req.headers.host);
      const count = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host').length;
      if (count !== 1 || !req.catalog.allowedHosts.has(host)) throw new AppError(403, 'Unrecognized host');
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new AppError(403, 'Cross-origin request blocked'); }
        if (!['http:', 'https:'].includes(origin.protocol) || hostName(origin.host) !== host) throw new AppError(403, 'Cross-origin request blocked');
      }
      if (req.headers['sec-fetch-site'] === 'cross-site' && (req.method === 'POST' || req.headers['sec-fetch-mode'] !== 'navigate')) throw new AppError(403, 'Cross-site request blocked');
    } catch (error) { return next(error instanceof AppError ? error : new AppError(403, 'Invalid host or origin')); }
    next();
  });
  app.use(async (req, res, next) => {
    const pathname = req.url.split('?')[0];
    const publishMatch = /^\/api\/publish\/([^/]+)$/.exec(pathname);
    const action = /^\/api\/apps\/([a-zA-Z0-9_-]{1,80})\/(minimize|restore|remove|shutdown)$/.exec(pathname);
    if (pathname.startsWith('/api/') || pathname === '/' || assets.has(pathname)) dashboardHeaders(res);
    if (req.method === 'POST') {
      if (req.url !== pathname || (!publishMatch && !action)) return res.status(405).send('Method not allowed');
      const header = req.headers['x-tailnow-request'] === '1' || req.headers['x-mini-request'] === '1';
      // CLI publishing stays compatible. Browsers must use a custom header;
      // cross-origin preflights never receive CORS permission.
      if (!header && (action || req.headers.origin || req.headers['sec-fetch-site'])) return res.status(403).send('Management request blocked');
      if (publishMatch) {
        let release;
        try {
          const slug = publishMatch[1];
          catalog.assertPublishable(slug);
          release = catalog.acquire();
          await new Promise((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
          if (!req.file) throw new AppError(400, 'No ZIP file provided. Use the multipart field named file.');
          const result = await publish(catalog, slug, req.file.path, limits);
          return res.json(result);
        } catch (error) { return next(error); }
        finally {
          if (req.file?.path) fs.rmSync(req.file.path, { force: true });
          release?.();
        }
      }
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return res.status(400).set('Connection', 'close').send('Management requests have no body');
      try { await catalog.manage(action[1], action[2], shutdown); return res.type('text').send('Saved'); }
      catch (error) { return next(error); }
    }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return res.status(400).set('Connection', 'close').send('Read requests have no body');
    if (pathname === '/') return res.type('html').send(home(req.catalog.entries, req.catalog.state, req.catalog.baseUrl));
    if (assets.has(pathname)) { const [type, content] = assets.get(pathname); return res.type(type).send(content); }
    if (pathname === '/api/health') return res.json({ service: 'tailnow', version: 2, status: 'ok' });
    if (pathname === '/api/apps') return res.json({ apps: [...req.catalog.entries.values()].map(({ slug, name, description, kind, url }) => ({ slug, name, description, kind, url, visibility: req.catalog.state[slug]?.visibility || 'visible' })) });
    const shortcut = /^\/([a-zA-Z0-9_-]{1,80})(\/?)$/.exec(pathname);
    const entry = shortcut && req.catalog.entries.get(shortcut[1]);
    if (entry && (entry.kind === 'external' || !shortcut[2])) {
      if (req.catalog.state[entry.slug]?.visibility === 'removed') return res.status(404).send('Shortcut removed from the directory');
      return res.redirect(302, entry.url);
    }
    if (pathname.startsWith('/api/')) return res.status(404).send('Unknown API endpoint');
    // Resolve only a selected release, never the private storage directory.
    try {
      const decoded = decodeURIComponent(pathname);
      if (decoded.split('/').some(part => part === '.' || part === '..') || decoded.includes('\\')) throw new Error('Invalid path');
      const parts = decoded.split('/').slice(1);
      if (req.catalog.entries.get(parts[0])?.kind !== 'site') return res.status(404).send('App not found');
      const root = catalog.siteRoot(parts.shift());
      let file = safeFile(root, parts);
      if (!file) return res.status(404).send('File not found');
      if (fs.lstatSync(file).isDirectory()) {
        if (!pathname.endsWith('/')) return res.redirect(302, pathname + '/' + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''));
        file = safeFile(file, ['index.html']);
      }
      if (!file || !fs.lstatSync(file).isFile()) return res.status(404).send('File not found');
      res.set('Cache-Control', 'no-cache');
      return res.sendFile(file, { dotfiles: 'deny', cacheControl: false }, error => {
        if (error && !res.headersSent) res.status(error.status === 416 ? 416 : 404).end();
      });
    } catch { return res.status(404).send('File not found'); }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === 'ECONNRESET' || req.aborted) return res.destroy();
    const status = error instanceof AppError ? error.status : error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : 503;
    const message = error instanceof AppError ? error.message : error instanceof multer.MulterError ? 'Upload exceeds the allowed size or multipart limits.' : 'This change could not be completed. Please try again.';
    res.status(status).type('text').send(message);
  });
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 120000, connectionsCheckingInterval: 1000 }, app);
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.setTimeout(120000, socket => socket.destroy());
  server.catalog = catalog;
  return server;
}
module.exports = { createServer };
