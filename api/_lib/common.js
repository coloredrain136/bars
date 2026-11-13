// Shared helpers for Bars API functions.
const h3 = require('h3-js');

const APP_VERSION = 'bars-3';
const NETWORKS = ['att', 'verizon', 't-mobile'];
const H3_RES = 9;

// ---------- responses ----------
function send(res, status, body, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheSeconds ? `public, s-maxage=${cacheSeconds}, max-age=0` : 'no-store');
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function readJson(req, maxBytes = 4096) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > maxBytes) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------- simple in-memory rate limit (per warm instance) ----------
// Not bulletproof across Vercel instances, but stops casual hammering.
// The per-hex hourly cap in Supabase is the hard backstop for pooled tests.
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 5000) { for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k); }
  return b.count <= limit;
}

// ---------- H3 ----------
function isValidHex(hex) {
  return typeof hex === 'string' && /^[0-9a-f]{15}$/.test(hex) && h3.isValidCell(hex) && h3.getResolution(hex) === H3_RES;
}
function hexFor(lat, lng) { return h3.latLngToCell(lat, lng, H3_RES); }
function hexCenter(hex) { const [lat, lng] = h3.cellToLatLng(hex); return { lat, lng }; }
function inUS(lat, lng) {
  // Loose box covering the 50 states + territories.
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 13 && lat < 72 && lng > -180 && lng < -64;
}

// ---------- Supabase REST (secret key, server only) ----------
// Tolerate stray whitespace/quotes from pasting the key into Vercel.
const cleanEnv = v => String(v || '').trim().replace(/^['"]|['"]$/g, '').trim();
function sbHeaders(extra = {}) {
  const key = cleanEnv(process.env.SUPABASE_SECRET_KEY);
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key && key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`; // legacy service_role JWT
  return h;
}
async function sb(path, opts = {}) {
  const url = `${cleanEnv(process.env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${path}`;
  const r = await fetch(url, { ...opts, headers: sbHeaders(opts.headers) });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const k = cleanEnv(process.env.SUPABASE_SECRET_KEY);
    const kind = k.startsWith('sb_secret_') ? 'sb_secret' : k.startsWith('sb_publishable_') ? 'sb_publishable (wrong key type)' : k.startsWith('eyJ') ? 'legacy JWT' : 'unknown format';
    const e = new Error(`supabase ${r.status} [key: ${kind}, len ${k.length}]: ${text.slice(0, 200)}`); e.status = r.status; throw e;
  }
  return { data, headers: r.headers };
}
function supabaseReady() { return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY); }

module.exports = { APP_VERSION, NETWORKS, H3_RES, send, clientIp, readJson, rateLimit, isValidHex, hexFor, hexCenter, inUS, sb, supabaseReady };
