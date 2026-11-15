const http = require('node:http');
const { AppError } = require('./catalog');

// A configured app can call only its explicit loopback backend. No credentials,
// cookies, proxy identity headers, or upstream CORS permission cross this boundary.
async function proxyApi(req, res, proxy) {
  if (!proxy.methods.has(req.method)) throw new AppError(405, 'Method not allowed');
  const body = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new AppError(413, 'API request too large');
    body.push(chunk);
  }
  const data = Buffer.concat(body), target = new URL(proxy.target);
  const pathname = '/' + req.url.slice(proxy.prefix.length);
  const headers = { 'Content-Length': data.length };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const response = await new Promise((resolve, reject) => {
    const upstream = http.request({ hostname: target.hostname, port: target.port, path: pathname, method: req.method, headers, agent: false }, remote => {
      const chunks = []; let size = 0;
      remote.on('data', chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) return upstream.destroy(new Error('Response too large'));
        chunks.push(chunk);
      });
      remote.on('error', reject);
      remote.on('end', () => resolve({ status: remote.statusCode, type: remote.headers['content-type'], data: Buffer.concat(chunks) }));
    });
    // A wall-clock deadline also bounds a backend that trickles bytes forever.
    const deadline = setTimeout(() => upstream.destroy(new Error('API timeout')), 10000);
    const disconnected = () => upstream.destroy(new Error('Client disconnected'));
    res.once('close', disconnected);
    upstream.once('close', () => { clearTimeout(deadline); res.removeListener('close', disconnected); });
    upstream.on('error', reject); upstream.end(data);
  }).catch(() => { throw new AppError(502, 'The app API is unavailable. Please try again.'); });
  // Backend redirects cannot move requests or credentials to another service.
  if (response.status >= 300 && response.status < 400) throw new AppError(502, 'Unexpected API redirect');
  res.status(response.status).set('Cache-Control', 'no-store');
  res.type(response.type || 'application/octet-stream').send(response.data);
}

module.exports = { proxyApi };
