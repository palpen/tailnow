const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, validSlug, text } = require('./validation');

const releasePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validateState(state) {
  if (!state || state.version !== 1) throw new Error('Invalid catalog version');
  for (const key of ['apps', 'deployments']) {
    const value = state[key];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2000) throw new Error('Invalid catalog');
    for (const [slug, record] of Object.entries(value)) {
      if (!validSlug(slug) || !record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid catalog entry');
      if (key === 'apps') {
        if (!['minimized', 'removed'].includes(record.visibility) || !['none', 'pending', 'stopped', 'failed'].includes(record.shutdown)) throw new Error('Invalid app state');
        text(record.name, 120);
      } else if (record.release !== null && !releasePattern.test(record.release)) throw new Error('Invalid release');
    }
  }
  return state;
}

class StateStore {
  constructor(file) {
    this.file = file;
    try { this.state = validateState(readJson(file, 1024 * 1024)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { version: 1, apps: {}, deployments: {} };
    }
  }
  get snapshot() { return this.state; }
  // A single atomic commit updates both release selection and directory state.
  // Only one service process may own this store; all commands share its lock.
  update(change) {
    const next = structuredClone(this.state);
    change(next);
    validateState(next);
    const data = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('Catalog too large');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      this.state = next;
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

// Define own properties so names such as __proto__ remain ordinary app slugs.
const setEntry = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
module.exports = { StateStore, setEntry, validateState };
