const fs = require('node:fs');
const path = require('node:path');
const { readJson, validSlug, loadConfig } = require('../src/validation');

function prepare({ configPath, outputPath, adminPort = 8446, firstAppPort = 8500, siteOptions = {}, reservedPorts = [] }) {
  const old = readJson(configPath);
  if (old.siteOrigins) throw new Error('This configuration already has isolated origins');
  if (!Number.isInteger(adminPort) || adminPort < 1024 || adminPort > 65535 || !Number.isInteger(firstAppPort) || firstAppPort < 1024 || firstAppPort > 65535) throw new Error('Invalid ports');
  const original = new URL(old.baseUrl), base = new URL(old.baseUrl); base.port = String(adminPort);
  if (base.origin === original.origin) throw new Error('Use a fresh administrator origin');
  const external = new Set(old.apps.map(app => app.slug));
  const slugs = new Set(fs.readdirSync(old.sitesDirectory, { withFileTypes: true }).filter(item => item.isDirectory() && validSlug(item.name) && !external.has(item.name)).map(item => item.name));
  const statePath = path.join(old.dataDirectory, 'catalog.json');
  if (fs.existsSync(statePath)) for (const slug of Object.keys(readJson(statePath, 1024 * 1024).deployments)) slugs.add(slug);
  const used = new Set([adminPort, Number(original.port || 443), ...reservedPorts, ...old.apps.map(app => Number(new URL(app.url).port || 443))]);
  if (reservedPorts.includes(adminPort) || old.apps.some(app => new URL(app.url).origin === base.origin)) throw new Error('Administrator port is already reserved');
  const siteOrigins = Object.create(null);
  let port = firstAppPort;
  for (const slug of [...slugs].sort()) {
    while (used.has(port)) port++;
    if (port > 65535) throw new Error('No free app ports');
    const origin = new URL(original); origin.port = String(port); siteOrigins[slug] = origin.origin; used.add(port++);
  }
  const next = { ...old, baseUrl: base.href, allowedHosts: [...new Set([...old.allowedHosts, base.host])], legacyOrigins: [original.origin], siteOrigins, siteOptions,
    storage: { maxBytes: 5 * 1024 ** 3, minFreeBytes: 512 * 1024 ** 2, keepReleases: 3 } };
  fs.writeFileSync(outputPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { loadConfig(outputPath); } catch (error) { fs.unlinkSync(outputPath); throw error; }
  return next;
}

if (require.main === module) {
  try {
    const [optionsFile] = process.argv.slice(2), options = readJson(optionsFile);
    const next = prepare(options);
    console.log(`Prepared ${options.outputPath}; original configuration and data were not changed.`);
    console.log(`Administration: ${next.baseUrl}`);
    for (const [slug, origin] of Object.entries(next.siteOrigins)) console.log(`${slug}: ${origin}/${slug}/`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare };
