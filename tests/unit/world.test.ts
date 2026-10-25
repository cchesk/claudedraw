import { describe, expect, it } from 'vitest';
import { stepPlayer } from '../../src/game/frame';
import { demoChunk } from '../../src/map/demo';
import { isWalkable, streetNameAt } from '../../src/map/collision';
import { Streamer } from '../../src/map/streamer';
import { findSpawn, pickLandmarks } from '../../src/map/spawn';
import { World } from '../../src/map/world';
import { loadFixture, rng } from './helpers';

const demoWorld = () => { const w = new World(40, -75, 400); w.ingest(demoChunk(w.chunkBBox(0, 0)), 0, 0); return w; };
const demoFetch = (w: World) => async (i: number, j: number, phase: 'roads' | 'detail') => demoChunk(w.chunkBBox(i, j), phase);
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('chunk grid', () => {
  it('chunkAt/chunkRect agree and neighbouring chunk bboxes share their edge exactly', () => {
    const w = new World(42.35, -71.06, 400);
    expect(w.chunkAt(0, 0)).toEqual({ i: 0, j: 0 });
    expect(w.chunkAt(801, 0)).toEqual({ i: 1, j: 0 });
    expect(w.chunkAt(-801, -801)).toEqual({ i: -1, j: -1 });
    const a = w.chunkBBox(0, 0), b = w.chunkBBox(1, 0), c = w.chunkBBox(0, 1);
    expect(a.east).toBe(b.west);
    expect(a.south).toBe(c.north);
    expect(a.north - a.south).toBeGreaterThan(0.007);
  });
  it('every render tile lies inside exactly one chunk (tiles are half·2px/2 wide)', () => {
    for (const half of [400, 700]) {
      const w = new World(40, -75, half), T = (half * 2) / 2;
      for (let ty = -4; ty < 4; ty++) for (let tx = -4; tx < 4; tx++) {
        const e = 0.01, corners = [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]].map(([x, y]) => w.chunkAt(x * T + (x > tx ? -e : e), y * T + (y > ty ? -e : e)));
        expect(new Set(corners.map((c) => `${c.i},${c.j}`)).size).toBe(1);
      }
    }
  });
});

describe('ingesting several chunks', () => {
  it('de-duplicates ways, labels and POIs seen in two chunks, but keeps both chunks for rendering', () => {
    const { data, lat, lng, halfM } = loadFixture('downtown');
    const w = new World(lat, lng, halfM);
    w.ingest(data, 0, 0);
    const segs = w.segments.length, labels = w.labels.length, pois = w.pois.length, ways = w.ways.length;
    w.ingest(data, 1, 0);
    expect(w.chunks.size).toBe(2);
    expect([w.segments.length, w.labels.length, w.pois.length, w.ways.length]).toEqual([segs, labels, pois, ways]);
  });
  it('demo chunks join into one street network across the boundary', () => {
    const w = demoWorld();
    const before = w.segments.length;
    w.ingest(demoChunk(w.chunkBBox(1, 0)), 1, 0);
    expect(w.segments.length).toBeGreaterThan(before);
    const edge = w.chunkRect(0, 0).x1;
    // walk along Maple St (y≈0) across the chunk boundary
    expect(isWalkable(w, edge - 30, 0)).toBe(true);
    expect(isWalkable(w, edge + 30, 0)).toBe(true);
    const seg = w.segments.find((g) => w.ways[g.way].name === 'Maple St' && g.len > 400 && g.ax > edge)!; // mid-block, east of the boundary
    expect(streetNameAt(w, (seg.ax + seg.bx) / 2, (seg.ay + seg.by) / 2)).toBe('Maple St');
    // the second chunk's streets belong to the same reachable network
    expect(w.segments.filter(w.reachable).length).toBe(w.segments.length);
  });
});

describe('two-phase chunks (streets first, detail later)', () => {
  it('streets alone make a chunk playable; detail merges in later and bumps the render revision', () => {
    const w = new World(40, -75, 400);
    const roads = demoChunk(w.chunkBBox(0, 0), 'roads'), detail = demoChunk(w.chunkBBox(0, 0), 'detail');
    expect(roads.elements.some((e) => e.tags?.building)).toBe(false);
    expect(detail.elements.some((e) => e.tags?.highway && e.tags.highway !== 'footway')).toBe(false);
    const c = w.ingest(roads, 0, 0, 'roads');
    expect(w.hasChunk(0, 0)).toBe(true); expect(w.hasDetail(0, 0)).toBe(false);
    expect(c.areas.length).toBe(0);
    const rev = c.rev;
    w.ingest(detail, 0, 0, 'detail');
    expect(w.hasDetail(0, 0)).toBe(true);
    expect(c.areas.length).toBeGreaterThan(5); expect(c.rev).toBeGreaterThan(rev);
    expect(w.pois.length).toBeGreaterThan(0); // landmarks come from the streets phase
  });
  it('the chunk we stand in gets its buildings before far-away neighbours get their streets', async () => {
    const w = new World(40, -75, 400);
    w.ingest(demoChunk(w.chunkBBox(0, 0), 'roads'), 0, 0, 'roads');
    const order: string[] = [];
    const s = new Streamer(w, async (i, j, phase) => { order.push(`${i},${j},${phase}`); await flush(); return demoChunk(w.chunkBBox(i, j), phase); }, () => {}, 900, () => 0);
    s.update(0, 0);                      // centre of chunk (0,0): neighbours' edges are 800px away, so nothing is urgent
    await flush(); await flush();
    expect(order).toEqual(['0,0,detail']);
  });
  it('streamer fetches missing streets before any detail, then detail nearest-first', async () => {
    const w = new World(40, -75, 400);
    w.ingest(demoChunk(w.chunkBBox(0, 0), 'roads'), 0, 0, 'roads');
    const order: string[] = [];
    const s = new Streamer(w, async (i, j, phase) => { order.push(`${i},${j},${phase}`); await flush(); return demoChunk(w.chunkBBox(i, j), phase); }, () => {}, 900, () => 0);
    for (let n = 0; n < 12; n++) { s.update(700, 0); await flush(); await flush(); }
    expect(order[0]).toBe('1,0,roads');            // streets of the chunk we're heading into come first
    expect(order.indexOf('0,0,detail')).toBeGreaterThan(0);
    expect(order.indexOf('1,0,roads')).toBeLessThan(order.indexOf('0,0,detail'));
  });
});

describe('Streamer', () => {
  it('only asks for chunks whose edge is within the prefetch distance, nearest first', () => {
    const w = demoWorld();
    const s = new Streamer(w, demoFetch(w), () => {}, 700);
    expect(s.wanted(0, 0)).toEqual([]);                       // centre of the chunk: edges are 800px away
    const e = s.wanted(500, 0);                                 // 300px from the east edge
    expect(e[0]).toMatchObject({ i: 1, j: 0 });
    expect(e.every((c) => c.d <= 700)).toBe(true);
  });
  it('loads one chunk at a time and backs off after a failure', async () => {
    const w = demoWorld();
    let calls = 0, now = 0, fail = true, inflight = 0, maxInflight = 0;
    const s = new Streamer(w, async (i, j, phase) => {
      calls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      await flush(); inflight--;
      if (fail) throw new Error('boom');
      return demoChunk(w.chunkBBox(i, j), phase);
    }, () => {}, 700, () => now);
    s.update(700, 0); s.update(700, 0); s.update(700, 0);
    await flush(); await flush();
    expect(s.status).toBe('error');
    expect(maxInflight).toBe(1);
    const afterFail = calls;
    s.update(700, 0); await flush();
    expect(calls).toBe(afterFail + 0);                          // still backing off for 3s
    fail = false; now += 4000;
    for (let n = 0; n < 40; n++) { s.update(700, 0); await flush(); await flush(); }
    expect(w.hasChunk(1, 0)).toBe(true);
    expect(s.status).toBe('idle');
  });
});

describe('infinite world: walking far never leaves a street', () => {
  it('runs east along Maple St through several chunk boundaries, expanding as it goes', async () => {
    const w = demoWorld();
    const sp = findSpawn(w)!;
    const body = { x: sp.x, y: sp.y, stamina: 100, facing: 0 };
    const st = new Streamer(w, demoFetch(w), () => {}, 700);
    const inp = { keys: new Set(['d', 'shift']), stick: { active: false, x: 0, y: 0 }, run: false };
    let bad = 0;
    for (let f = 0; f < 3000; f++) {
      if (f % 6 === 0) st.update(body.x, body.y);
      stepPlayer(w, body, 'scout', inp, 0.016);
      if (!isWalkable(w, body.x, body.y)) bad++;
      if (f % 3 === 0) await flush();
    }
    expect(bad).toBe(0);
    expect(body.x).toBeGreaterThan(4000);
    expect(w.chunks.size).toBeGreaterThanOrEqual(4);
  });
  it('random wandering with streaming never yields a non-walkable position', async () => {
    const w = demoWorld(), r = rng(5);
    const sp = findSpawn(w)!;
    const body = { x: sp.x, y: sp.y, stamina: 100, facing: 0 };
    const st = new Streamer(w, demoFetch(w), () => {}, 700);
    const inp = { keys: new Set<string>(), stick: { active: false, x: 0, y: 0 }, run: false };
    let hold = 0, bad = 0;
    for (let f = 0; f < 6000; f++) {
      if (hold-- <= 0) {
        hold = 40 + Math.floor(r() * 200); inp.keys.clear(); inp.keys.add('shift');
        for (const k of ['w', 'a', 's', 'd']) if (r() < 0.35) inp.keys.add(k);
      }
      if (f % 6 === 0) st.update(body.x, body.y);
      stepPlayer(w, body, 'courier', inp, 0.016);
      if (!isWalkable(w, body.x, body.y)) bad++;
      if (f % 3 === 0) await flush();
    }
    expect(bad).toBe(0);
    expect(w.chunks.size).toBeGreaterThan(1);
  });
});

describe('follow-up quests', () => {
  it('picks new landmarks further out, skipping used ones, all on reachable streets', () => {
    const w = demoWorld();
    for (const [i, j] of [[1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [-1, -1], [1, -1], [-1, 1]]) w.ingest(demoChunk(w.chunkBBox(i, j)), i, j);
    const sp = findSpawn(w)!;
    const first = pickLandmarks(w, sp, 65, rng(1));
    const used = new Set(first.map((l) => l.key).filter((k): k is string => !!k));
    const next = pickLandmarks(w, { x: first[0].x, y: first[0].y }, 65, rng(2), { maxDist: 1800, exclude: used });
    expect(next.length).toBe(3);
    for (const l of next) { expect(isWalkable(w, l.x, l.y)).toBe(true); if (l.key) expect(used.has(l.key)).toBe(false); }
  });
});
