// GET /api/tested  →  every community-tested hex (last 6 months) with per-carrier medians, for the map.
const C = require('./_lib/common');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return C.send(res, 405, { error: 'method' });
  if (!C.rateLimit(`tested:${C.clientIp(req)}`, 60, 10 * 60e3)) return C.send(res, 429, { error: 'Too many requests.' });
  if (!C.supabaseReady()) return C.send(res, 200, { hexes: [] });
  try {
    const { data } = await C.sb('rpc/bars_tested_hexes', { method: 'POST', body: '{}' });
    const hexes = (data || []).map(r => ({ hex: r.h3_hex, carrier: r.carrier, n: r.n, down: +r.down_med, latency: +r.latency_med }));
    return C.send(res, 200, { hexes }, 300);
  } catch (e) {
    console.error('tested', e.message);
    return C.send(res, 502, { error: 'Community map data is unavailable right now.' });
  }
};
