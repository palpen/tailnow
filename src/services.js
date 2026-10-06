const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// HTTP input never supplies a command, label, path or user ID.
async function stopApp(app, { run = promisify(execFile), platform = process.platform, uid = process.getuid?.() } = {}) {
  const target = app.shutdown;
  if (target?.type !== 'launchAgent' || platform !== 'darwin' || !Number.isInteger(uid)) throw new Error('Shutdown unavailable');
  const service = `gui/${uid}/${target.label}`;
  const invoke = args => run('/bin/launchctl', args, { timeout: 3000, maxBuffer: 64 * 1024, encoding: 'utf8' });
  await invoke(['disable', service]);
  try { await invoke(['bootout', service]); } catch { /* Already unloaded is also a success, if verified. */ }
  try { await invoke(['print', service]); }
  catch (error) {
    if (error.code === 113 && /Could not find service/.test(error.stderr || '')) return;
    throw new Error('Could not verify shutdown');
  }
  throw new Error('Service still loaded');
}
module.exports = { stopApp };
