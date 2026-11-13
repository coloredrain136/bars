// GET /api/pool?hexes=a,b,c  →  community test stats per hex per carrier (last 6 months)
const C = require('./_lib/common');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return C.send(res, 405, { error: 'method' });
  if (!C.rateLimit(`pool:${C.clientIp(req)}`, 120, 10 * 60e3)) return C.send(res, 429, { error: 'Too many requests.' });
  const hexes = [...new Set(String(req.query.hexes || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean))].slice(0, 40);
  if (!hexes.length || !hexes.every(C.isValidHex)) return C.send(res, 400, { error: 'Bad hexes.' });
  if (!C.supabaseReady()) return C.send(res, 200, { stats: {} });
  try {
    const { data } = await C.sb('rpc/bars_pool_stats', { method: 'POST', body: JSON.stringify({ p_hexes: hexes }) });
    const stats = {};
    for (const r of data || []) {
      (stats[r.h3_hex] ||= {})[r.carrier] = {
        n: r.n, down: +r.down_med, up: +r.up_med, latency: +r.latency_med
      };
    }
    return C.send(res, 200, { stats }, 300);
  } catch (e) {
    console.error('pool', e.message);
    return C.send(res, 502, { error: 'Community data is unavailable right now.' });
  }
};
