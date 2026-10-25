import { API_URL, CACHE_TTL_MS, OVERPASS_URLS } from '../config';
import type { OverpassData } from '../map/build';
import type { BBox } from './project';
import { buildQuery } from '../../shared/overpassQuery.js';

export const roundCoord = (n: number) => Math.round(n * 1e4) / 1e4;
export type Phase = 'roads' | 'detail';

/** Cache by rounded origin + radius + chunk index + phase (spec §6.2). */
export const chunkCacheKey = (lat0: number, lng0: number, half: number, i: number, j: number, phase: Phase) =>
  `${roundCoord(lat0)},${roundCoord(lng0)},${half},${i},${j},${phase}`;

export { buildQuery };

// ---- IndexedDB cache (7 days) ----------------------------------------------
const DB = 'street-quest', STORE = 'overpass';
function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function cacheGet(key: string): Promise<OverpassData | null> {
  try {
    const db = await openDb();
    return await new Promise((res) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => { const v = q.result as { t: number; data: OverpassData } | undefined; res(v && Date.now() - v.t < CACHE_TTL_MS ? v.data : null); };
      q.onerror = () => res(null);
    });
  } catch { return null; }
}
export async function cachePut(key: string, data: OverpassData) {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ t: Date.now(), data }, key);
  } catch { /* cache is best-effort */ }
}

export class OverpassError extends Error {
  constructor(public kind: 'network' | 'timeout' | 'aborted', msg: string, public detail = msg) { super(msg); }
}

const inflight = new Map<string, Promise<OverpassData>>();
let lastRequestAt = 0;

const HEDGE_MS = 4000;
const PROXY_HEDGE_MS = 9000; // the proxy may be doing the (slow) upstream fetch for us; give it longer before also asking Overpass directly

async function attempt(url: string, query: string, signal: AbortSignal, proxy?: { bbox: BBox; phase: Phase }): Promise<OverpassData> {
  const host = new URL(url).host;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  const onAbort = () => ctl.abort();
  signal.addEventListener('abort', onAbort);
  try {
    // The proxy takes a plain GET (cacheable by the browser/CDN); public Overpass takes the query as a form POST.
    const r = proxy
      ? await fetch(`${url}/overpass?phase=${proxy.phase}&south=${proxy.bbox.south.toFixed(6)}&west=${proxy.bbox.west.toFixed(6)}&north=${proxy.bbox.north.toFixed(6)}&east=${proxy.bbox.east.toFixed(6)}`, { signal: ctl.signal })
      : await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
      });
    if (r.status === 429 || r.status === 504 || r.status >= 500) throw new OverpassError('timeout', `Overpass ${r.status}`, `${host} answered ${r.status}`);
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
      throw new OverpassError('network', `Overpass ${r.status}`, `${host} answered ${r.status} ${body}`);
    }
    const json = (await r.json()) as OverpassData & { remark?: string };
    if (!Array.isArray(json.elements)) throw new OverpassError('timeout', json.remark ?? 'Overpass returned no data', `${host}: ${json.remark ?? 'no elements in reply'}`);
    if (json.remark && /timed out|out of memory/i.test(json.remark) && json.elements.length === 0) throw new OverpassError('timeout', json.remark, `${host}: ${json.remark}`);
    return json;
  } catch (e) {
    if (e instanceof OverpassError) throw e;
    if (signal.aborted) throw new OverpassError('aborted', 'aborted');
    throw ctl.signal.aborted ? new OverpassError('timeout', 'Overpass timed out', `${host} did not answer in time`) : new OverpassError('network', String(e), `${host} unreachable (${e instanceof Error ? e.message : e})`);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Hedged request across the configured endpoints: start with the first; if it fails, or has not answered within
 * HEDGE_MS, also ask the next one. The first good answer wins and the others are cancelled. This cuts the long tail
 * when one public server is slow, while sending at most one extra request per few seconds.
 */
export async function fetchRemote(query: string, signal?: AbortSignal, proxy?: { bbox: BBox; phase: Phase }): Promise<OverpassData> {
  // Our proxy (shared server-side cache, polite user-agent) goes first; public servers are the hedge/fallback.
  const targets = [...(proxy && API_URL ? [API_URL] : []), ...OVERPASS_URLS];
  const wait = lastRequestAt + 1000 - Date.now(); // Overpass etiquette: never hammer
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return new Promise<OverpassData>((resolve, reject) => {
    const ctls: AbortController[] = [];
    let next = 0, active = 0, done = false, hedge: ReturnType<typeof setTimeout> | undefined;
    let lastErr = new OverpassError('network', 'No Overpass endpoint configured');
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(hedge); ctls.forEach((c) => c.abort()); signal?.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => finish(() => reject(new OverpassError('aborted', 'aborted')));
    const launch = () => {
      clearTimeout(hedge);
      if (done || next >= targets.length) return;
      const ctl = new AbortController(); ctls.push(ctl); active++;
      const target = targets[next++];
      attempt(target, query, ctl.signal, target === API_URL ? proxy : undefined)
        .then((d) => finish(() => resolve(d)))
        .catch((e: OverpassError) => {
          active--;
          if (done || ctl.signal.aborted) return;
          lastErr = e;
          if (next < targets.length) launch(); else if (active === 0) finish(() => reject(lastErr));
        });
      if (next < targets.length) hedge = setTimeout(launch, target === API_URL ? PROXY_HEDGE_MS : HEDGE_MS);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);
    launch();
  });
}

/** Cached, de-duplicated, abortable fetch of one chunk's OSM data. */
export async function fetchChunk(key: string, bbox: BBox, phase: Phase, signal?: AbortSignal): Promise<OverpassData> {
  const cached = await cacheGet(key);
  if (cached) return cached;
  let p = inflight.get(key);
  if (!p) {
    p = fetchRemote(buildQuery(bbox, phase), signal, { bbox, phase })
      .then(async (d) => { await cachePut(key, d); return d; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    return await p;
  } catch (e) {
    // The shared request may have been aborted by another caller; retry once if we were not the one who aborted.
    if (e instanceof OverpassError && e.kind === 'aborted' && !signal?.aborted) return fetchChunk(key, bbox, phase, signal);
    throw e;
  }
}

/** The free-tier proxy sleeps when idle; poke it as soon as the app opens so it is awake when the player picks a place. */
export function warmProxy() {
  if (!API_URL) return;
  try { void fetch(`${API_URL}/health`, { cache: 'no-store' }).catch(() => {}); } catch { /* best effort */ }
}
