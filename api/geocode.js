// GET /api/geocode?q=<address>  →  US Census Geocoder (free, no key)
const C = require('./_lib/common');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return C.send(res, 405, { error: 'method' });
  if (!C.rateLimit(`geo:${C.clientIp(req)}`, 40, 10 * 60e3)) return C.send(res, 429, { error: 'Too many lookups. Try again in a few minutes.' });
  const q = String(req.query.q || '').trim();
  if (q.length < 5 || q.length > 200) return C.send(res, 400, { error: 'Enter a full street address.' });

  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(q);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`census ${r.status}`);
    const j = await r.json();
    const matches = ((j.result && j.result.addressMatches) || []).slice(0, 5).map(m => ({
      address: m.matchedAddress,
      lat: +m.coordinates.y,
      lng: +m.coordinates.x
    })).filter(m => C.inUS(m.lat, m.lng));
    if (!matches.length) return C.send(res, 404, { error: "Couldn't find that address. Try street, city, state (and ZIP)." });
    return C.send(res, 200, { matches: matches.map(m => ({ ...m, hex: C.hexFor(m.lat, m.lng) })) }, 86400);
  } catch (e) {
    console.error('geocode', e.message);
    return C.send(res, 502, { error: 'Address lookup is unavailable right now.' });
  } finally { clearTimeout(t); }
};
