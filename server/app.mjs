// Street Quest map proxy: a tiny, dependency-free caching front for the public Overpass API.
//   GET /overpass?phase=roads|detail&south=&west=&north=&east=   -> Overpass JSON (gzip)
//   GET /health
// Why: one shared cache for every player, a proper User-Agent, no browser CORS/rate-limit trouble, gzip, and
// hedged requests across several public Overpass servers. It only ever runs the two fixed map queries.
import http from 'node:http';
import zlib from 'node:zlib';
import { buildQuery } from '../shared/overpassQuery.js';

const DEFAULT_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const UA = 'StreetQuest/1.0 (+https://github.com/cchesk/claudedraw)';

export function createApp(opts = {}) {
  const upstreams = opts.upstreams ?? (process.env.OVERPASS_URLS ? process.env.OVERPASS_URLS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_UPSTREAMS);
  const ttlMs = opts.ttlMs ?? 7 * 24 * 3600 * 1000;
  const maxBytes = opts.maxBytes ?? 180 * 1024 * 1024;
  const hedgeMs = opts.hedgeMs ?? 5000;
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 30000;
  const minGapMs = opts.minGapMs ?? 400;
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const missesPerMinute = opts.missesPerMinute ?? 40;
  const origins = (opts.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());

  /** @type {Map<string,{buf:Buffer,t:number}>} insertion order = LRU order */
  const cache = new Map();
  let bytes = 0;
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, errors: 0, upstreamMs: [] };

  const cacheGet = (k) => {
    const e = cache.get(k);
    if (!e) return null;
    cache.delete(k); cache.set(k, e); // refresh LRU position
    return e;
  };
  const cachePut = (k, buf) => {
    const old = cache.get(k);
    if (old) bytes -= old.buf.length;
    cache.set(k, { buf, t: Date.now() }); bytes += buf.length;
    for (const [key, e] of cache) { if (bytes <= maxBytes) break; cache.delete(key); bytes -= e.buf.length; }
  };

  // ---- upstream: limited concurrency, spaced starts, hedged across servers ----
  let running = 0, lastStart = 0;
  const waiters = [];
  const acquire = async () => {
    if (running >= maxConcurrent) await new Promise((r) => waiters.push(r));
    running++;
    const wait = lastStart + minGapMs - Date.now();
    lastStart = Math.max(Date.now(), lastStart + minGapMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  const release = () => { running--; waiters.shift()?.(); };

  async function askOne(url, query, signal) {
    const host = new URL(url).host;
    const r = await fetch(url, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(upstreamTimeoutMs)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'gzip' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!r.ok) throw new Error(`${host} answered ${r.status}`);
    const text = await r.text();
    const json = JSON.parse(text);
    if (!Array.isArray(json.elements)) throw new Error(`${host}: ${json.remark ?? 'no elements in reply'}`);
    if (json.remark && /timed out|out of memory/i.test(json.remark) && json.elements.length === 0) throw new Error(`${host}: ${json.remark}`);
    return text;
  }

  function hedged(query) {
    return new Promise((resolve, reject) => {
      const ctls = []; let next = 0, active = 0, done = false, timer; let lastErr = new Error('no upstream configured');
      const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); ctls.forEach((c) => c.abort()); fn(); };
      const launch = () => {
        clearTimeout(timer);
        if (done || next >= upstreams.length) return;
        const ctl = new AbortController(); ctls.push(ctl); active++;
        askOne(upstreams[next++], query, ctl.signal).then((t) => finish(() => resolve(t))).catch((e) => {
          active--; if (done || ctl.signal.aborted) return; lastErr = e;
          if (next < upstreams.length) launch(); else if (active === 0) finish(() => reject(lastErr));
        });
        if (next < upstreams.length) timer = setTimeout(launch, hedgeMs);
      };
      launch();
    });
  }

  async function upstream(query) {
    await acquire();
    const t0 = Date.now();
    try { return await hedged(query); } finally { release(); stats.upstreamMs.push(Date.now() - t0); if (stats.upstreamMs.length > 50) stats.upstreamMs.shift(); }
  }

  // ---- request handling ----
  const missLog = new Map();
  const tooManyMisses = (ip) => {
    const now = Date.now(), l = (missLog.get(ip) ?? []).filter((t) => now - t < 60000);
    l.push(now); missLog.set(ip, l);
    if (missLog.size > 5000) missLog.clear();
    return l.length > missesPerMinute;
  };

  const cors = (req, res) => {
    const o = req.headers.origin;
    const allow = origins.includes('*') ? '*' : o && origins.includes(o) ? o : origins[0];
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-Cache, Server-Timing');
  };
  const json = (req, res, code, body) => { cors(req, res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

  function parse(u) {
    const p = u.searchParams, phase = p.get('phase');
    if (phase !== 'roads' && phase !== 'detail') return { error: 'phase must be roads or detail' };
    const n = {};
    for (const k of ['south', 'west', 'north', 'east']) {
      const v = Number(p.get(k));
      if (!p.get(k) || !Number.isFinite(v)) return { error: `bad ${k}` };
      n[k] = Math.round(v * 1e6) / 1e6;
    }
    if (n.south < -85 || n.north > 85 || n.west < -180 || n.east > 180 || n.north <= n.south || n.east <= n.west) return { error: 'bad bbox' };
    if (n.north - n.south > 0.02 || n.east - n.west > 0.03) return { error: 'bbox too large' };
    return { phase, bbox: n, key: `${phase}|${n.south},${n.west},${n.north},${n.east}` };
  }

  async function handle(req, res) {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'OPTIONS') { cors(req, res); res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' }); return res.end(); }
    if (req.method !== 'GET') return json(req, res, 405, { error: 'GET only' });
    if (u.pathname === '/health' || u.pathname === '/') {
      const ms = [...stats.upstreamMs].sort((a, b) => a - b);
      return json(req, res, 200, { ok: true, cache: { entries: cache.size, bytes }, stats: { hits: stats.hits, misses: stats.misses, errors: stats.errors, upstreamMedianMs: ms[Math.floor(ms.length / 2)] ?? null } });
    }
    if (u.pathname === '/probe') {
      // Diagnostics: how does each upstream respond right now, from this server's network?
      const probe = async (url) => {
        const t0 = Date.now(), out = { url };
        try {
          const st = await fetch(url.replace(/interpreter$/, 'status'), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
          out.status = st.status; out.statusMs = Date.now() - t0; out.statusBody = (await st.text()).slice(0, 300);
        } catch (e) { out.statusError = String(e?.cause?.code ?? e?.message ?? e); }
        const t1 = Date.now();
        try {
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'data=' + encodeURIComponent('[out:json][timeout:10];way["highway"](42.3550,-71.0660,42.3556,-71.0652);out geom;'), signal: AbortSignal.timeout(20000) });
          const t = await r.text();
          out.tinyQuery = { status: r.status, ms: Date.now() - t1, bytes: t.length, head: t.slice(0, 120) };
        } catch (e) { out.tinyQuery = { error: String(e?.cause?.code ?? e?.message ?? e), ms: Date.now() - t1 }; }
        return out;
      };
      // ?urls=a,b lets us try other mirrors without redeploying (only https Overpass-looking endpoints)
      const extra = (u.searchParams.get('urls') ?? '').split(',').filter((x) => /^https:\/\/[a-z0-9.-]*overpass[a-z0-9.-]*\/[a-z0-9/_-]*interpreter$/i.test(x)).slice(0, 8);
      return json(req, res, 200, await Promise.all((extra.length ? extra : upstreams).map(probe)));
    }
    if (u.pathname !== '/overpass') return json(req, res, 404, { error: 'not found' });
    const q = parse(u);
    if (q.error) return json(req, res, 400, { error: q.error });

    const t0 = Date.now();
    let entry = cacheGet(q.key), state = 'HIT';
    const fresh = entry && Date.now() - entry.t < ttlMs;
    if (!fresh) {
      state = 'MISS';
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
      if (!inflight.has(q.key) && tooManyMisses(ip)) return json(req, res, 429, { error: 'slow down' });
      let p = inflight.get(q.key);
      if (!p) {
        p = upstream(buildQuery(q.bbox, q.phase))
          .then((text) => { const buf = zlib.gzipSync(text, { level: 6 }); cachePut(q.key, buf); return buf; })
          .finally(() => inflight.delete(q.key));
        inflight.set(q.key, p);
      }
      try { entry = { buf: await p, t: Date.now() }; stats.misses++; } catch (e) {
        stats.errors++;
        if (entry) { state = 'STALE'; } // serve old data rather than nothing
        else return json(req, res, 502, { error: String(e?.message ?? e) });
      }
    } else stats.hits++;

    cors(req, res);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400', 'X-Cache': state, 'Server-Timing': `total;dur=${Date.now() - t0}` };
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': entry.buf.length, Vary: 'Accept-Encoding, Origin' });
      return res.end(entry.buf);
    }
    const raw = zlib.gunzipSync(entry.buf);
    res.writeHead(200, { ...headers, 'Content-Length': raw.length, Vary: 'Accept-Encoding, Origin' });
    res.end(raw);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { if (!res.headersSent) json(req, res, 500, { error: String(e?.message ?? e) }); else res.end(); });
  });
  return { server, cache, stats, get bytes() { return bytes; } };
}
