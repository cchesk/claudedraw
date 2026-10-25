import { BBOX_HALF_M, CACHE_TTL_MS, OVERPASS_URLS } from '../config';
import type { OverpassData } from '../map/build';
import { bboxFor } from './project';

export const roundCoord = (n: number) => Math.round(n * 1e4) / 1e4;
export const cacheKey = (lat: number, lng: number, halfM: number) => `${roundCoord(lat)},${roundCoord(lng)},${halfM}`;

/** One Overpass query for everything the map needs (spec §6.2). */
export function buildQuery(lat: number, lng: number, halfM: number): string {
  const b = bboxFor(lat, lng, halfM);
  const bb = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  return `[out:json][timeout:25];(
way["highway"](${bb});
way["building"](${bb});
way["leisure"~"^(park|garden|playground)$"](${bb});
way["landuse"~"^(grass|forest)$"](${bb});
way["natural"~"^(water|wood)$"](${bb});
way["waterway"="riverbank"](${bb});
relation["type"="multipolygon"]["natural"="water"](${bb});
relation["type"="multipolygon"]["leisure"~"^(park|garden)$"](${bb});
relation["type"="multipolygon"]["landuse"="grass"](${bb});
relation["type"="multipolygon"]["waterway"="riverbank"](${bb});
node["name"]["amenity"](${bb});
node["name"]["tourism"](${bb});
node["name"]["historic"](${bb});
node["name"]["leisure"](${bb});
way["name"]["amenity"](${bb});
way["name"]["tourism"](${bb});
way["name"]["historic"](${bb});
way["name"]["leisure"](${bb});
);out geom;`;
}

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

async function fetchRemote(query: string, signal?: AbortSignal): Promise<OverpassData> {
  let lastErr: OverpassError = new OverpassError('network', 'No Overpass endpoint configured');
  for (const url of OVERPASS_URLS) {
    if (signal?.aborted) throw new OverpassError('aborted', 'aborted');
    // Overpass etiquette: never hammer; keep requests at least 1s apart.
    const wait = lastRequestAt + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 22000);
    const host = new URL(url).host;
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (r.status === 429 || r.status === 504 || r.status >= 500) { lastErr = new OverpassError('timeout', `Overpass ${r.status}`, `${host} answered ${r.status}`); continue; }
      if (!r.ok) {
        const body = (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
        lastErr = new OverpassError('network', `Overpass ${r.status}`, `${host} answered ${r.status} ${body}`); continue;
      }
      const json = (await r.json()) as OverpassData & { remark?: string };
      if (!Array.isArray(json.elements)) { lastErr = new OverpassError('timeout', json.remark ?? 'Overpass returned no data', `${host}: ${json.remark ?? 'no elements in reply'}`); continue; }
      if (json.remark && /timed out|out of memory/i.test(json.remark) && json.elements.length === 0) { lastErr = new OverpassError('timeout', json.remark, `${host}: ${json.remark}`); continue; }
      return json;
    } catch (e) {
      if (signal?.aborted) throw new OverpassError('aborted', 'aborted');
      lastErr = ctl.signal.aborted ? new OverpassError('timeout', 'Overpass timed out', `${host} did not answer in time`) : new OverpassError('network', String(e), `${host} unreachable (${e instanceof Error ? e.message : e})`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

/** Cached, de-duplicated, abortable fetch of the OSM data around a point. */
export async function fetchOsm(lat: number, lng: number, halfM = BBOX_HALF_M, signal?: AbortSignal): Promise<OverpassData> {
  const key = cacheKey(lat, lng, halfM);
  const cached = await cacheGet(key);
  if (cached) return cached;
  let p = inflight.get(key);
  if (!p) {
    // Shared in-flight promise must not die with one caller's signal, so the network call is un-signalled when shared.
    p = fetchRemote(buildQuery(roundCoord(lat), roundCoord(lng), halfM), signal)
      .then(async (d) => { await cachePut(key, d); return d; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    return await p;
  } catch (e) {
    // The shared request may have been aborted by another caller; retry once if we were not the one who aborted.
    if (e instanceof OverpassError && e.kind === 'aborted' && !signal?.aborted) return fetchOsm(lat, lng, halfM, signal);
    throw e;
  }
}
