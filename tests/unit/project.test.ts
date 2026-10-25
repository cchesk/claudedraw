import { describe, expect, it } from 'vitest';
import { bboxFor, makeProjector, rawProject, toLatLng, toWorld } from '../../src/geo/project';

describe('projection', () => {
  it('puts the origin at the centre of the bbox', () => {
    const p = makeProjector(42.35, -71.06, 400);
    const o = toWorld(p, 42.35, -71.06);
    expect(o.x).toBeCloseTo(800); expect(o.y).toBeCloseTo(800);
  });
  it('north is up, east is right, 2 px per metre', () => {
    const north = rawProject(42, -71, 42.001, -71), east = rawProject(42, -71, 42, -70.999);
    expect(north.y).toBeCloseTo(-0.001 * 110540 * 2); expect(north.x).toBe(0);
    expect(east.x).toBeCloseTo(0.001 * Math.cos((42 * Math.PI) / 180) * 111320 * 2); expect(east.y).toBeCloseTo(0);
  });
  it('round-trips lat/lng', () => {
    const p = makeProjector(42.35, -71.06, 400);
    const w = toWorld(p, 42.353, -71.057);
    const b = toLatLng(p, w.x, w.y);
    expect(b.lat).toBeCloseTo(42.353, 7); expect(b.lng).toBeCloseTo(-71.057, 7);
  });
  it('an 800 m box is about 1600 px', () => {
    const b = bboxFor(42.35, -71.06, 400), p = makeProjector(42.35, -71.06, 400);
    const sw = toWorld(p, b.south, b.west), ne = toWorld(p, b.north, b.east);
    expect(ne.x - sw.x).toBeGreaterThan(1590); expect(ne.x - sw.x).toBeLessThan(1610);
    expect(sw.y - ne.y).toBeGreaterThan(1590); expect(sw.y - ne.y).toBeLessThan(1610);
  });
});
