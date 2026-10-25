import { describe, expect, it } from 'vitest';
import { classifyHighway, classifyPoi } from '../../src/map/build';
import { hasEnoughStreets } from '../../src/map/world';
import { FIXTURES, loadFixture } from './helpers';

describe('walkable set (spec §6.4)', () => {
  it.each(['residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary', 'pedestrian'])('%s is walkable', (h) => {
    expect(classifyHighway({ highway: h })).toBe('street');
  });
  it.each(['footway', 'path', 'cycleway', 'steps', 'track', 'bridleway', 'corridor'])('%s is drawn but never walkable', (h) => {
    expect(classifyHighway({ highway: h })).toBe('path');
  });
  it.each(['motorway', 'trunk', 'motorway_link', 'trunk_link'])('%s is not walkable', (h) => {
    expect(classifyHighway({ highway: h })).toBe('other');
  });
  it('service only when absent or alley', () => {
    expect(classifyHighway({ highway: 'service' })).toBe('street');
    expect(classifyHighway({ highway: 'service', service: 'alley' })).toBe('street');
    expect(classifyHighway({ highway: 'service', service: 'driveway' })).toBe('other');
    expect(classifyHighway({ highway: 'service', service: 'parking_aisle' })).toBe('other');
  });
  it('area=yes, private/no access and tunnels are not walkable', () => {
    expect(classifyHighway({ highway: 'pedestrian', area: 'yes' })).not.toBe('street');
    expect(classifyHighway({ highway: 'residential', access: 'private' })).toBe('other');
    expect(classifyHighway({ highway: 'residential', access: 'no' })).toBe('other');
    expect(classifyHighway({ highway: 'residential', tunnel: 'yes' })).toBe('other');
  });
});

describe('POI classification', () => {
  it('needs a name and a landmark-worthy tag', () => {
    expect(classifyPoi({ amenity: 'cafe' })).toBeNull();
    expect(classifyPoi({ name: 'Bench', amenity: 'bench' })).toBeNull();
    expect(classifyPoi({ name: 'Old Church', amenity: 'place_of_worship' })?.rarity).toBe(2);
    expect(classifyPoi({ name: 'Museum', tourism: 'museum' })?.rarity).toBe(3);
  });
});

describe.each(FIXTURES)('MapModel from %s fixture', (name) => {
  const { map } = loadFixture(name);
  it('has enough streets, named ways, areas, labels and POIs', () => {
    expect(hasEnoughStreets(map)).toBe(true);
    expect(map.segments.length).toBeGreaterThan(30);
    expect(map.chunks.get('0,0')!.areas.length).toBeGreaterThan(5);
    expect(map.labels.length).toBeGreaterThan(3);
    expect(map.pois.length).toBeGreaterThan(3);
    expect(map.ways.some((w) => w.name !== 'Unnamed road')).toBe(true);
  });
  it('segments only come from walkable highway classes', () => {
    const ok = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary', 'pedestrian', 'service']);
    for (const s of map.segments) expect(ok.has(map.ways[s.way].cls)).toBe(true);
  });
  it('the reachable street network (what spawn and landmarks use) is one connected piece', () => {
    const reach = map.segments.filter(map.reachable);
    expect(reach.length).toBeGreaterThan(map.segments.length * 0.7);
    // independent check: join segments whose endpoints touch (within the 1.5px weld distance)
    const parent = reach.map((_, i) => i);
    const find = (a: number): number => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
    const ends = reach.flatMap((s, i) => [{ i, x: s.ax, y: s.ay }, { i, x: s.bx, y: s.by }]);
    ends.sort((a, b) => a.x - b.x);
    for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length && ends[b].x - ends[a].x <= 1.6; b++) {
      if (Math.hypot(ends[a].x - ends[b].x, ends[a].y - ends[b].y) <= 1.6) parent[find(ends[a].i)] = find(ends[b].i);
    }
    const sizes = new Map<number, number>();
    for (let i = 0; i < reach.length; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + reach[i].len);
    const total = [...sizes.values()].reduce((x, y) => x + y, 0);
    expect(Math.max(...sizes.values()) / total).toBeGreaterThan(0.97);
  });
});
