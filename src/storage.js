const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./catalog');
const { validSlug } = require('./validation');

const releasePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function usage(directory) {
  let bytes = 0, count = 0;
  const pending = [directory];
  while (pending.length) {
    const file = pending.pop(), stat = fs.lstatSync(file);
    if (++count > 250000 || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new AppError(503, 'Private storage needs administrator attention.');
    bytes += Math.max(stat.size, stat.blocks * 512);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) pending.push(path.join(file, name));
  }
  return bytes;
}

function checkCapacity(catalog, limits, statfs = fs.statfsSync) {
  const { dataDirectory, storagePolicy } = catalog.config;
  const used = usage(dataDirectory), disk = statfs(dataDirectory);
  // Reserve the entire bounded upload and extraction, including filesystem
  // blocks for tiny files/directories. A single mutation lock owns this reserve.
  const reserve = limits.uploadBytes + limits.expandedBytes + limits.entries * Math.max(disk.bsize, 4096) * 2 + 2 * 1024 ** 2;
  if (used + reserve > storagePolicy.maxBytes || disk.bavail * disk.bsize < reserve + storagePolicy.minFreeBytes) {
    throw new AppError(507, 'Not enough publishing storage. Ask an administrator to free space or adjust the storage limit.');
  }
}

function pruneReleases(catalog, onlySlug) {
  const root = path.join(catalog.config.dataDirectory, 'releases');
  if (!fs.existsSync(root)) return;
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Invalid release storage');
  for (const slug of onlySlug ? [onlySlug] : fs.readdirSync(root)) {
    if (!validSlug(slug)) continue;
    const folder = path.join(root, slug);
    if (!fs.lstatSync(folder).isDirectory()) throw new Error('Invalid app storage');
    const releases = fs.readdirSync(folder).filter(name => releasePattern.test(name)).map(name => {
      const stat = fs.lstatSync(path.join(folder, name));
      if (!stat.isDirectory()) throw new Error('Invalid release');
      return { name, time: stat.mtimeMs };
    }).sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
    const active = catalog.store.snapshot.deployments[slug]?.release;
    const keep = new Set(active ? [active] : []);
    for (const release of releases) if (keep.size < catalog.config.storagePolicy.keepReleases) keep.add(release.name);
    for (const release of releases) if (!keep.has(release.name)) fs.rmSync(path.join(folder, release.name), { recursive: true });
  }
}

module.exports = { usage, checkCapacity, pruneReleases };
