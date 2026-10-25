import { describe, expect, it } from 'vitest';
import { demoChunk } from '../../src/map/demo';
import { TileCache } from '../../src/map/render';
import { World } from '../../src/map/world';

// a canvas that accepts every drawing call, so the cache logic can run without a DOM
const fakeCanvas = () => {
  const ctx: unknown = new Proxy({}, { get: (_, k) => (k === 'canvas' ? undefined : () => undefined), set: () => true });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
};

function setup(max: number) {
  const w = new World(40, -75, 400);
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) w.ingest(demoChunk(w.chunkBBox(i, j)), i, j);
  let renders = 0;
  const cache = new TileCache(w, max, () => { renders++; return fakeCanvas(); });
  return { w, cache, renders: () => renders };
}
/** what the draw loop does each frame for the visible tile window */
const frame = (cache: TileCache, x0: number, y0: number, cols: number, rows: number) => {
  const out: (HTMLCanvasElement | null)[] = [];
  for (let j = y0; j < y0 + rows; j++) for (let i = x0; i < x0 + cols; i++) {
    const need = !cache.has(i, j) || cache.isStale(i, j);
    out.push(cache.get(i, j, need));
  }
  return out;
};

describe('TileCache', () => {
  it('a full cache never evicts the tile it just drew (no draw → vanish → redraw flicker)', () => {
    const { cache } = setup(4);
    for (let n = 0; n < 4; n++) cache.get(n, 0);       // fill to the limit
    const c = cache.get(5, 0)!;                         // one more: must evict an OLD tile, not this one
    expect(cache.has(5, 0)).toBe(true);
    expect(cache.get(5, 0, false)).toBe(c);            // same canvas next frame, not null
    expect(cache.has(0, 0)).toBe(false);                // the least recently used one went
  });
  it('a visible window that fits in the cache is rendered once and then stays put while you walk', () => {
    const { cache, renders } = setup(16);
    frame(cache, 0, 0, 4, 3);                           // 12 visible tiles
    const first = renders();
    expect(first).toBe(12);
    for (let f = 0; f < 50; f++) { const tiles = frame(cache, 0, 0, 4, 3); expect(tiles.every(Boolean)).toBe(true); }
    expect(renders()).toBe(first);                      // nothing re-rendered, nothing missing
    // walk one tile east at a time for a long way: each step renders only the new column, never the old ones
    for (let step = 1; step <= 5; step++) {
      const before = renders();
      for (let f = 0; f < 3; f++) expect(frame(cache, step, 0, 4, 3).every(Boolean)).toBe(true);
      expect(renders() - before).toBe(3);                // only the newly visible column
    }
    for (let step = 4; step >= -5; step--) {              // and back again: tiles that scrolled out are re-drawn, visible ones never vanish
      for (let f = 0; f < 3; f++) expect(frame(cache, step, 0, 4, 3).every(Boolean)).toBe(true);
    }
  });
  it('tiles redraw when more chunk data arrives, and keep showing the old picture until then', () => {
    const w = new World(40, -75, 400);
    w.ingest(demoChunk(w.chunkBBox(0, 0), 'roads'), 0, 0, 'roads');
    let renders = 0;
    const cache = new TileCache(w, 16, () => { renders++; return fakeCanvas(); });
    const c = cache.get(0, 0)!;
    expect(cache.isStale(0, 0)).toBe(false);
    w.ingest(demoChunk(w.chunkBBox(0, 0), 'detail'), 0, 0, 'detail');
    expect(cache.isStale(0, 0)).toBe(true);
    expect(cache.get(0, 0, false)).toBe(c);             // still drawable while waiting for its turn
    expect(cache.get(0, 0, true)).toBe(c);              // re-rendered in place
    expect(cache.isStale(0, 0)).toBe(false); expect(renders).toBe(1);
  });
  it('a tile with no data yet is not drawn (and appears once its chunk loads)', () => {
    const w = new World(40, -75, 400);
    const cache = new TileCache(w, 8, fakeCanvas);
    expect(cache.get(0, 0)).toBeNull();
    w.ingest(demoChunk(w.chunkBBox(0, 0)), 0, 0);
    expect(cache.get(0, 0)).not.toBeNull();
  });
});
