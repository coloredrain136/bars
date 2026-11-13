// GET /api/coverage?lat=..&lng=..   or   /api/coverage?hex=<h3 res 9>
// Per-carrier outdoor coverage for one H3 hex, cached in bars_coverage_cache.
const C = require('./_lib/common');

// broadbandmap.com terms: ephemeral use only, short-lived operational caching OK, no long-term storage.
const CACHE_HOURS = 24;
const VIEW = 'fcc'; // FCC carrier-reported layer (matches the "FCC Estimate" label). 'bbm' = adjusted with crowdsourced data.
const TECH_RANK = { '5G': 3, '4G': 2, '3G': 1 };

function normTech(t) {
  const s = String(t || '').toUpperCase();
  if (s.includes('5G')) return '5G';
  if (s.includes('4G') || s.includes('LTE')) return '4G';
  if (s.includes('3G')) return '3G';
  return null;
}

// Keep the best entry per network (highest tech, then strongest signal).
function normalize(raw) {
  const out = {}; for (const n of C.NETWORKS) out[n] = null;
  for (const c of (raw && raw.coverage) || []) {
    const slug = String(c.network_slug || '').toLowerCase();
    if (!C.NETWORKS.includes(slug)) continue;
    const tech = normTech(c.technology); if (!tech) continue;
    const dbm = Number.isFinite(+c.rsrp_dbm) ? +c.rsrp_dbm : null;
    const cur = out[slug];
    const better = !cur || TECH_RANK[tech] > TECH_RANK[cur.tech] ||
      (TECH_RANK[tech] === TECH_RANK[cur.tech] && (dbm ?? -999) > (cur.dbm ?? -999));
    if (better) out[slug] = { tech, dbm, level: c.signal_level || null };
  }
  return out;
}

async function fetchCoverage(hex) {
  const { lat, lng } = C.hexCenter(hex);
  const url = `https://broadbandmap.com/api/v1/location/cell?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&view=${VIEW}`;
  const headers = { Accept: 'application/json' };
  if (process.env.BARS_COVERAGE_API_KEY) headers['X-Api-Key'] = process.env.BARS_COVERAGE_API_KEY;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) { const e = new Error(`coverage ${r.status}`); e.status = r.status; throw e; }
    return normalize(await r.json());
  } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return C.send(res, 405, { error: 'method' });
  const ip = C.clientIp(req);
  if (!C.rateLimit(`cov:${ip}`, 120, 10 * 60e3)) return C.send(res, 429, { error: 'Too many lookups. Try again in a few minutes.' });

  let hex = String(req.query.hex || '').toLowerCase();
  if (!hex) {
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    if (!C.inUS(lat, lng)) return C.send(res, 400, { error: 'US locations only.' });
    hex = C.hexFor(lat, lng);
  }
  if (!C.isValidHex(hex)) return C.send(res, 400, { error: 'Bad hex.' });

  let cached = null;
  if (C.supabaseReady()) {
    try {
      const { data } = await C.sb(`bars_coverage_cache?h3_hex=eq.${hex}&select=data,fetched_at`);
      cached = data && data[0];
    } catch (e) { console.error('cache read', e.message); }
  }
  const fresh = cached && (Date.now() - new Date(cached.fetched_at).getTime()) < CACHE_HOURS * 3600e3;
  const usableStale = cached && (Date.now() - new Date(cached.fetched_at).getTime()) < 72 * 3600e3;
  if (fresh) return C.send(res, 200, { hex, carriers: cached.data, source: 'cache', fetched_at: cached.fetched_at }, 3600);

  // Uncached lookups hit the outside API: tighter per-IP and per-instance limits.
  if (!C.rateLimit(`covx:${ip}`, 30, 10 * 60e3) || !C.rateLimit('covx:global', 400, 60 * 60e3)) {
    if (usableStale) return C.send(res, 200, { hex, carriers: cached.data, source: 'stale', fetched_at: cached.fetched_at });
    return C.send(res, 429, { error: 'Coverage lookups are busy. Try again shortly.' });
  }

  try {
    const carriers = await fetchCoverage(hex);
    const fetched_at = new Date().toISOString();
    if (C.supabaseReady()) {
      try {
        await C.sb('bars_coverage_cache?on_conflict=h3_hex', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ h3_hex: hex, data: carriers, fetched_at })
        });
      } catch (e) { console.error('cache write', e.message); }
      // Keep the cache short-lived: drop anything older than 72h.
      try {
        await C.sb(`bars_coverage_cache?fetched_at=lt.${new Date(Date.now() - 72 * 3600e3).toISOString()}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      } catch (e) { console.error('cache prune', e.message); }
    }
    return C.send(res, 200, { hex, carriers, source: 'live', fetched_at }, 3600);
  } catch (e) {
    console.error('coverage fetch', e.message);
    if (usableStale) return C.send(res, 200, { hex, carriers: cached.data, source: 'stale', fetched_at: cached.fetched_at });
    const msg = e.status === 401 ? 'Coverage service key missing.' : e.status === 429 ? 'Coverage service is rate-limited right now. Try again later.' : 'Coverage service is unavailable right now.';
    return C.send(res, 502, { error: msg });
  }
};
module.exports.normalize = normalize;
