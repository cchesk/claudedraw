import { bboxFor } from '../geo/project';
import type { OverpassData, OverpassElement } from './build';

/**
 * Synthetic Overpass-shaped data: a 3×4 street grid with a park, a pond and named POIs.
 * Only used behind ?demo=1 and in tests. It goes through the normal build pipeline.
 */
export function demoData(lat0: number, lng0: number, halfM: number): OverpassData {
  const b = bboxFor(lat0, lng0, halfM);
  const at = (fx: number, fy: number) => ({ lat: b.north - (b.north - b.south) * fy, lon: b.west + (b.east - b.west) * fx });
  const els: OverpassElement[] = [];
  let id = 1;
  const road = (name: string, hw: string, pts: [number, number][]) =>
    els.push({ type: 'way', id: id++, tags: { highway: hw, name }, geometry: pts.map(([x, y]) => at(x, y)) });
  const hs = [0.2, 0.5, 0.8], vs = [0.15, 0.38, 0.62, 0.85];
  // crossings share a vertex, like real OSM intersections
  ['Oak St', 'Maple St', 'Elm St'].forEach((n, i) => road(n, 'residential', [[0, hs[i]], ...vs.map((x) => [x, hs[i]] as [number, number]), [1, hs[i]]]));
  ['2nd Ave', '3rd Ave', '4th Ave', '5th Ave'].forEach((n, i) => road(n, i === 1 ? 'tertiary' : 'residential', [[vs[i], 0], ...hs.map((y) => [vs[i], y] as [number, number]), [vs[i], 1]]));
  road('Park Path', 'footway', [[0.4, 0.3], [0.6, 0.4]]);
  const poly = (tags: Record<string, string>, pts: [number, number][]) => {
    const g = pts.map(([x, y]) => at(x, y)); g.push(g[0]);
    els.push({ type: 'way', id: id++, tags, geometry: g });
  };
  poly({ leisure: 'park', name: 'Demo Park' }, [[0.4, 0.23], [0.6, 0.23], [0.6, 0.47], [0.4, 0.47]]);
  poly({ natural: 'water' }, [[0.66, 0.55], [0.82, 0.55], [0.82, 0.77], [0.66, 0.77]]);
  for (let i = 0; i < hs.length + 1; i++) for (let j = 0; j < vs.length + 1; j++) {
    const x0 = (vs[j - 1] ?? 0) + 0.04, x1 = (vs[j] ?? 1) - 0.04, y0 = (hs[i - 1] ?? 0) + 0.04, y1 = (hs[i] ?? 1) - 0.04;
    if (x1 - x0 < 0.05 || y1 - y0 < 0.05) continue;
    if ((i === 1 && j === 2) || (i === 2 && j === 3)) continue;
    poly(i === 1 && j === 1 ? { building: 'yes', 'building:levels': '8' } : { building: 'yes' }, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  }
  const node = (name: string, fx: number, fy: number, tags: Record<string, string>) => { const p = at(fx, fy); els.push({ type: 'node', id: id++, lat: p.lat, lon: p.lon, tags: { name, ...tags } }); };
  node('Clock Tower', 0.85, 0.35, { tourism: 'attraction' });
  node('Old Fountain', 0.15, 0.65, { amenity: 'fountain' });
  node('Corner Diner', 0.72, 0.85, { amenity: 'restaurant' });
  node('Public Library', 0.3, 0.92, { amenity: 'library' });
  return { elements: els };
}
