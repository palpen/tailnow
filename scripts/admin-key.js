const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { loadConfig } = require('../src/validation');
const { AdminAuth } = require('../src/auth');

try {
  const args = process.argv.slice(2), index = args.indexOf('--config');
  const configPath = index === -1 ? process.env.TAILNOW_CONFIG || path.join(__dirname, '../tailnow.json') : args[index + 1];
  const config = loadConfig(configPath);
  fs.mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const auth = new AdminAuth(config.dataDirectory);
  if (args.includes('--rotate')) {
    const temporary = auth.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, auth.file);
    } finally { fs.rmSync(temporary, { force: true }); }
    console.log('Administrator key rotated. Restart TailNow to revoke the old key and all sessions.');
  }
  if (args.includes('--show')) process.stdout.write(fs.readFileSync(auth.file));
  else console.log(`Private administrator key: ${auth.file}`);
} catch { console.error('Could not access the private administrator key. Check configuration and file permissions.'); process.exitCode = 1; }
