import {
  BOUNDS_INSET, FOOTPATH_HIGHWAYS, HALF_WIDTH, HASH_CELL, MIN_SEGMENTS, PX_PER_M, WALKABLE_HIGHWAYS,
} from '../config';
import { makeProjector, toWorld } from '../geo/project';
import type { Area, AreaKind, Intersection, Label, MapModel, Poi, Road, Segment, Vec, WayInfo } from './types';

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

const OTHER_HW: Record<string, number> = { motorway: 20, trunk: 20, motorway_link: 12, trunk_link: 12, primary_link: 12, secondary_link: 10, tertiary_link: 10, service: 8 };

function classifyArea(tags: Record<string, string>): AreaKind | null {
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

type Pt = { lat: number; lon: number };
const keyOf = (p: Pt) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
const clean = (g?: ({ lat: number; lon: number } | null)[]) => (g ?? []).filter((p): p is Pt => !!p && Number.isFinite(p.lat));

class UnionFind {
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

/** Liang–Barsky clip of a segment to a rectangle. Returns null if fully outside. */
export function clipSegment(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy] as const;
}

function joinRings(chains: Pt[][]): Pt[][] {
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

function ringArea(r: Vec[]) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i].x * r[j].y - r[j].x * r[i].y; }
  return Math.abs(a) / 2;
}

function makeArea(kind: AreaKind, rings: Vec[][]): Area | null {
  if (!rings.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { kind, rings, bbox: [x0, y0, x1, y1], size: ringArea(rings[0]) };
}

/** Longest near-straight run of a polyline → label placement. */
function bestRun(pts: Vec[]) {
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

const LABEL_CHAR_W = 8;

export function buildMap(data: OverpassData, lat0: number, lng0: number, halfM: number): MapModel {
  const proj = makeProjector(lat0, lng0, halfM, PX_PER_M);
  const size = 2 * halfM * PX_PER_M;
  const w = (p: Pt): Vec => toWorld(proj, p.lat, p.lon);

  const roads: Road[] = [];
  const ways: WayInfo[] = [];
  const streetWays: { pts: Pt[]; wayIdx: number; roadIdx: number }[] = [];
  const areas: Area[] = [];
  const pois: Poi[] = [];

  for (const el of data.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'way') {
      const pts = clean(el.geometry);
      if (pts.length < 2) continue;
      if (tags.highway) {
        const cls = classifyHighway(tags);
        if (cls === 'skip') continue;
        const wayIdx = ways.length;
        const hwv = cls === 'street' ? HALF_WIDTH[tags.highway] ?? 16 : OTHER_HW[tags.highway] ?? 10;
        ways.push({ name: tags.name || tags.ref || 'Unnamed road', cls: tags.highway, hw: hwv, nodes: [] });
        roads.push({ pts: pts.map(w), cls: tags.highway, hw: hwv, way: wayIdx, walkable: cls === 'street', kind: cls });
        if (cls === 'street') streetWays.push({ pts, wayIdx, roadIdx: roads.length - 1 });
        continue;
      }
      const kind = classifyArea(tags);
      if (kind && pts.length >= 4 && keyOf(pts[0]) === keyOf(pts[pts.length - 1])) {
        const a = makeArea(kind, [pts.slice(0, -1).map(w)]);
        if (a) areas.push(a);
      }
      const poi = classifyPoi(tags);
      if (poi) {
        const c = pts.reduce((s, p) => ({ x: s.x + w(p).x / pts.length, y: s.y + w(p).y / pts.length }), { x: 0, y: 0 });
        pois.push({ name: tags.name, x: c.x, y: c.y, ...poi });
      }
    } else if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      const poi = classifyPoi(tags);
      if (poi) { const p = w({ lat: el.lat, lon: el.lon! }); pois.push({ name: tags.name, x: p.x, y: p.y, ...poi }); }
    } else if (el.type === 'relation') {
      const kind = classifyArea(tags);
      if (!kind || kind === 'building' || kind === 'buildingTall') continue;
      const outers = joinRings((el.members ?? []).filter((m) => m.role === 'outer').map((m) => clean(m.geometry)));
      const inners = joinRings((el.members ?? []).filter((m) => m.role === 'inner').map((m) => clean(m.geometry)));
      for (const o of outers) {
        const a = makeArea(kind, [o.map(w), ...inners.map((r) => r.map(w))]);
        if (a) areas.push(a);
      }
    }
  }

  // ---- Street graph -------------------------------------------------------
  const uf = new UnionFind();
  const wayCount = new Map<string, Set<number>>();
  for (const sw of streetWays) {
    sw.pts.forEach((p, i) => {
      const k = keyOf(p);
      let s = wayCount.get(k); if (!s) wayCount.set(k, (s = new Set()));
      s.add(sw.wayIdx);
      if (i > 0) uf.union(keyOf(sw.pts[i - 1]), k);
    });
  }
  const lenByComp = new Map<string, number>();
  for (const sw of streetWays) {
    const root = uf.find(keyOf(sw.pts[0]));
    let l = 0;
    for (let i = 1; i < sw.pts.length; i++) { const a = w(sw.pts[i - 1]), b = w(sw.pts[i]); l += Math.hypot(b.x - a.x, b.y - a.y); }
    lenByComp.set(root, (lenByComp.get(root) ?? 0) + l);
  }
  let mainRoot = '', mainLen = -1;
  for (const [r, l] of lenByComp) if (l > mainLen) { mainLen = l; mainRoot = r; }

  const segments: Segment[] = [];
  const lo = BOUNDS_INSET, hiX = size - BOUNDS_INSET;
  const interAcc = new Map<string, { x: number; y: number; names: Set<string>; dirs: Vec[] }>();
  const labelCand: { text: string; pts: Vec[] }[] = [];
  for (const sw of streetWays) {
    const inMain = uf.find(keyOf(sw.pts[0])) === mainRoot;
    if (!inMain) { roads[sw.roadIdx].walkable = false; roads[sw.roadIdx].kind = 'other'; continue; }
    const info = ways[sw.wayIdx];
    const wp = sw.pts.map(w);
    for (let i = 1; i < wp.length; i++) {
      const a = wp[i - 1], b = wp[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.5) continue;
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
      // intersection bookkeeping from unclipped geometry
      for (const [pt, key, dir] of [[a, keyOf(sw.pts[i - 1]), { x: dx, y: dy }], [b, keyOf(sw.pts[i]), { x: -dx, y: -dy }]] as const) {
        if ((wayCount.get(key)?.size ?? 0) < 2) continue;
        let n = interAcc.get(key);
        if (!n) interAcc.set(key, (n = { x: pt.x, y: pt.y, names: new Set(), dirs: [] }));
        n.names.add(info.name);
        n.dirs.push(dir);
      }
      const c = clipSegment(a.x, a.y, b.x, b.y, lo, lo, hiX, hiX);
      if (!c) continue;
      const cl = Math.hypot(c[2] - c[0], c[3] - c[1]);
      if (cl < 0.5) continue;
      segments.push({ ax: c[0], ay: c[1], bx: c[2], by: c[3], hw: info.hw, dx, dy, len: cl, way: sw.wayIdx });
    }
    if (info.name !== 'Unnamed road') labelCand.push({ text: info.name, pts: wp });
  }

  const intersections: Intersection[] = [];
  for (const n of interAcc.values()) {
    if (n.x < lo || n.y < lo || n.x > hiX || n.y > hiX) continue;
    intersections.push({ x: n.x, y: n.y, names: [...n.names], dirs: n.dirs });
  }

  // ---- Labels -------------------------------------------------------------
  const labels: Label[] = [];
  const perName = new Map<string, { text: string; len: number; x: number; y: number; angle: number }[]>();
  for (const c of labelCand) {
    const run = bestRun(c.pts);
    const text = c.text.toUpperCase();
    if (run.len < 50 || text.length * LABEL_CHAR_W > run.len * 0.92) continue;
    if (run.x < 0 || run.y < 0 || run.x > size || run.y > size) continue;
    const l = perName.get(c.text) ?? []; l.push({ text, ...run }); perName.set(c.text, l);
  }
  for (const l of perName.values()) {
    l.sort((a, b) => b.len - a.len);
    const picked: typeof l = [];
    for (const c of l) { if (picked.length < 3 && picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 250)) picked.push(c); }
    for (const p of picked) labels.push({ text: p.text, x: p.x, y: p.y, angle: p.angle });
  }

  // ---- Spatial hash -------------------------------------------------------
  const cols = Math.ceil(size / HASH_CELL), rows = cols;
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  segments.forEach((s, idx) => {
    const x0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - s.hw) / HASH_CELL)), x1 = Math.min(cols - 1, Math.floor((Math.max(s.ax, s.bx) + s.hw) / HASH_CELL));
    const y0 = Math.max(0, Math.floor((Math.min(s.ay, s.by) - s.hw) / HASH_CELL)), y1 = Math.min(rows - 1, Math.floor((Math.max(s.ay, s.by) + s.hw) / HASH_CELL));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) cells[cy * cols + cx].push(idx);
  });

  const inBounds = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= size && p.y <= size;
  const originPx = toWorld(proj, lat0, lng0);
  return {
    origin: { lat: lat0, lng: lng0 }, width: size, height: size, pxPerM: PX_PER_M,
    roads, areas, labels, pois: dedupePois(pois.filter(inBounds)), segments, ways, intersections,
    hash: { cell: HASH_CELL, cols, rows, cells }, originPx,
  };
}

function dedupePois(pois: Poi[]): Poi[] {
  const out: Poi[] = [];
  for (const p of pois) if (!out.some((o) => o.name === p.name && Math.hypot(o.x - p.x, o.y - p.y) < 120)) out.push(p);
  return out;
}

/** True when the built map has enough walkable street to play (spec §5.4: at least 3 walkable street segments). */
export function hasEnoughStreets(m: MapModel) {
  return new Set(m.segments.map((s) => s.way)).size >= MIN_SEGMENTS;
}
