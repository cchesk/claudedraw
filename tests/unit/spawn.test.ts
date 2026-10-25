import { describe, expect, it } from 'vitest';
import { isWalkable, nearestRoadPoint } from '../../src/map/collision';
import { findSpawn, pickLandmarks } from '../../src/map/spawn';
import { buildMap } from '../../src/map/world';
import { demoMap, FIXTURES, loadFixture, rng } from './helpers';

describe.each(FIXTURES)('spawn and landmarks on %s', (name) => {
  const { map } = loadFixture(name);
  it('spawn snaps to a walkable street near the origin', () => {
    const s = findSpawn(map)!;
    expect(isWalkable(map, s.x, s.y)).toBe(true);
    expect(s.distM).toBeLessThan(200);
    expect(s.street.length).toBeGreaterThan(0);
  });
  it('an origin inside a park / building / water still snaps to a street', () => {
    for (const a of map.chunks.get('0,0')!.areas.filter((a) => a.kind !== 'buildingTall').slice(0, 40)) {
      const c = { x: (a.bbox[0] + a.bbox[2]) / 2, y: (a.bbox[1] + a.bbox[3]) / 2 };
      const p = nearestRoadPoint(map, c.x, c.y)!;
      expect(isWalkable(map, p.x, p.y)).toBe(true);
    }
  });
  it('picks 3 landmarks on streets, spaced ≥120 m apart and from the spawn (real POIs)', () => {
    const sp = findSpawn(map)!;
    for (let seed = 1; seed <= 5; seed++) {
      const l = pickLandmarks(map, sp, 65, rng(seed));
      expect(l).toHaveLength(3);
      for (const m of l) expect(isWalkable(map, m.x, m.y)).toBe(true);
      const real = l.filter((m) => m.name !== 'Hidden spot');
      expect(real.length).toBeGreaterThan(0);
      for (const m of real) expect(map.pois.some((p) => p.name === m.name)).toBe(true);
      for (const [i, a] of real.entries()) {
        expect(Math.hypot(a.poiX - sp.x, a.poiY - sp.y)).toBeGreaterThanOrEqual(240);
        for (const b of real.slice(i + 1)) expect(Math.hypot(a.poiX - b.poiX, a.poiY - b.poiY)).toBeGreaterThanOrEqual(240);
      }
    }
  });
});

describe('fallbacks', () => {
  it('fills with "Hidden spot" street points when there are no POIs', () => {
    const base = demoMap();
    const m = Object.assign(Object.create(Object.getPrototypeOf(base)), base, { pois: [] }) as typeof base;
    const sp = findSpawn(m)!;
    const l = pickLandmarks(m, sp, 50, rng(3));
    expect(l).toHaveLength(3);
    expect(l.every((x) => x.name === 'Hidden spot' && isWalkable(m, x.x, x.y))).toBe(true);
  });
  it('reports a far spawn when the origin is >150 m from any street', () => {
    const { data, lat, lng } = loadFixture('park');
    const m = buildMap({ elements: data.elements.filter((e) => !e.tags?.highway || e.tags.name === 'Charles Street') }, lat, lng, 250);
    const s = findSpawn(m);
    if (s) expect(s.far).toBe(s.distM > 150);
  });
});
