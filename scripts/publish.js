const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validSlug } = require('../src/validation');

async function main() {
  const [slug, archive] = process.argv.slice(2);
  if (!validSlug(slug) || !archive) throw new Error('Usage: node scripts/publish.js APP SITE.zip');
  const config = loadConfig(process.env.TAILNOW_CONFIG || path.join(__dirname, '../tailnow.json'));
  if (!config.siteOrigins.has(slug)) throw new Error('Assign the app an isolated HTTPS origin first.');
  const stat = fs.statSync(archive);
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('Use a ZIP file no larger than 100 MiB.');
  const token = fs.readFileSync(path.join(config.dataDirectory, 'admin-token'), 'utf8').trim();
  const form = new FormData(); form.append('file', new Blob([fs.readFileSync(archive)]), 'site.zip');
  const result = await fetch(new URL(`api/publish/${slug}`, config.baseUrl), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, redirect: 'error' });
  if (!result.ok) throw new Error(`Publishing failed (${result.status}). ${await result.text()}`);
  console.log((await result.json()).url);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
