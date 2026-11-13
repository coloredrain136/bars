// Fallback speed-test endpoint, used only if Cloudflare's endpoints fail from the browser.
// GET /api/speed?bytes=N  → N random-ish bytes (max 4 MB, Vercel's response limit)
// POST /api/speed         → reads and discards the body (max 4 MB), returns its size
const C = require('./_lib/common');
const MAX = 4 * 1024 * 1024;
let pad = null;

module.exports = async (req, res) => {
  const ip = C.clientIp(req);
  if (!C.rateLimit(`spd:${ip}`, 60, 10 * 60e3)) return C.send(res, 429, { error: 'slow down' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const n = Math.max(0, Math.min(MAX, parseInt(req.query.bytes || '0', 10) || 0));
    if (!pad) { pad = Buffer.alloc(MAX); for (let i = 0; i < MAX; i++) pad[i] = (i * 2654435761) >>> 24; }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(n));
    return res.end(pad.subarray(0, n));
  }
  if (req.method === 'POST') {
    let size = 0;
    await new Promise(resolve => {
      req.on('data', c => { size += c.length; if (size > MAX) req.destroy(); });
      req.on('end', resolve); req.on('close', resolve); req.on('error', resolve);
    });
    return C.send(res, 200, { bytes: size });
  }
  return C.send(res, 405, { error: 'method' });
};
module.exports.config = { api: { bodyParser: false } };
