const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync, crc32 } = require('node:zlib');
const AdmZip = require('adm-zip');

// Extraction runs off the HTTP event loop with a deadline, bounded entries,
// compressed input, and bounded decompression independent of ZIP size claims.
try {
  const { archive, destination, limits } = workerData;
  const zip = new AdmZip(archive);
  const entries = zip.getEntries();
  if (!entries.length || entries.length > limits.entries) throw new Error('Entry count');
  const names = new Set();
  let declared = 0, actual = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    const segments = name.replace(/\/$/, '').split('/');
    // Finder adds these bookkeeping entries when creating ZIPs on macOS.
    if (segments[0] === '__MACOSX' || segments.at(-1) === '.DS_Store') continue;
    const type = (entry.attr >>> 16) & 0xf000;
    if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(name) || segments.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || ![0, 0x8000, 0x4000].includes(type) || entry.header.flags & 1 || ![0, 8].includes(entry.header.method)) throw new Error('Unsafe entry');
    const normalized = segments.join('/').normalize('NFC').toLowerCase();
    if (names.has(normalized)) throw new Error('Duplicate entry');
    names.add(normalized);
    declared += entry.header.size;
    if (entry.header.size > limits.fileBytes || declared > limits.expandedBytes) throw new Error('Size limit');
    const target = path.join(destination, ...segments);
    if (entry.isDirectory) { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
    const compressed = entry.getCompressedData();
    const content = entry.header.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: limits.fileBytes });
    actual += content.length;
    if (content.length !== entry.header.size || content.length > limits.fileBytes || actual > limits.expandedBytes || crc32(content) !== entry.header.crc) throw new Error('Corrupt or oversized entry');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  }
  if (!fs.statSync(path.join(destination, 'index.html')).isFile()) throw new Error('Missing entry page');
  parentPort.postMessage({ ok: true });
} catch { parentPort.postMessage({ ok: false }); }
