import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepPlayer } from '../../src/game/frame';
import { clearTileMemo, resetTileTemplate, tileOf, tilePointLatLng } from '../../src/geo/tiles';
import { advance, isWalkable, nearestRoadPoint, segmentsAt, stepMove } from '../../src/map/collision';
import { classifyMvtPoi, classifyMvtRoad, clipLine, decodeTile, groupRings } from '../../src/map/mvt';
import { loadMap, NotEnoughStreets } from '../../src/map/pipeline';
import { findSpawn, pickLandmarks } from '../../src/map/spawn';
import { hasEnoughStreets, World } from '../../src/map/world';
import { rng } from './helpers';

const tileBytes = (x: number, y: number) => new Uint8Array(readFileSync(new URL(`../fixtures/tiles/z14_${x}_${y}.pbf`, import.meta.url)));
const PLACES = {
  downtown: { lat: 42.357, lng: -71.062, x: 4957, y: 6060 },
  suburb: { lat: 42.4153, lng: -71.1565, x: 4953, y: 6056 },
} as const;
function worldFor(name: keyof typeof PLACES, extra: [number, number][] = []) {
  const p = PLACES[name], w = World.mercator(p.lat, p.lng);
  w.ingestTile(p.x, p.y, decodeTile(tileBytes(p.x, p.y), p.x, p.y, w.proj));
  for (const [x, y] of extra) w.ingestTile(x, y, decodeTile(tileBytes(x, y), x, y, w.proj));
  w.pickMain();
  return w;
}

describe('tile maths', () => {
  it('finds the z14 tile of a place and round-trips tile points', () => {
    expect(tileOf(42.357, -71.062)).toEqual({ x: 4957, y: 6060 });
    const nw = tilePointLatLng(4957, 6060, 0, 0), se = tilePointLatLng(4957, 6060, 4096, 4096);
    expect(nw.lat).toBeGreaterThan(se.lat); expect(nw.lng).toBeLessThan(se.lng);
    expect(tileOf(nw.lat - 1e-7, nw.lng + 1e-7)).toEqual({ x: 4957, y: 6060 });
    expect(se.lng - nw.lng).toBeCloseTo(360 / 2 ** 14, 6);
  });
  it('mercator chunks: the origin is in its tile and neighbouring tiles share an edge in world px', () => {
    const p = PLACES.downtown, w = World.mercator(p.lat, p.lng);
    expect(w.chunkAt(0, 0)).toEqual({ i: p.x, j: p.y });
    const a = w.chunkRect(p.x, p.y), b = w.chunkRect(p.x + 1, p.y), c = w.chunkRect(p.x, p.y + 1);
    expect(a.x1).toBeCloseTo(b.x0, 4); expect(a.y1).toBeCloseTo(c.y0, 4);
    expect(a.x0).toBeLessThan(0); expect(a.x1).toBeGreaterThan(0); expect(a.y0).toBeLessThan(0); expect(a.y1).toBeGreaterThan(0);
    const wide = (a.x1 - a.x0) / 2; // metres
    expect(wide).toBeGreaterThan(1500); expect(wide).toBeLessThan(2100);
  });
});

describe('road classification (spec §6.4 on OpenMapTiles attributes)', () => {
  it.each(['primary', 'secondary', 'tertiary', 'minor'])('%s is walkable', (c) => expect(classifyMvtRoad({ class: c }).kind).toBe('street'));
  it('pedestrian streets are walkable; footways, steps, cycleways, paths and tracks are drawn but never walkable', () => {
    expect(classifyMvtRoad({ class: 'path', subclass: 'pedestrian' }).kind).toBe('street');
    for (const sub of ['footway', 'steps', 'cycleway', 'path', 'corridor', 'bridleway', 'platform']) expect(classifyMvtRoad({ class: 'path', subclass: sub }).kind).toBe('path');
    expect(classifyMvtRoad({ class: 'track' }).kind).toBe('path');
  });
  it('motorways and trunks are not walkable; service only when absent or alley', () => {
    expect(classifyMvtRoad({ class: 'motorway' }).kind).toBe('other'); expect(classifyMvtRoad({ class: 'trunk' }).kind).toBe('other');
    expect(classifyMvtRoad({ class: 'service' }).kind).toBe('street');
    expect(classifyMvtRoad({ class: 'service', service: 'alley' }).kind).toBe('street');
    expect(classifyMvtRoad({ class: 'service', service: 'driveway' }).kind).not.toBe('street');
    expect(classifyMvtRoad({ class: 'service', service: 'parking_aisle' }).kind).not.toBe('street');
  });
  it('tunnels, private access and rail are excluded', () => {
    expect(classifyMvtRoad({ class: 'minor', brunnel: 'tunnel' }).kind).toBe('other');
    expect(classifyMvtRoad({ class: 'minor', access: 'private' }).kind).toBe('other');
    expect(classifyMvtRoad({ class: 'rail' }).kind).toBe('skip');
  });
  it('POIs need a name and a landmark-worthy class', () => {
    expect(classifyMvtPoi({ class: 'museum' })).toBeNull();
    expect(classifyMvtPoi({ class: 'parking', name: 'Lot' })).toBeNull();
    expect(classifyMvtPoi({ class: 'museum', name: 'MFA' })?.rarity).toBe(3);
    expect(classifyMvtPoi({ class: 'cafe', name: 'Joe' })?.rarity).toBe(0);
  });
});

describe('geometry helpers', () => {
  it('clipLine keeps only the part inside the tile and splits where a line leaves and re-enters', () => {
    const l = clipLine([{ x: -100, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 5000 }, { x: 200, y: 5000 }], 4096);
    expect(l).toHaveLength(1);
    expect(l[0][0]).toEqual({ x: 0, y: 50 }); expect(l[0][l[0].length - 1].y).toBeCloseTo(4096);
    expect(clipLine([{ x: 5000, y: 0 }, { x: 6000, y: 100 }])).toEqual([]);
    expect(clipLine([{ x: 10, y: 10 }, { x: 4090, y: 4090 }])[0]).toHaveLength(2);
  });
  it('groupRings: same winding starts a polygon, opposite winding is a hole', () => {
    const sq = (x: number, y: number, s: number, cw: boolean) => { const r = [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y }]; return cw ? r : r.slice().reverse(); };
    const g = groupRings([sq(0, 0, 100, true), sq(20, 20, 10, false), sq(300, 300, 50, true)]);
    expect(g).toHaveLength(2); expect(g[0]).toHaveLength(2); expect(g[1]).toHaveLength(1);
  });
});

describe('decoding real OpenFreeMap tiles', () => {
  const p = PLACES.downtown, w0 = World.mercator(p.lat, p.lng);
  const d = decodeTile(tileBytes(p.x, p.y), p.x, p.y, w0.proj);
  it('yields streets, footpaths, buildings, water/green and named POIs', () => {
    expect(d.roads.filter((r) => r.kind === 'street').length).toBeGreaterThan(300);
    expect(d.roads.filter((r) => r.kind === 'path').length).toBeGreaterThan(50);
    expect(d.roads.some((r) => r.kind === 'other')).toBe(true);
    expect(d.areas.filter((a) => a.kind.startsWith('building')).length).toBeGreaterThan(200);
    expect(d.areas.some((a) => a.kind === 'water')).toBe(true);
    expect(d.pois.length).toBeGreaterThan(100);
    expect(d.labels.length).toBeGreaterThan(30);
  });
  it('gives most walkable streets their real name', () => {
    const streets = d.roads.filter((r) => r.kind === 'street' && r.cls !== 'service');
    const named = streets.filter((r) => r.name);
    expect(named.length / streets.length).toBeGreaterThan(0.8);
    expect(new Set(named.map((r) => r.name)).size).toBeGreaterThan(30);
    const known = new Set(named.map((r) => r.name));
    expect([...known].some((n) => /Street|Avenue|Road|Place|Way/.test(n))).toBe(true);
  });
  it('is projected near the origin (the tile contains it) and in plausible metres', () => {
    const xs = d.roads.flatMap((r) => r.pts.map((q) => q.x));
    expect(Math.min(...xs)).toBeLessThan(0); expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(3000); // ≈1.8 km × 2 px/m
  });
  it('an empty buffer is an empty tile', () => {
    const e = decodeTile(new Uint8Array(0), 1, 1, w0.proj);
    expect(e.roads).toHaveLength(0);
  });
});

describe.each(['downtown', 'suburb'] as const)('streets-only on a real %s vector tile', (name) => {
  const w = worldFor(name);
  it('spawns on a street near the origin and has enough streets', () => {
    expect(hasEnoughStreets(w)).toBe(true);
    const s = findSpawn(w)!;
    expect(isWalkable(w, s.x, s.y)).toBe(true); expect(s.distM).toBeLessThan(300); expect(s.street.length).toBeGreaterThan(0);
  });
  it('footpaths, buildings and water are never walkable', () => {
    const c = w.chunks.get(`${PLACES[name].x},${PLACES[name].y}`)!;
    let checked = 0;
    for (const r of c.roads.filter((q) => q.kind === 'path')) {
      const m = r.pts[Math.floor(r.pts.length / 2)];
      if (segmentsAt(w, m.x, m.y).length === 0) { expect(isWalkable(w, m.x, m.y)).toBe(false); checked++; }
    }
    for (const a of c.areas.filter((q) => q.kind === 'building' || q.kind === 'water')) {
      const m = { x: (a.bbox[0] + a.bbox[2]) / 2, y: (a.bbox[1] + a.bbox[3]) / 2 };
      if (segmentsAt(w, m.x, m.y).length === 0) { expect(isWalkable(w, m.x, m.y)).toBe(false); checked++; }
    }
    expect(checked).toBeGreaterThan(20);
  });
  it('picks 3 real landmarks on reachable streets', () => {
    const s = findSpawn(w)!, l = pickLandmarks(w, s, 65, rng(3));
    expect(l).toHaveLength(3);
    for (const m of l) { expect(isWalkable(w, m.x, m.y)).toBe(true); expect(nearestRoadPoint(w, m.x, m.y, w.reachable)!.dist).toBeLessThan(1); }
    expect(l.filter((m) => m.name !== 'Hidden spot').length).toBeGreaterThan(0);
  });
  it('fuzz: 10,000 frames of random input never leave a street', () => {
    const r = rng(77), sp = findSpawn(w)!;
    const body = { x: sp.x, y: sp.y, stamina: 100, facing: 0 };
    const inp = { keys: new Set<string>(), stick: { active: false, x: 0, y: 0 }, run: false };
    let hold = 0, bad = 0, moved = 0;
    for (let f = 0; f < 10000; f++) {
      if (hold-- <= 0) {
        hold = 3 + Math.floor(r() * 60); inp.keys.clear();
        if (r() < 0.5) { for (const k of ['w', 'a', 's', 'd']) if (r() < 0.4) inp.keys.add(k); if (r() < 0.3) inp.keys.add('shift'); inp.stick.active = false; }
        else { const a = r() * Math.PI * 2, m = r(); inp.stick = { active: true, x: Math.cos(a) * m, y: Math.sin(a) * m }; inp.run = r() < 0.3; }
      }
      const px = body.x, py = body.y;
      stepPlayer(w, body, (['scout', 'courier', 'tinker'] as const)[Math.floor(f / 3500) % 3], inp, r() < 0.05 ? 0.3 : 0.004 + r() * 0.03);
      if (!isWalkable(w, body.x, body.y)) bad++;
      if (Math.hypot(body.x - px, body.y - py) > 0) moved++;
    }
    expect(bad).toBe(0); expect(moved).toBeGreaterThan(1500);
  });
});

describe('neighbouring tiles join up', () => {
  it('streets continue across the tile edge and stay one reachable network', () => {
    const single = worldFor('downtown'), both = worldFor('downtown', [[4958, 6060], [4957, 6061]]);
    expect(both.segments.length).toBeGreaterThan(single.segments.length * 1.5);
    const edge = both.chunkRect(4957, 6060).x1;
    const across = both.segments.filter((s) => Math.min(s.ax, s.bx) < edge + 2 && Math.max(s.ax, s.bx) > edge - 2 && both.reachable(s));
    expect(across.length).toBeGreaterThan(3); // roads that run through the tile edge
    const inNeighbour = both.segments.filter((s) => s.ax > edge + 50 && both.reachable(s)).length / both.segments.filter((s) => s.ax > edge + 50).length;
    expect(inNeighbour).toBeGreaterThan(0.7);
  });
  it('walking east across the boundary never leaves a street and keeps going', () => {
    const w = worldFor('downtown', [[4958, 6060]]);
    // run along the longest reachable east-west street that crosses the tile edge
    const edge = w.chunkRect(4957, 6060).x1;
    const seg = w.segments.filter((s) => w.reachable(s) && Math.abs(s.dy) < 0.2 && s.ax < edge - 100 && s.bx > edge - 100).sort((a, b) => b.len - a.len)[0];
    expect(seg).toBeTruthy();
    let x = Math.min(seg.ax, seg.bx) + 5, y = seg.ay;
    let bad = 0;
    for (let n = 0; n < 4000; n++) { const r = advance(w, x, y, 1, 0, 3); if (!r.moved) { const t = stepMove(w, x, y, 1, 0.01, 3); if (!t.moved) break; x = t.x; y = t.y; } else { x = r.x; y = r.y; } if (!isWalkable(w, x, y)) bad++; }
    expect(bad).toBe(0);
    expect(x).toBeGreaterThan(edge + 20);
  });
});

describe('loadMap with the tile server mocked', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetTileTemplate(); clearTileMemo(); });
  const mock = (tiles: Record<string, Uint8Array>) => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url.endsWith('/planet')) return new Response(JSON.stringify({ tiles: ['https://t.test/v1/{z}/{x}/{y}.pbf'] }));
      const m = /\/14\/(\d+)\/(\d+)\.pbf$/.exec(url);
      const t = m && tiles[`${m[1]}/${m[2]}`];
      return t ? new Response(t as unknown as BodyInit) : new Response(new Uint8Array(0)); // unknown tiles are empty (like open sea)
    });
    return urls;
  };
  it('loads the tile under the address first, adds neighbours only if needed, and returns a playable world', async () => {
    const urls = mock({ '4957/6060': tileBytes(4957, 6060), '4958/6060': tileBytes(4958, 6060), '4957/6061': tileBytes(4957, 6061) });
    const steps: number[] = [];
    const w = await loadMap(PLACES.downtown.lat, PLACES.downtown.lng, { demo: false, onStep: (n) => steps.push(n) });
    expect(steps).toEqual([0, 1, 2]);
    expect(urls[0]).toBe('https://tiles.openfreemap.org/planet'); expect(urls[1]).toBe('https://t.test/v1/14/4957/6060.pbf');
    expect(w.hasChunk(4957, 6060)).toBe(true);
    const s = findSpawn(w)!; expect(isWalkable(w, s.x, s.y)).toBe(true);
    expect(urls.filter((u) => u.endsWith('.pbf')).length).toBeLessThanOrEqual(9);
  });
  it('never asks for the same tile twice (preview, then game)', async () => {
    const urls = mock({ '4957/6060': tileBytes(4957, 6060), '4958/6060': tileBytes(4958, 6060), '4957/6061': tileBytes(4957, 6061) });
    await loadMap(PLACES.downtown.lat, PLACES.downtown.lng, { demo: false });
    const first = urls.filter((u) => u.endsWith('.pbf')).length;
    await loadMap(PLACES.downtown.lat, PLACES.downtown.lng, { demo: false });
    expect(urls.filter((u) => u.endsWith('.pbf')).length).toBe(first);
  });
  it('a place with no streets pulls in all neighbours, then reports not enough streets', async () => {
    const urls = mock({});
    await expect(loadMap(0.1, -30, { demo: false })).rejects.toBeInstanceOf(NotEnoughStreets);
    expect(urls.filter((u) => u.endsWith('.pbf')).length).toBe(9);
  });
  it('a sparse rural tile is still playable', async () => {
    mock({ '4896/5963': tileBytes(4896, 5963) });
    const w = await loadMap(43.9, -72.4, { demo: false });
    expect(hasEnoughStreets(w)).toBe(true);
  });
  it('reports a tile-server failure with a reason', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.endsWith('/planet') ? new Response(JSON.stringify({ tiles: ['https://t.test/{z}/{x}/{y}.pbf'] })) : new Response('x', { status: 503 })));
    await expect(loadMap(PLACES.downtown.lat, PLACES.downtown.lng, { demo: false })).rejects.toMatchObject({ kind: 'network' });
  }, 20000);
});
