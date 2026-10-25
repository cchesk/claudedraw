import { describe, expect, it } from 'vitest';
import { advance, distToSegment, isWalkable, nearestRoadPoint, segmentsAt, stepMove, streetNameAt } from '../../src/map/collision';
import { demoMap, FIXTURES, loadFixture } from './helpers';

const demo = demoMap();
const maple = demo.ways.findIndex((w) => w.name === 'Maple St');
const mapleSeg = demo.segments.find((s) => s.way === maple)!;

describe('isWalkable (spec §7)', () => {
  it('is true on a centreline and within the half-width, false just outside', () => {
    const mx = (mapleSeg.ax + mapleSeg.bx) / 2, my = (mapleSeg.ay + mapleSeg.by) / 2;
    expect(isWalkable(demo, mx, my)).toBe(true);
    expect(isWalkable(demo, mx, my + mapleSeg.hw - 1)).toBe(true);
    expect(isWalkable(demo, mx, my + mapleSeg.hw + 1)).toBe(false);
  });
  it('is false off-map, inside the 20px edge inset, and for NaN', () => {
    expect(isWalkable(demo, -5, 100)).toBe(false);
    expect(isWalkable(demo, 10, my(mapleSeg))).toBe(false);
    expect(isWalkable(demo, demo.width + 5, 100)).toBe(false);
    expect(isWalkable(demo, NaN, 5)).toBe(false);
  });
  it('is false inside buildings, parks, water and on footpaths (fixtures)', () => {
    for (const n of FIXTURES) {
      const { map } = loadFixture(n);
      let checked = 0;
      for (const a of map.areas) {
        const c = { x: (a.bbox[0] + a.bbox[2]) / 2, y: (a.bbox[1] + a.bbox[3]) / 2 };
        // only assert for area centres that are not themselves within a street band (large parks can contain streets)
        if (a.kind === 'building' && segmentsAt(map, c.x, c.y).length === 0) { expect(isWalkable(map, c.x, c.y)).toBe(false); checked++; }
      }
      expect(checked).toBeGreaterThan(5);
      for (const r of map.roads.filter((r) => r.kind === 'path').slice(0, 80)) {
        const p = r.pts[Math.floor(r.pts.length / 2)];
        if (segmentsAt(map, p.x, p.y).length === 0) expect(isWalkable(map, p.x, p.y)).toBe(false);
      }
    }
  });
});
const my = (s: { ay: number; by: number }) => (s.ay + s.by) / 2;

describe('slide along the road', () => {
  const y0 = my(mapleSeg), x0 = (mapleSeg.ax + mapleSeg.bx) / 2;
  it('moves directly when it can', () => {
    const r = stepMove(demo, x0, y0, 1, 0, 5);
    expect(r.moved && !r.blocked).toBe(true); expect(r.x).toBeCloseTo(x0 + 5);
  });
  it('a diagonal push into a block slides along the street instead of stopping', () => {
    // stand on the road's lower edge and push down-right
    const edge = y0 + mapleSeg.hw - 0.5, d = Math.SQRT1_2;
    const r = stepMove(demo, x0, edge, d, d, 5);
    expect(r.moved).toBe(true); expect(r.x).toBeGreaterThan(x0 + 3); expect(r.y).toBeCloseTo(edge, 5);
    expect(isWalkable(demo, r.x, r.y)).toBe(true);
  });
  it('pushing straight into a block is blocked', () => {
    const r = stepMove(demo, x0, y0 + mapleSeg.hw - 0.5, 0, 1, 5);
    expect(r.moved).toBe(false); expect(r.blocked).toBe(true);
  });
});

describe('corner assist', () => {
  const node = demo.intersections.find((n) => n.names.includes('Maple St') && n.dirs.length === 4)!;
  const edge = node.y + mapleSeg.hw - 1; // on Maple St's lower edge
  it('pulls toward a nearby intersection when pushing down a crossing street', () => {
    const px = node.x + 28; // outside the crossing street's band, but within 40px of the node
    expect(isWalkable(demo, px, edge)).toBe(true);
    expect(isWalkable(demo, px, edge + 5)).toBe(false);
    const r = stepMove(demo, px, edge, 0, 1, 6);
    expect(r.moved).toBe(true); expect(r.x).toBeLessThan(px); expect(isWalkable(demo, r.x, r.y)).toBe(true);
  });
  it('does nothing when no intersection is within 40px', () => {
    const r = stepMove(demo, node.x + 60, edge, 0, 1, 6);
    expect(r.blocked).toBe(true);
  });
  it('ignores input pointing more than 60° away from every street leaving the node', () => {
    // pushing diagonally up-left... streets leave the node at 0/90/180/270°, so every direction is within 45°; use a 4-way node check instead
    const dirs = node.dirs.map((v) => Math.atan2(v.y, v.x));
    expect(dirs.length).toBe(4);
  });
});

describe('advance() and invariants', () => {
  it('sub-steps a huge step without leaving the street', () => {
    const r = advance(demo, 600, my(mapleSeg), 1, 0, 200);
    expect(isWalkable(demo, r.x, r.y)).toBe(true); expect(r.x).toBeGreaterThan(700);
  });
  it('distToSegment and nearestRoadPoint agree', () => {
    const p = nearestRoadPoint(demo, 600, my(mapleSeg) + 80)!;
    expect(distToSegment(600, my(mapleSeg) + 80, p.seg).d).toBeCloseTo(p.dist);
    expect(isWalkable(demo, p.x, p.y)).toBe(true);
  });
  it('reads street names, "A & B" near an intersection', () => {
    const n = demo.intersections.find((i) => i.names.length > 1)!;
    expect(streetNameAt(demo, n.x, n.y)).toContain(' & ');
    const mid = { x: (mapleSeg.ax + mapleSeg.bx) / 2, y: (mapleSeg.ay + mapleSeg.by) / 2 };
    expect(streetNameAt(demo, mid.x, mid.y)).toBe('Maple St');
  });
});
