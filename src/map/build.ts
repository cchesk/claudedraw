import { FOOTPATH_HIGHWAYS, WALKABLE_HIGHWAYS } from '../config';
import type { Area, AreaKind, Vec } from './types';

// Pure helpers for turning Overpass elements into map features. World.ingest() (world.ts) assembles them.

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number; lon?: number;
  tags?: Record<string, string>;
  geometry?: ({ lat: number; lon: number } | null)[];
  members?: { type: string; role: string; geometry?: ({ lat: number; lon: number } | null)[] }[];
}
export interface OverpassData { elements: OverpassElement[] }

export type WalkClass = 'street' | 'path' | 'other' | 'skip';

/** Classify a highway way against the walkable set (spec §6.4). Exported for tests. */
export function classifyHighway(tags: Record<string, string>): WalkClass {
  const hw = tags.highway;
  if (!hw) return 'skip';
  if (['proposed', 'construction', 'razed', 'abandoned', 'platform', 'bus_stop'].includes(hw)) return 'skip';
  if (FOOTPATH_HIGHWAYS.has(hw)) return 'path';
  if (!WALKABLE_HIGHWAYS.has(hw)) return 'other';
  if (tags.area === 'yes') return 'path';
  if (tags.access === 'private' || tags.access === 'no') return 'other';
  if (tags.tunnel && tags.tunnel !== 'no' && tags.tunnel !== 'building_passage') return 'other';
  if (hw === 'service' && tags.service && tags.service !== 'alley') return 'other';
  return 'street';
}

export const OTHER_HW: Record<string, number> = { motorway: 20, trunk: 20, motorway_link: 12, trunk_link: 12, primary_link: 12, secondary_link: 10, tertiary_link: 10, service: 8 };

export function classifyArea(tags: Record<string, string>): AreaKind | null {
  if (tags.building && tags.building !== 'no') return Number(tags['building:levels']) >= 5 ? 'buildingTall' : 'building';
  if (tags.natural === 'water' || tags.waterway === 'riverbank') return 'water';
  if (['park', 'garden', 'playground'].includes(tags.leisure) || tags.landuse === 'grass') return 'grass';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood';
  return null;
}

const POI_AMENITY: Record<string, number> = {
  place_of_worship: 2, library: 2, fountain: 2, theatre: 2, arts_centre: 2, townhall: 2, courthouse: 2, marketplace: 2,
  university: 2, cinema: 1, community_centre: 1, college: 1, pub: 1, ice_cream: 1, cafe: 0, restaurant: 0, bar: 0, fast_food: 0,
};
const POI_TOURISM = new Set(['attraction', 'museum', 'gallery', 'artwork', 'viewpoint', 'zoo', 'aquarium', 'theme_park']);
const POI_LEISURE: Record<string, number> = { park: 2, garden: 2, nature_reserve: 2, common: 2, stadium: 2, playground: 1, dog_park: 1, sports_centre: 0 };

/** Returns {cat, rarity} for a named, landmark-worthy feature, or null. Exported for tests. */
export function classifyPoi(tags: Record<string, string>): { cat: string; rarity: number } | null {
  if (!tags.name) return null;
  if (tags.tourism && POI_TOURISM.has(tags.tourism)) return { cat: `tourism=${tags.tourism}`, rarity: 3 };
  if (tags.historic && tags.historic !== 'no') return { cat: `historic=${tags.historic}`, rarity: 3 };
  if (tags.amenity && tags.amenity in POI_AMENITY) return { cat: `amenity=${tags.amenity}`, rarity: POI_AMENITY[tags.amenity] };
  if (tags.leisure && tags.leisure in POI_LEISURE) return { cat: `leisure=${tags.leisure}`, rarity: POI_LEISURE[tags.leisure] };
  return null;
}

export type Pt = { lat: number; lon: number };
export const keyOf = (p: Pt) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
export const clean = (g?: ({ lat: number; lon: number } | null)[]) => (g ?? []).filter((p): p is Pt => !!p && Number.isFinite(p.lat));

export class UnionFind {
  parent = new Map<string, string>();
  find(a: string): string {
    let r = a;
    while ((this.parent.get(r) ?? r) !== r) r = this.parent.get(r)!;
    let c = a;
    while (c !== r) { const n = this.parent.get(c)!; this.parent.set(c, r); c = n; }
    return r;
  }
  union(a: string, b: string) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

export function joinRings(chains: Pt[][]): Pt[][] {
  const rings: Pt[][] = [];
  const open = chains.filter((c) => c.length >= 2).map((c) => c.slice());
  while (open.length) {
    let cur = open.pop()!;
    let grew = true;
    while (grew && keyOf(cur[0]) !== keyOf(cur[cur.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        const head = keyOf(cur[0]), tail = keyOf(cur[cur.length - 1]);
        if (keyOf(o[0]) === tail) cur = cur.concat(o.slice(1));
        else if (keyOf(o[o.length - 1]) === tail) cur = cur.concat(o.slice().reverse().slice(1));
        else if (keyOf(o[o.length - 1]) === head) cur = o.concat(cur.slice(1));
        else if (keyOf(o[0]) === head) cur = o.slice().reverse().concat(cur.slice(1));
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    if (cur.length >= 3) rings.push(cur);
  }
  return rings;
}

export function ringArea(r: Vec[]) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i].x * r[j].y - r[j].x * r[i].y; }
  return Math.abs(a) / 2;
}

export function makeArea(kind: AreaKind, rings: Vec[][], key: string): Area | null {
  if (!rings.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { kind, rings, bbox: [x0, y0, x1, y1], size: ringArea(rings[0]), key };
}

/** Longest near-straight run of a polyline → label placement. */
export function bestRun(pts: Vec[]) {
  let best = { len: 0, x: 0, y: 0, angle: 0 };
  let start = 0;
  const heading = (a: Vec, b: Vec) => Math.atan2(b.y - a.y, b.x - a.x);
  const flush = (i0: number, i1: number) => {
    const a = pts[i0], b = pts[i1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // walked length along the run
    let walked = 0;
    for (let i = i0; i < i1; i++) walked += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (walked > best.len && len > 0) {
      let ang = heading(a, b);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang <= -Math.PI / 2) ang += Math.PI;
      best = { len: walked, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: ang };
    }
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const h1 = heading(pts[i - 1], pts[i]), h2 = heading(pts[i], pts[i + 1]);
    let d = Math.abs(h2 - h1); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > 0.21) { flush(start, i); start = i; }
  }
  if (pts.length > 1) flush(start, pts.length - 1);
  return best;
}

export const LABEL_CHAR_W = 8;

