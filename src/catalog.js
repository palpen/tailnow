const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validSlug } = require('./validation');
const { setEntry } = require('./state-store');

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class Catalog {
  constructor({ configPath, store, reloadMs = 1000 }) {
    this.configPath = configPath;
    this.store = store;
    this.reloadMs = reloadMs;
    this.config = loadConfig(configPath);
    this.locations = [this.config.sitesDirectory, this.config.dataDirectory];
    this.checkedAt = -Infinity;
    this.busy = false;
    this.snapshot(true);
  }
  snapshot(force = false) {
    if (force || performance.now() - this.checkedAt >= this.reloadMs) {
      this.checkedAt = performance.now();
      try {
        const config = loadConfig(this.configPath);
        if (config.sitesDirectory !== this.locations[0] || config.dataDirectory !== this.locations[1]) throw new Error('Restart to change storage');
        const origins = this.store.snapshot.origins || {}, adminOrigins = this.store.snapshot.adminOrigins || [], legacyOrigins = this.store.snapshot.legacyOrigins || [];
        const adminOrigin = new URL(config.baseUrl).origin;
        if (Object.hasOwn(origins, adminOrigin) || legacyOrigins.includes(adminOrigin)) throw new Error('A former app or shared origin cannot become an administrator origin');
        for (const [slug, origin] of config.siteOrigins) {
          if ((Object.hasOwn(origins, origin) && origins[origin] !== slug) || adminOrigins.includes(origin) || legacyOrigins.includes(origin)) throw new Error('An origin cannot be reassigned to a different application');
        }
        if (config.legacyOrigins.some(origin => Object.hasOwn(origins, origin) || adminOrigins.includes(origin))) throw new Error('Only former shared origins can migrate browser storage');
        if (!adminOrigins.includes(adminOrigin) || config.legacyOrigins.some(origin => !legacyOrigins.includes(origin)) || [...config.siteOrigins.values()].some(origin => !Object.hasOwn(origins, origin))) this.store.update(state => {
          state.origins ||= {}; state.adminOrigins ||= []; state.legacyOrigins ||= [];
          if (!state.adminOrigins.includes(adminOrigin)) state.adminOrigins.push(adminOrigin);
          for (const origin of config.legacyOrigins) if (!state.legacyOrigins.includes(origin)) state.legacyOrigins.push(origin);
          for (const [slug, origin] of config.siteOrigins) setEntry(state.origins, origin, slug);
        });
        const sites = new Set();
        const directory = fs.opendirSync(config.sitesDirectory);
        try {
          let count = 0;
          for (let item; (item = directory.readSync()) !== null;) {
            if (++count > 2000) throw new Error('Too many sites');
            if (item.isDirectory() && validSlug(item.name)) sites.add(item.name);
          }
        } finally { directory.closeSync(); }
        for (const [slug, deployment] of Object.entries(this.store.snapshot.deployments)) {
          if (deployment.release === null) sites.delete(slug); else sites.add(slug);
        }
        const entries = new Map(config.entries);
        for (const slug of [...sites].sort()) {
          if (entries.has(slug)) continue;
          if (entries.size >= 500) throw new Error('Too many apps');
          if (!config.siteOrigins.has(slug)) throw new Error('Assign an isolated HTTPS origin to each hosted app');
          const url = new URL(`${slug}/`, config.siteOrigins.get(slug)).href;
          // Directory visits carry existing browser data across automatically.
          // The canonical publication URL remains the isolated app address.
          const legacy = config.storageKeys.get(slug)?.length && config.legacyOrigins.find(origin => new URL(origin).hostname === new URL(url).hostname);
          entries.set(slug, { slug, kind: 'site', name: slug.replaceAll('-', ' '), description: 'Published with TailNow', ...config.siteMetadata.get(slug), url, launchUrl: legacy ? `${legacy}/${slug}/` : url, shutdown: { type: 'tailnow' } });
        }
        this.config = config;
        this.entries = entries;
        this.error = false;
      } catch { this.error = true; }
    }
    if (this.error) throw new AppError(503, 'The app catalog is unavailable. Check the local configuration.');
    const order = this.store.snapshot.order || [];
    const entries = new Map();
    for (const slug of order) if (this.entries.has(slug)) entries.set(slug, this.entries.get(slug));
    for (const [slug, app] of this.entries) if (!entries.has(slug)) entries.set(slug, app);
    return { ...this.config, entries, state: this.store.snapshot.apps };
  }
  invalidate() { this.checkedAt = -Infinity; }
  acquire() {
    if (this.busy) throw new AppError(409, 'Another change is in progress. Please try again.');
    this.busy = true;
    return () => { this.busy = false; this.invalidate(); };
  }
  siteRoot(slug) {
    if (!validSlug(slug)) return null;
    const { deployments } = this.store.snapshot;
    if (Object.hasOwn(deployments, slug)) {
      const release = deployments[slug].release;
      return release === null ? null : path.join(this.config.dataDirectory, 'releases', slug, release);
    }
    const location = path.join(this.config.sitesDirectory, slug);
    try { return fs.lstatSync(location).isDirectory() ? location : null; } catch { return null; }
  }
  assertPublishable(slug) {
    if (!validSlug(slug)) throw new AppError(400, 'Use 1–80 letters, numbers, underscores or hyphens, and a non-reserved app name.');
    const config = this.snapshot(true);
    if (config.entries.get(slug)?.kind === 'external') throw new AppError(409, 'This name belongs to a configured external app. Choose another name.');
    if (!config.siteOrigins.has(slug)) throw new AppError(409, 'Configure a separate HTTPS origin for this app before publishing.');
    if (!config.entries.has(slug) && config.entries.size >= 500) throw new AppError(409, 'The app directory is full.');
  }
  activate(slug, release) {
    this.store.update(state => {
      setEntry(state.deployments, slug, { release });
      // Publishing a removed/stopped site is an explicit request to bring it back.
      // Keep minimized apps minimized when updating their content.
      if (state.apps[slug]?.visibility === 'removed') delete state.apps[slug];
    });
    this.invalidate();
  }
  reorder(slug, before = null) {
    const release = this.acquire();
    try {
      const { entries, state } = this.snapshot(true);
      const visibility = name => state[name]?.visibility || 'visible';
      if (!entries.has(slug)) throw new AppError(404, 'App is no longer available. Reload the directory.');
      if (visibility(slug) === 'removed') throw new AppError(409, 'Restore this app before reordering it.');
      if (before === slug) return;
      if (before !== null && (!entries.has(before) || visibility(before) !== visibility(slug))) throw new AppError(409, 'The directory changed. Reload before reordering.');
      const order = [...entries.keys()].filter(name => name !== slug);
      const last = order.findLastIndex(name => visibility(name) === visibility(slug));
      order.splice(before === null ? last + 1 : order.indexOf(before), 0, slug);
      // Retain positions for temporarily undiscovered apps and their future restores.
      for (const name of this.store.snapshot.order || []) if (!entries.has(name)) order.push(name);
      this.store.update(next => { next.order = order.slice(0, 2000); });
    } finally { release(); }
  }
  async manage(slug, operation, stopApp) {
    const release = this.acquire();
    try {
      const app = this.snapshot(true).entries.get(slug);
      const previous = Object.hasOwn(this.store.snapshot.apps, slug) ? this.store.snapshot.apps[slug] : undefined;
      if (!app) throw new AppError(404, 'App is no longer available. Reload the directory.');
      if (operation === 'shutdown' && previous?.shutdown === 'stopped') return;
      if (operation === 'shutdown' && !app.shutdown) throw new AppError(409, 'Shutdown is not configured for this app.');
      if (operation !== 'shutdown' && previous?.shutdown && previous.shutdown !== 'none') throw new AppError(409, 'Restart this service before resetting its directory state.');
      if (operation === 'minimize' && previous?.visibility === 'removed') throw new AppError(409, 'Restore this app first.');
      const record = { name: app.name, visibility: operation === 'minimize' ? 'minimized' : 'removed', shutdown: operation === 'shutdown' ? 'pending' : 'none' };
      const update = value => this.store.update(state => {
        if (value) setEntry(state.apps, slug, value); else delete state.apps[slug];
      });
      if (operation === 'restore') { update(null); return; }
      if (operation === 'shutdown' && app.kind === 'site') {
        // The same atomic commit unpublishes content and records its removal.
        // Release files and original legacy directories are retained for recovery.
        this.store.update(state => {
          setEntry(state.apps, slug, { ...record, shutdown: 'stopped' });
          setEntry(state.deployments, slug, { release: null });
        });
        return;
      }
      update(record);
      if (operation === 'shutdown') {
        try { await stopApp(app); }
        catch { update({ ...record, shutdown: 'failed' }); throw new AppError(502, 'Removed, but shutdown could not be confirmed. Open Removed to retry.'); }
        update({ ...record, shutdown: 'stopped' });
      }
    } finally { release(); }
  }
}
module.exports = { Catalog, AppError };
