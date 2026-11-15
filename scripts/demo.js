// Run the real TailNow server with disposable, fictional directory data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/http');

const port = Number(process.env.PORT || 8081);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tailnow-demo-'));
const apps = [
  ['snack-lab', 'Snack Lab', 'Pizza experiments, midnight noodles, and the perfect crunch.'],
  ['side-quest', 'Side Quest', 'Tiny weekend adventures. Next up: find the city’s best dumplings.'],
  ['moon-watch', 'Moon Watch', 'Meteor showers, moon phases, and excuses to stay up late.'],
  ['the-plot-thickens', 'The Plot Thickens', 'A book club with strong opinions and suspiciously good snacks.'],
  ['plant-parenthood', 'Plant Parenthood', 'Water the fern. Rotate the monstera. Negotiate with the basil.'],
  ['pocket-arcade', 'Pocket Arcade', 'Five-minute games. Extremely unofficial household high scores.'],
  ['sourdough', 'Dough Not Disturb', 'Starter feeding notes and the quest for the perfect sourdough ear.'],
  ['movie-night', 'One More Movie', 'A watchlist for rainy nights, wild plot twists, and popcorn refills.'],
].map(([slug, name, description]) => ({ slug, name, description, url: `https://example.com/#${slug}` }));

fs.mkdirSync(path.join(directory, 'data'));
const configPath = path.join(directory, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  baseUrl: `http://127.0.0.1:${port}/`,
  allowedHosts: ['demo.example', `127.0.0.1:${port}`, `localhost:${port}`],
  sitesDirectory: path.join(directory, 'sites'),
  dataDirectory: path.join(directory, 'data'),
  serviceLabel: 'com.example.tailnow-demo',
  siteOrigins: {},
  apps,
}));
fs.writeFileSync(path.join(directory, 'data/catalog.json'), JSON.stringify({
  version: 1, deployments: {},
  apps: Object.fromEntries(apps.slice(6).map(app => [app.slug, {
    name: app.name, visibility: 'minimized', shutdown: 'none',
  }])),
}));

const server = createServer({ configPath });
server.listen(port, '127.0.0.1', () => {
  console.log(`TailNow demo: http://127.0.0.1:${port}`);
  console.log('Fictional apps; links lead to example.com. Directory controls are real.');
  console.log(`Private administrator key: ${path.join(directory, 'data/admin-token')} (read this file to sign in).`);
  console.log('Stop with Ctrl+C. Each run starts with a fresh demo layout.');
});
process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
server.once('error', error => { console.error(error.message); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
