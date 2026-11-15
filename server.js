const path = require('node:path');
const { once } = require('node:events');
const { createServer } = require('./src/http');

async function start() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 3)) throw new Error('Use patched Node 24.22.3 or newer in the 24.x series');
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (process.env.HOST && process.env.HOST !== '127.0.0.1') throw new Error('Only loopback binding is supported');
  const server = createServer({ configPath: process.env.TAILNOW_CONFIG || path.join(__dirname, 'tailnow.json') });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  console.log(`TailNow listening on 127.0.0.1:${port}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  });
  return server;
}
if (require.main === module) start().catch(() => {
  console.error('TailNow could not start; check the local configuration, files, and port.');
  process.exitCode = 1;
});
module.exports = { start, createServer };
