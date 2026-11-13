// POST /api/test  { hex, carrier, down, up, latency, version }
// Adds one anonymous speed test to the shared pool. No IP, no coordinates stored.
const C = require('./_lib/common');

const PER_IP = { limit: 6, windowMs: 30 * 60e3 }; // 6 tests / 30 min per IP
const PER_HEX_HOUR = 20;                          // hard cap per hex per hour (in the DB)

function num(v, min, max) { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return C.send(res, 405, { error: 'method' });
  let body; try { body = await C.readJson(req); } catch { return C.send(res, 400, { error: 'Bad request.' }); }

  if (body.version !== C.APP_VERSION) return C.send(res, 409, { error: 'App updated. Reload to send tests.', version: C.APP_VERSION });

  const hex = String(body.hex || '').toLowerCase();
  const carrier = String(body.carrier || '').toLowerCase();
  const down = num(body.down, 0.05, 3000);
  const up = num(body.up, 0.01, 1500);
  const latency = num(body.latency, 1, 5000);
  if (!C.isValidHex(hex)) return C.send(res, 400, { error: 'Bad location.' });
  if (!C.NETWORKS.includes(carrier)) return C.send(res, 400, { error: 'Pick your carrier first.' });
  if (down == null || up == null || latency == null) return C.send(res, 400, { error: 'That result looks off, so it was not pooled.' });
  if (up > down * 20 && down < 5) return C.send(res, 400, { error: 'That result looks off, so it was not pooled.' });

  if (!C.rateLimit(`test:${C.clientIp(req)}`, PER_IP.limit, PER_IP.windowMs)) {
    return C.send(res, 429, { error: 'You’ve sent a lot of tests. Try again in a bit.' });
  }
  if (!C.supabaseReady()) return C.send(res, 503, { error: 'Pool is not set up yet.' });

  try {
    const since = new Date(Date.now() - 3600e3).toISOString();
    const { headers } = await C.sb(`bars_tests?h3_hex=eq.${hex}&created_at=gte.${since}&select=id`, {
      method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' }
    });
    const total = parseInt(String(headers.get('content-range') || '').split('/')[1] || '0', 10);
    if (total >= PER_HEX_HOUR) return C.send(res, 429, { error: 'This area already has plenty of tests this hour. Your result was not pooled.' });

    await C.sb('bars_tests', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        h3_hex: hex, carrier,
        down_mbps: Math.round(down * 10) / 10,
        up_mbps: Math.round(up * 10) / 10,
        latency_ms: Math.round(latency)
      })
    });
    return C.send(res, 200, { ok: true });
  } catch (e) {
    console.error('test insert', e.message);
    return C.send(res, 502, { error: 'Could not save to the pool right now.' });
  }
};
