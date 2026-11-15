const fs = require('node:fs');
const path = require('node:path');

const slugPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const reserved = new Set(['api', '_tailnow', 'resume-data']);
const validSlug = value => typeof value === 'string' && slugPattern.test(value) && !reserved.has(value.toLowerCase());
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hostName(value) {
  if (typeof value !== 'string' || value.length > 260 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(value)) throw new Error('Invalid host');
  // Keep an explicit port: :80 and :443 are not interchangeable origins.
  const url = new URL(`https://${value}`);
  return url.host;
}

function canonicalPath(location) {
  try { return fs.realpathSync.native(location); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(location);
    if (parent === location) throw error;
    return path.join(canonicalPath(parent), path.basename(location));
  }
}
const contains = (parent, child) => parent === child || child.startsWith(parent + path.sep);
function storagePaths(raw, configPath) {
  for (const key of ['sitesDirectory', 'dataDirectory']) {
    if (typeof raw[key] !== 'string' || !path.isAbsolute(raw[key])) throw new Error('Absolute storage paths required');
    try { if (!fs.lstatSync(raw[key]).isDirectory()) throw new Error('Storage must be a directory, not a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const sitesDirectory = canonicalPath(raw.sitesDirectory), dataDirectory = canonicalPath(raw.dataDirectory);
  if (contains(sitesDirectory, dataDirectory) || contains(dataDirectory, sitesDirectory)) throw new Error('Private and served storage must not overlap');
  if (contains(sitesDirectory, canonicalPath(configPath))) throw new Error('Configuration must be outside served storage');
  return { sitesDirectory, dataDirectory };
}

function rootUrl(value, local = false) {
  let url;
  if (local && typeof value === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/$/.test(value)) url = new URL(value);
  else url = httpsUrl(value);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Use a root HTTPS URL');
  return url;
}

function positiveInteger(value, fallback, min, max) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('Invalid storage policy');
  return number;
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid destination');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Invalid destination');
  return url;
}

function text(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('Invalid text');
  return value;
}

function readJson(file, limit = 128 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Expected regular file');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > limit) throw new Error('File too large');
    return JSON.parse(buffer.toString('utf8', 0, size));
  } finally { fs.closeSync(fd); }
}

function loadConfig(file) {
  const raw = readJson(file);
  if (!raw || !Array.isArray(raw.allowedHosts) || !raw.allowedHosts.length || raw.allowedHosts.length > 32 || !Array.isArray(raw.apps) || raw.apps.length > 500) throw new Error('Invalid config');
  const base = rootUrl(raw.baseUrl, true);
  const allowedHosts = new Set(raw.allowedHosts.map(hostName));
  if (!allowedHosts.has(hostName(base.host))) throw new Error('Base URL must be allowed');
  if (typeof raw.serviceLabel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(raw.serviceLabel)) throw new Error('Configure the service label');
  const entries = new Map(), assignedSlugs = new Set();
  for (const item of raw.apps) {
    if (!item || !validSlug(item.slug) || assignedSlugs.has(item.slug.toLowerCase())) throw new Error('Invalid or duplicate app');
    assignedSlugs.add(item.slug.toLowerCase());
    let shutdown;
    if (item.service !== undefined) {
      if (!item.service || item.service.type !== 'launchAgent' || typeof item.service.label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(item.service.label) || [raw.serviceLabel, process.env.XPC_SERVICE_NAME].includes(item.service.label)) throw new Error('Invalid service target');
      shutdown = { type: 'launchAgent', label: item.service.label };
    }
    entries.set(item.slug, { slug: item.slug, kind: 'external', name: text(item.name, 120), description: item.description ? text(item.description, 300) : '', url: httpsUrl(item.url).href, shutdown });
  }
  // Only explicitly assigned, distinct origins may serve application code.
  // An origin assignment is retained even while its app is stopped.
  if (!raw.siteOrigins || typeof raw.siteOrigins !== 'object' || Array.isArray(raw.siteOrigins) || Object.keys(raw.siteOrigins).length > 500) throw new Error('Configure isolated siteOrigins before starting');
  const siteOrigins = new Map(), originSites = new Map();
  for (const [slug, value] of Object.entries(raw.siteOrigins)) {
    if (!validSlug(slug) || assignedSlugs.has(slug.toLowerCase())) throw new Error('Invalid isolated app');
    assignedSlugs.add(slug.toLowerCase());
    const url = rootUrl(value), host = hostName(url.host);
    if (allowedHosts.has(host) || originSites.has(host) || [...entries.values()].some(app => new URL(app.url).origin === url.origin)) throw new Error('Each hosted app needs a separate origin from the directory and other apps');
    siteOrigins.set(slug, url.origin); originSites.set(host, slug);
  }
  const legacyOrigins = raw.legacyOrigins || [];
  if (!Array.isArray(legacyOrigins) || legacyOrigins.length > 16 || legacyOrigins.some(origin => {
    const url = rootUrl(origin);
    return url.origin === base.origin || !allowedHosts.has(hostName(url.host)) || originSites.has(hostName(url.host));
  })) throw new Error('Invalid legacy origins');
  const dependencies = new Map(), storageKeys = new Map(), apiProxies = new Map();
  for (const [slug, value] of Object.entries(raw.siteOptions || {})) {
    if (!siteOrigins.has(slug) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid site options');
    const deps = value.dependencies || [];
    if (!Array.isArray(deps) || deps.length > 100 || new Set(deps).size !== deps.length || deps.some(name => name === slug || !siteOrigins.has(name))) throw new Error('Invalid app dependencies');
    dependencies.set(slug, new Set(deps));
    const keys = value.storageKeys || [];
    if (!Array.isArray(keys) || keys.length > 50 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !key || key.length > 200 || key.startsWith('tailnow-'))) throw new Error('Invalid storage migration keys');
    storageKeys.set(slug, keys);
    const proxies = value.apiProxies || [];
    if (!Array.isArray(proxies) || proxies.length > 5) throw new Error('Invalid app API proxies');
    const prefixes = new Set();
    apiProxies.set(slug, proxies.map(proxy => {
      if (!proxy || !/^\/[a-zA-Z0-9_-]+\/$/.test(proxy.prefix) || ['/api/', '/_tailnow/', `/${slug}/`].includes(proxy.prefix) || prefixes.has(proxy.prefix)) throw new Error('Invalid API prefix');
      prefixes.add(proxy.prefix);
      const target = new URL(proxy.target);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('API targets must be fixed loopback HTTP origins');
      const methods = proxy.methods || ['GET', 'HEAD'];
      if (!Array.isArray(methods) || !methods.length || methods.some(method => !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))) throw new Error('Invalid API methods');
      return { prefix: proxy.prefix, target: target.origin, methods: new Set(methods) };
    }));
  }
  // A browser storage key can belong to only one isolated application.
  const assignedKeys = new Set();
  for (const keys of storageKeys.values()) for (const key of keys) {
    if (assignedKeys.has(key)) throw new Error('Browser storage keys must have one owner');
    assignedKeys.add(key);
  }
  const siteMetadata = new Map();
  if (raw.siteMetadata !== undefined) {
    if (!raw.siteMetadata || typeof raw.siteMetadata !== 'object' || Array.isArray(raw.siteMetadata) || Object.keys(raw.siteMetadata).length > 500) throw new Error('Invalid site metadata');
    for (const [slug, item] of Object.entries(raw.siteMetadata)) {
      if (!validSlug(slug) || !item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid site metadata');
      siteMetadata.set(slug, { name: text(item.name, 120), description: text(item.description, 300) });
    }
  }
  const storage = raw.storage || {};
  const storagePolicy = {
    maxBytes: positiveInteger(storage.maxBytes, 5 * 1024 ** 3, 64 * 1024 ** 2, 1024 ** 4),
    minFreeBytes: positiveInteger(storage.minFreeBytes, 512 * 1024 ** 2, 16 * 1024 ** 2, 1024 ** 4),
    keepReleases: positiveInteger(storage.keepReleases, 3, 1, 20),
  };
  return { entries, siteMetadata, baseUrl: base.href, allowedHosts, siteOrigins, originSites, legacyOrigins: legacyOrigins.map(value => new URL(value).origin), dependencies, storageKeys, apiProxies, storagePolicy, ...storagePaths(raw, file) };
}

module.exports = { validSlug, escape, hostName, httpsUrl, text, readJson, loadConfig, canonicalPath, contains };
