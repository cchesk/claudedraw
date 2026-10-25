import { bboxFor, type BBox } from '../geo/project';
import type { OverpassData, OverpassElement } from './build';

// Synthetic, endless Overpass-shaped street grid for ?demo=1 and tests. It goes through the normal pipeline.
// Streets sit on a fixed lat/lng lattice anchored at (40, -75), so any chunk can be generated independently
// and neighbouring chunks meet at shared boundary vertices, like real OSM.
const LAT0 = 40, LNG0 = -75, D_LAT = 0.0022, D_LNG = 0.0029;
const H_NAMES = ['Maple St', 'Oak St', 'Elm St', 'Pine St', 'Cedar St', 'Birch St'];
const ORD = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const mod = (n: number, m: number) => ((n % m) + m) % m;
const hStreet = (k: number) => H_NAMES[mod(k, H_NAMES.length)];
const vStreet = (m: number) => `${ORD(mod(m, 9) + 2)} Ave`;
const hash = (a: number, b: number, s = 0) => { let h = (a * 374761393 + b * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const hid = (...n: number[]) => Math.abs(n.reduce((a, b) => (a * 31 + b) | 0, 7)) + 1;

const POI_SETS: [string, Record<string, string>][] = [
  ['Clock Tower', { tourism: 'attraction' }], ['Old Fountain', { amenity: 'fountain' }], ['Corner Diner', { amenity: 'restaurant' }],
  ['Public Library', { amenity: 'library' }], ['St. Mark Church', { amenity: 'place_of_worship' }], ['Harbor Museum', { tourism: 'museum' }],
  ['Little Cafe', { amenity: 'cafe' }], ['War Memorial', { historic: 'memorial' }],
];

export function demoChunk(b: BBox, phase: 'all' | 'roads' | 'detail' = 'all'): OverpassData {
  const all = demoChunkAll(b);
  if (phase === 'all') return all;
  const roadsPart = (e: OverpassElement) => e.type === 'node' || (e.tags?.highway !== undefined && e.tags.highway !== 'footway');
  return { elements: all.elements.filter((e) => roadsPart(e) === (phase === 'roads')) };
}

function demoChunkAll(b: BBox): OverpassData {
  const els: OverpassElement[] = [];
  const at = (lat: number, lng: number) => ({ lat, lon: lng });
  const sig = Math.round(b.south * 1e4) * 131 + Math.round(b.west * 1e4);
  const kMin = Math.floor((LAT0 - b.north) / D_LAT) - 1, kMax = Math.ceil((LAT0 - b.south) / D_LAT) + 1;
  const mMin = Math.floor((b.west - LNG0) / D_LNG) - 1, mMax = Math.ceil((b.east - LNG0) / D_LNG) + 1;
  const lat = (k: number) => LAT0 - k * D_LAT, lng = (m: number) => LNG0 + m * D_LNG;
  const clampLat = (v: number) => Math.max(b.south, Math.min(b.north, v)), clampLng = (v: number) => Math.max(b.west, Math.min(b.east, v));

  for (let k = kMin; k <= kMax; k++) {
    if (lat(k) < b.south || lat(k) > b.north) continue;
    const pts = [at(lat(k), b.west)];
    for (let m = mMin; m <= mMax; m++) if (lng(m) > b.west && lng(m) < b.east) pts.push(at(lat(k), lng(m)));
    pts.push(at(lat(k), b.east));
    els.push({ type: 'way', id: hid(1, k, sig), tags: { highway: 'residential', name: hStreet(k) }, geometry: pts });
  }
  for (let m = mMin; m <= mMax; m++) {
    if (lng(m) < b.west || lng(m) > b.east) continue;
    const pts = [at(b.north, lng(m))];
    for (let k = kMin; k <= kMax; k++) if (lat(k) < b.north && lat(k) > b.south) pts.push(at(lat(k), lng(m)));
    pts.push(at(b.south, lng(m)));
    // north→south order so crossings are in sequence
    pts.sort((p, q) => q.lat - p.lat);
    els.push({ type: 'way', id: hid(2, m, sig), tags: { highway: mod(m, 4) === 1 ? 'tertiary' : 'residential', name: vStreet(m) }, geometry: pts });
  }
  void clampLat; void clampLng;
  // footpath through some blocks (drawn, never walkable)
  for (let k = kMin; k < kMax; k++) for (let m = mMin; m < mMax; m++) {
    const north = lat(k) - 0.0004, south = lat(k + 1) + 0.0004, west = lng(m) + 0.0005, east = lng(m + 1) - 0.0005;
    const r = hash(k, m);
    const poly = (tags: Record<string, string>, ring: [number, number][], salt: number) => {
      const g = ring.map(([la, lo]) => at(la, lo)); g.push(g[0]);
      els.push({ type: 'way', id: hid(3, k, m, salt), tags, geometry: g });
    };
    const box = (n: number, s: number, w: number, e: number): [number, number][] => [[n, w], [n, e], [s, e], [s, w]];
    if (r < 0.1) {
      poly({ leisure: 'park', name: 'Green Square' }, box(north, south, west, east), 1);
      els.push({ type: 'way', id: hid(4, k, m), tags: { highway: 'footway' }, geometry: [at(north, west), at((north + south) / 2, (west + east) / 2), at(south, east)] });
    } else if (r < 0.16) poly({ natural: 'water' }, box(north, south, west, east), 2);
    else if (r < 0.3) poly({ building: 'yes', 'building:levels': '8' }, box(north, south, west, east), 3);
    else {
      const mid = (west + east) / 2;
      poly({ building: 'yes' }, box(north, south, west, mid - 0.0002), 4);
      poly({ building: 'yes' }, box(north, south, mid + 0.0002, east), 5);
    }
    if (hash(k, m, 9) < 0.4) {
      const [name, tags] = POI_SETS[Math.floor(hash(k, m, 5) * POI_SETS.length)];
      els.push({ type: 'node', id: hid(5, k, m), lat: (north + south) / 2, lon: (west + east) / 2, tags: { name: `${name} ${mod(k * 7 + m, 90) + 10}`, ...tags } });
    }
  }
  return { elements: els };
}

/** Backwards-compatible: the grid inside a square of half-size halfM around a point. */
export function demoData(lat0: number, lng0: number, halfM: number): OverpassData {
  return demoChunk(bboxFor(lat0, lng0, halfM));
}
