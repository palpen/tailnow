const fs = require('node:fs');
const path = require('node:path');

const slugPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const reserved = new Set(['api', '_tailnow', 'resume-data']);
const validSlug = value => typeof value === 'string' && slugPattern.test(value) && !reserved.has(value.toLowerCase());
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hostName(value) {
  if (typeof value !== 'string' || value.length > 260 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(value)) throw new Error('Invalid host');
  return new URL(`http://${value}`).host;
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
  const base = httpsUrl(raw.baseUrl);
  if (base.pathname !== '/' || base.search || base.hash) throw new Error('Use a root base URL');
  const allowedHosts = new Set(raw.allowedHosts.map(hostName));
  if (!allowedHosts.has(hostName(base.host))) throw new Error('Base URL must be allowed');
  if (typeof raw.serviceLabel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(raw.serviceLabel)) throw new Error('Configure the service label');
  const entries = new Map();
  for (const item of raw.apps) {
    if (!item || !validSlug(item.slug) || entries.has(item.slug)) throw new Error('Invalid or duplicate app');
    let shutdown;
    if (item.service !== undefined) {
      if (!item.service || item.service.type !== 'launchAgent' || typeof item.service.label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(item.service.label) || [raw.serviceLabel, process.env.XPC_SERVICE_NAME].includes(item.service.label)) throw new Error('Invalid service target');
      shutdown = { type: 'launchAgent', label: item.service.label };
    }
    entries.set(item.slug, { slug: item.slug, kind: 'external', name: text(item.name, 120), description: item.description ? text(item.description, 300) : '', url: httpsUrl(item.url).href, shutdown });
  }
  for (const key of ['sitesDirectory', 'dataDirectory']) if (typeof raw[key] !== 'string' || !path.isAbsolute(raw[key])) throw new Error('Absolute storage paths required');
  const sitesDirectory = path.resolve(raw.sitesDirectory), dataDirectory = path.resolve(raw.dataDirectory);
  if (dataDirectory === sitesDirectory || dataDirectory.startsWith(sitesDirectory + path.sep)) throw new Error('Private data must be outside sites');
  return { entries, baseUrl: base.href, allowedHosts, sitesDirectory, dataDirectory };
}

module.exports = { validSlug, escape, hostName, httpsUrl, text, readJson, loadConfig };
