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
          entries.set(slug, { slug, kind: 'site', name: slug.replaceAll('-', ' '), description: 'Published with TailNow', url: new URL(`${slug}/`, config.baseUrl).href, shutdown: { type: 'tailnow' } });
        }
        this.config = config;
        this.entries = entries;
        this.error = false;
      } catch { this.error = true; }
    }
    if (this.error) throw new AppError(503, 'The app catalog is unavailable. Check the local configuration.');
    return { ...this.config, entries: this.entries, state: this.store.snapshot.apps };
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
