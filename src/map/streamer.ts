import type { OverpassData } from './build';
import type { World } from './world';

export type Fetcher = (i: number, j: number, signal?: AbortSignal) => Promise<OverpassData>;
export type StreamStatus = 'idle' | 'loading' | 'error';

/**
 * Loads neighbouring chunks of real OSM data as the player approaches their edges, one request at a time
 * (Overpass etiquette), nearest first, with exponential back-off after failures.
 */
export class Streamer {
  status: StreamStatus = 'idle';
  private busy = false;
  private ctl: AbortController | null = null;
  private failures = new Map<string, { n: number; retryAt: number }>();
  private disposed = false;

  constructor(private world: World, private fetcher: Fetcher, private onLoaded: (i: number, j: number) => void = () => {}, private prefetchPx = 700, private now = () => Date.now()) {}

  /** distance from a point to a chunk rectangle */
  private dist(x: number, y: number, i: number, j: number) {
    const r = this.world.chunkRect(i, j);
    return Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));
  }

  /** Chunks we want loaded for a player at (x,y), nearest first. */
  wanted(x: number, y: number) {
    const c = this.world.chunkAt(x, y), out: { i: number; j: number; d: number }[] = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = c.i + di, j = c.j + dj;
      if (this.world.hasChunk(i, j)) continue;
      const d = this.dist(x, y, i, j);
      if (d <= this.prefetchPx) out.push({ i, j, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  update(x: number, y: number) {
    if (this.disposed) return;
    const want = this.wanted(x, y);
    if (!want.length && !this.busy) { this.status = 'idle'; return; }
    if (this.busy) return;
    const t = this.now();
    const next = want.find((w) => (this.failures.get(this.world.chunkKey(w.i, w.j))?.retryAt ?? 0) <= t);
    this.status = this.failures.size && !next ? 'error' : 'loading';
    if (next) void this.load(next.i, next.j);
  }

  private async load(i: number, j: number) {
    this.busy = true;
    this.status = 'loading';
    const key = this.world.chunkKey(i, j);
    const ctl = (this.ctl = new AbortController());
    try {
      const data = await this.fetcher(i, j, ctl.signal);
      if (this.disposed) return;
      this.world.ingest(data, i, j);
      this.failures.delete(key);
      this.onLoaded(i, j);
    } catch {
      if (this.disposed) return;
      const n = (this.failures.get(key)?.n ?? 0) + 1;
      this.failures.set(key, { n, retryAt: this.now() + Math.min(60000, 3000 * 2 ** (n - 1)) });
      this.status = 'error';
    } finally {
      this.busy = false;
      if (!this.disposed && this.status === 'loading') this.status = 'idle';
    }
  }

  dispose() { this.disposed = true; this.ctl?.abort(); }
}
