import type { Phase } from '../geo/overpass';
import type { OverpassData } from './build';
import type { World } from './world';

export type Fetcher = (i: number, j: number, phase: Phase, signal?: AbortSignal) => Promise<OverpassData>;
export type StreamStatus = 'idle' | 'loading' | 'error';
/** closer than this to an unloaded chunk's edge: its streets jump the queue */
const URGENT_PX = 300;
interface Task { i: number; j: number; phase: Phase; d: number }

/**
 * Loads real OSM data around the player, one request at a time (Overpass etiquette), with back-off after failures.
 * Streets of a chunk come first (small, makes it walkable); its buildings/parks/footpaths follow.
 */
export class Streamer {
  status: StreamStatus = 'idle';
  private busy = false;
  private ctl: AbortController | null = null;
  private failures = new Map<string, { n: number; retryAt: number }>();
  private disposed = false;

  constructor(private world: World, private fetcher: Fetcher, private onLoaded: (i: number, j: number, phase: Phase) => void = () => {}, private prefetchPx = 800, private now = () => Date.now()) {}

  /** distance from a point to a chunk rectangle */
  private dist(x: number, y: number, i: number, j: number) {
    const r = this.world.chunkRect(i, j);
    return Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));
  }

  private nearby(x: number, y: number, keep: (i: number, j: number) => boolean) {
    const c = this.world.chunkAt(x, y), out: { i: number; j: number; d: number }[] = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = c.i + di, j = c.j + dj;
      if (!keep(i, j)) continue;
      const d = this.dist(x, y, i, j);
      if (d <= this.prefetchPx) out.push({ i, j, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** Chunks whose streets are not loaded yet but are close enough to want, nearest first. */
  wanted(x: number, y: number) { return this.nearby(x, y, (i, j) => !this.world.hasChunk(i, j)); }

  /**
   * Priority: streets of a chunk we are about to walk into (urgent) > buildings of the chunk we stand in >
   * streets of other nearby chunks > buildings of other nearby chunks. Nearest first within each group.
   */
  private next(x: number, y: number): { task: Task | null; pending: boolean } {
    const t = this.now();
    const ready = (i: number, j: number, p: Phase) => (this.failures.get(`${i},${j},${p}`)?.retryAt ?? 0) <= t;
    const roads = this.wanted(x, y);
    const det = this.nearby(x, y, (i, j) => this.world.hasChunk(i, j) && !this.world.hasDetail(i, j));
    const here = this.world.chunkAt(x, y);
    const cands: { task: Task; rank: number }[] = [];
    for (const c of roads) if (ready(c.i, c.j, 'roads')) cands.push({ task: { ...c, phase: 'roads' }, rank: c.d < URGENT_PX ? 0 : 2 });
    for (const c of det) if (ready(c.i, c.j, 'detail')) cands.push({ task: { ...c, phase: 'detail' }, rank: c.i === here.i && c.j === here.j ? 1 : 3 });
    cands.sort((a, b) => a.rank - b.rank || a.task.d - b.task.d);
    return { task: cands[0]?.task ?? null, pending: roads.length > 0 || det.length > 0 };
  }

  update(x: number, y: number) {
    if (this.disposed || this.busy) return;
    const { task, pending } = this.next(x, y);
    if (task) void this.load(task);
    else this.status = pending ? 'error' : 'idle';
  }

  private async load(t: Task) {
    this.busy = true;
    this.status = 'loading';
    const fk = `${t.i},${t.j},${t.phase}`;
    const ctl = (this.ctl = new AbortController());
    try {
      const data = await this.fetcher(t.i, t.j, t.phase, ctl.signal);
      if (this.disposed) return;
      this.world.ingest(data, t.i, t.j, t.phase);
      this.failures.delete(fk);
      this.onLoaded(t.i, t.j, t.phase);
      this.status = 'idle';
    } catch {
      if (this.disposed) return;
      const n = (this.failures.get(fk)?.n ?? 0) + 1;
      this.failures.set(fk, { n, retryAt: this.now() + Math.min(60000, 3000 * 2 ** (n - 1)) });
      this.status = 'error';
    } finally {
      this.busy = false;
    }
  }

  dispose() { this.disposed = true; this.ctl?.abort(); }
}
