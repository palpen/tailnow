const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, readJson } = require('../src/validation');
const { validateState } = require('../src/state-store');

// Run with both services stopped. Refuse to overwrite an existing catalog.
function importMini({ miniConfigPath, miniStatePath, configPath, sitesDirectory, dataDirectory, allowedHosts = [], serviceLabel = 'com.example.tailnow' }) {
  const legacy = readJson(miniConfigPath);
  const state = miniStatePath && fs.existsSync(miniStatePath) ? readJson(miniStatePath) : { version: 1, apps: {} };
  const catalog = validateState({ ...state, deployments: {} });
  const settings = {
    baseUrl: legacy.tailnow.url,
    allowedHosts: [...new Set([...legacy.allowedHosts.filter(host => !/^(localhost|127\.0\.0\.1):/.test(host)), ...allowedHosts])],
    sitesDirectory: path.resolve(sitesDirectory), dataDirectory: path.resolve(dataDirectory), serviceLabel, apps: legacy.apps,
  };
  if (fs.existsSync(configPath) || fs.existsSync(path.join(dataDirectory, 'catalog.json'))) throw new Error('Destination already initialized');
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { loadConfig(configPath); }
  catch (error) { fs.unlinkSync(configPath); throw error; }
  fs.writeFileSync(path.join(dataDirectory, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return settings;
}
if (require.main === module) {
  try {
    const [optionsFile] = process.argv.slice(2);
    importMini(readJson(optionsFile));
    console.log('Mini Shortcuts configuration and directory state imported.');
  } catch { console.error('Import failed; check inputs and use an empty destination.'); process.exitCode = 1; }
}
module.exports = { importMini };
