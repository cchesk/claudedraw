import { TILEJSON_URL } from '../config';

export const TILE_Z = 14; // OpenFreeMap serves up to z14; each tile is ~1.8 km wide at mid latitudes
export const TILE_EXTENT = 4096;

export function tileOf(lat: number, lng: number, z = TILE_Z) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n),
  };
}

/** lat/lng of a point inside tile (tx,ty); (px,py) are in tile units 0..extent. */
export function tilePointLatLng(tx: number, ty: number, px: number, py: number, z = TILE_Z, extent = TILE_EXTENT) {
  const n = 2 ** z;
  return {
    lng: ((tx + px / extent) / n) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * 180) / Math.PI,
  };
}

export class TileError extends Error {
  constructor(public kind: 'network' | 'timeout' | 'aborted', msg: string, public detail = msg) { super(msg); }
}

// ---- TileJSON: the tile URL contains a weekly version, so look it up (and remember it) ----------------------------
const LS_KEY = 'street-quest:tilejson';
let template: Promise<string> | null = null;

function remembered(): string | null {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null') as { url: string; t: number } | null; return v?.url ?? null; } catch { return null; }
}
function remember(url: string) { try { localStorage.setItem(LS_KEY, JSON.stringify({ url, t: Date.now() })); } catch { /* optional */ } }

async function discover(signal?: AbortSignal): Promise<string> {
  try {
    const r = await fetch(TILEJSON_URL, { signal });
    if (!r.ok) throw new Error(`TileJSON ${r.status}`);
    const url = ((await r.json()) as { tiles?: string[] }).tiles?.[0];
    if (!url) throw new Error('TileJSON has no tiles');
    remember(url);
    return url;
  } catch (e) {
    if (signal?.aborted) throw new TileError('aborted', 'aborted');
    const old = remembered(); // an older version may still be served; better than nothing
    if (old) return old;
    throw new TileError('network', 'tile index unavailable', `could not read ${TILEJSON_URL} (${e instanceof Error ? e.message : e})`);
  }
}

export function tileTemplate(signal?: AbortSignal) { return (template ??= discover(signal).catch((e) => { template = null; throw e; })); }
export function resetTileTemplate() { template = null; }

const fill = (t: string, z: number, x: number, y: number) => t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

const memo = new Map<string, Promise<ArrayBuffer>>();

/** Fetch one vector tile (raw .pbf bytes), remembered in memory so the preview and the game never ask twice. */
export function fetchTile(tx: number, ty: number, signal?: AbortSignal, z = TILE_Z): Promise<ArrayBuffer> {
  const key = `${z}/${tx}/${ty}`;
  let p = memo.get(key);
  if (!p) {
    // a shared request must not die with one caller's signal; callers that abort simply stop waiting
    p = fetchTileNet(tx, ty, undefined, z).catch((e) => { memo.delete(key); throw e; });
    memo.set(key, p);
    if (memo.size > 64) memo.delete(memo.keys().next().value as string);
  } else { memo.delete(key); memo.set(key, p); }
  return signal ? new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new TileError('aborted', 'aborted')), { once: true }); p!.then(res, rej); }) : p;
}
export function clearTileMemo() { memo.clear(); }

async function fetchTileNet(tx: number, ty: number, signal?: AbortSignal, z = TILE_Z): Promise<ArrayBuffer> {
  let lastErr: TileError = new TileError('network', 'tile fetch failed');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new TileError('aborted', 'aborted');
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    const url = fill(await tileTemplate(signal), z, tx, ty);
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000), onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (r.status === 404 || r.status === 410) { resetTileTemplate(); try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ } lastErr = new TileError('network', 'tile version gone', `tile ${z}/${tx}/${ty} answered ${r.status}`); continue; }
      if (!r.ok) { lastErr = new TileError('network', `tile ${r.status}`, `tile server answered ${r.status}`); continue; }
      return await r.arrayBuffer();
    } catch (e) {
      if (signal?.aborted) throw new TileError('aborted', 'aborted');
      lastErr = ctl.signal.aborted ? new TileError('timeout', 'tile timed out', 'tile server did not answer in time') : new TileError('network', String(e), `tile server unreachable (${e instanceof Error ? e.message : e})`);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  throw lastErr;
}
