import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { HALF_WIDTH } from '../config';
import { TILE_EXTENT, TILE_Z, tilePointLatLng } from '../geo/tiles';
import { toWorld, type Projector } from '../geo/project';
import type { AreaKind, Vec } from './types';

/** What a decoded OpenMapTiles tile contributes to the world, already in world px. */
export interface MvtRoad { pts: Vec[]; cls: string; kind: 'street' | 'path' | 'other'; hw: number; name: string }
export interface MvtArea { kind: AreaKind; rings: Vec[][]; layer: string }
export interface MvtPoi { name: string; x: number; y: number; cat: string; rarity: number }
export interface MvtLabel { name: string; pts: Vec[] }
export interface TileData { roads: MvtRoad[]; areas: MvtArea[]; pois: MvtPoi[]; labels: MvtLabel[] }

type Props = Record<string, string | number | boolean>;
type P = { x: number; y: number };

const OTHER_HW: Record<string, number> = { motorway: 20, trunk: 20, busway: 10, raceway: 10, bus_guideway: 10 };

/** Spec §6.4 walkable set applied to OpenMapTiles `transportation` attributes. Exported for tests. */
export function classifyMvtRoad(p: Props): { kind: 'street' | 'path' | 'other' | 'skip'; hw: number; cls: string } {
  const c = String(p.class ?? ''), sub = String(p.subclass ?? ''), service = String(p.service ?? '');
  const tunnel = p.brunnel === 'tunnel', blocked = p.access === 'private' || p.access === 'no';
  if (['rail', 'transit', 'ferry', 'aerialway', 'pier', 'bridge', 'gondola', 'cable_car', 'lift', 'mountain_pass', 'ford'].includes(c)) return { kind: 'skip', hw: 0, cls: c };
  if (c in OTHER_HW) return { kind: 'other', hw: p.ramp ? 12 : OTHER_HW[c], cls: c };
  if (c === 'path' || c === 'track') {
    // highway=pedestrian (pedestrian streets) is walkable; footway/path/steps/cycleway/… are drawn thin, never walkable
    if (c === 'path' && sub === 'pedestrian' && !tunnel && !blocked) return { kind: 'street', hw: HALF_WIDTH.pedestrian, cls: 'pedestrian' };
    return { kind: 'path', hw: 2, cls: sub || c };
  }
  if (c === 'service') {
    if (service === 'driveway' || service === 'parking_aisle' || service === 'drive-through' || service === 'emergency_access') return { kind: 'path', hw: 2, cls: 'service' };
    if ((service === '' || service === 'alley') && !tunnel && !blocked) return { kind: 'street', hw: HALF_WIDTH.service, cls: 'service' };
    return { kind: 'other', hw: 8, cls: 'service' };
  }
  const hw = c === 'minor' ? HALF_WIDTH.residential : HALF_WIDTH[c];
  if (hw === undefined) return { kind: 'other', hw: 10, cls: c };
  if (tunnel || blocked) return { kind: 'other', hw: 10, cls: c };
  return { kind: 'street', hw, cls: c };
}

const POI_RARITY: Record<string, number> = {
  museum: 3, attraction: 3, monument: 3, castle: 3, zoo: 3, aquarium: 3, theme_park: 3, viewpoint: 3, ruins: 3, historic: 3, memorial: 3,
  place_of_worship: 2, library: 2, theatre: 2, town_hall: 2, courthouse: 2, marketplace: 2, university: 2, park: 2, garden: 2,
  nature_reserve: 2, stadium: 2, fountain: 2, art_gallery: 2,
  cinema: 1, college: 1, beer: 1, pub: 1, ice_cream: 1, playground: 1, dog_park: 1,
  cafe: 0, restaurant: 0, bar: 0, fast_food: 0,
};
/** Named, landmark-worthy points of interest (spec §6.6). Exported for tests. */
export function classifyMvtPoi(p: Props): { cat: string; rarity: number } | null {
  if (!p.name) return null;
  const c = String(p.class ?? ''), sub = String(p.subclass ?? '');
  const r = POI_RARITY[c] ?? POI_RARITY[sub];
  return r === undefined ? null : { cat: `${c}${sub && sub !== c ? '=' + sub : ''}`, rarity: r };
}

const LANDUSE_GREEN = new Set(['playground', 'pitch', 'recreation_ground', 'park', 'garden', 'village_green', 'grass', 'cemetery']);

/** Clip one segment to [0,ext]² (Liang–Barsky). */
function clipSeg(ax: number, ay: number, bx: number, by: number, ext: number) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay, p = [-dx, dx, -dy, dy], q = [ax, ext - ax, ay, ext - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy] as const;
}

/**
 * Keep only the part of a line inside the tile's own extent. Tiles carry a ~64-unit buffer of their neighbours' roads;
 * dropping it means every road exists exactly once and neighbouring tiles meet at the shared edge.
 */
export function clipLine(pts: readonly P[], ext = TILE_EXTENT): P[][] {
  const out: P[][] = [];
  let cur: P[] = [];
  for (let i = 1; i < pts.length; i++) {
    const c = clipSeg(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, ext);
    if (!c) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    const last = cur[cur.length - 1];
    if (!last || last.x !== c[0] || last.y !== c[1]) { if (cur.length > 1) out.push(cur); cur = [{ x: c[0], y: c[1] }]; }
    cur.push({ x: c[2], y: c[3] });
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

const ringSign = (r: readonly P[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; a += r[i].x * r[j].y - r[j].x * r[i].y; } return a; };

/** Group MVT rings into polygons: a ring winding like the first one starts a polygon, the opposite winding is a hole. */
export function groupRings(rings: readonly (readonly P[])[]): P[][][] {
  const polys: P[][][] = [];
  let outer = 0;
  for (const r of rings) {
    const a = ringSign(r);
    if (a === 0 || r.length < 3) continue;
    if (!outer) outer = Math.sign(a);
    if (Math.sign(a) === outer) polys.push([r.slice()]);
    else if (polys.length) polys[polys.length - 1].push(r.slice());
  }
  return polys;
}

/** Nearest-name lookup: transportation_name lines are matched to transportation segments by geometry. */
class NameIndex {
  private cells = new Map<number, { ax: number; ay: number; bx: number; by: number; name: string }[]>();
  private static C = 32;
  private key = (cx: number, cy: number) => (cx + 4) * 1000 + (cy + 4);
  add(name: string, pts: readonly P[]) {
    for (let i = 1; i < pts.length; i++) {
      const s = { ax: pts[i - 1].x, ay: pts[i - 1].y, bx: pts[i].x, by: pts[i].y, name };
      const x0 = Math.floor((Math.min(s.ax, s.bx) - 3) / NameIndex.C), x1 = Math.floor((Math.max(s.ax, s.bx) + 3) / NameIndex.C);
      const y0 = Math.floor((Math.min(s.ay, s.by) - 3) / NameIndex.C), y1 = Math.floor((Math.max(s.ay, s.by) + 3) / NameIndex.C);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const k = this.key(cx, cy); const l = this.cells.get(k); if (l) l.push(s); else this.cells.set(k, [s]);
      }
    }
  }
  find(x: number, y: number, tol = 3): string {
    let best = tol, name = '';
    for (const s of this.cells.get(this.key(Math.floor(x / NameIndex.C), Math.floor(y / NameIndex.C))) ?? []) {
      const vx = s.bx - s.ax, vy = s.by - s.ay, l2 = vx * vx + vy * vy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - s.ax) * vx + (y - s.ay) * vy) / l2)) : 0;
      const d = Math.hypot(x - (s.ax + t * vx), y - (s.ay + t * vy));
      if (d < best) { best = d; name = s.name; }
    }
    return name;
  }
}

const NAMED_STREET_CLASSES = new Set(['primary', 'secondary', 'tertiary', 'minor']);

/** Decode an OpenMapTiles vector tile (as served by OpenFreeMap) into world-px features. */
export function decodeTile(buf: ArrayBuffer | Uint8Array, tx: number, ty: number, proj: Projector, z = TILE_Z): TileData {
  const tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  const out: TileData = { roads: [], areas: [], pois: [], labels: [] };
  const to = (ext: number) => (p: P): Vec => {
    const ll = tilePointLatLng(tx, ty, (p.x / ext) * TILE_EXTENT, (p.y / ext) * TILE_EXTENT, z, TILE_EXTENT);
    return toWorld(proj, ll.lat, ll.lng);
  };
  const each = (layer: string, fn: (f: ReturnType<NonNullable<typeof tile.layers[string]>['feature']>, ext: number) => void) => {
    const l = tile.layers[layer];
    if (l) for (let i = 0; i < l.length; i++) fn(l.feature(i), l.extent);
  };
  const props = (f: { properties: unknown }) => f.properties as Props;

  const names = new NameIndex();
  const nameLines: { name: string; cls: string; lines: P[][]; ext: number }[] = [];
  each('transportation_name', (f, ext) => {
    const p = props(f), name = String(p.name ?? '');
    if (f.type !== 2 || !name) return;
    const lines = f.loadGeometry().flatMap((g) => clipLine(g, ext));
    for (const l of lines) names.add(name, l);
    nameLines.push({ name, cls: String(p.class ?? ''), lines, ext });
  });
  for (const n of nameLines) if (NAMED_STREET_CLASSES.has(n.cls)) for (const l of n.lines) out.labels.push({ name: n.name, pts: l.map(to(n.ext)) });

  each('transportation', (f, ext) => {
    if (f.type !== 2) return; // polygons here are pedestrian areas / platforms: never walkable
    const p = props(f), c = classifyMvtRoad(p);
    if (c.kind === 'skip') return;
    for (const line of f.loadGeometry().flatMap((g) => clipLine(g, ext))) {
      let name = '';
      for (let i = 1; i < line.length && !name && i <= 6; i++) name = names.find((line[i - 1].x + line[i].x) / 2, (line[i - 1].y + line[i].y) / 2);
      out.roads.push({ pts: line.map(to(ext)), cls: c.cls, kind: c.kind, hw: c.hw, name });
    }
  });

  const polys = (layer: string, kindOf: (p: Props) => AreaKind | null) => each(layer, (f, ext) => {
    if (f.type !== 3) return;
    const kind = kindOf(props(f)); if (!kind) return;
    for (const poly of groupRings(f.loadGeometry())) {
      const rings = poly.map((r) => { const w = r.map(to(ext)); return w.length > 1 && w[0].x === w[w.length - 1].x && w[0].y === w[w.length - 1].y ? w.slice(0, -1) : w; });
      out.areas.push({ kind, rings, layer });
    }
  });
  polys('landcover', (p) => (p.class === 'grass' ? 'grass' : p.class === 'wood' ? 'wood' : null));
  polys('landuse', (p) => (LANDUSE_GREEN.has(String(p.class)) ? 'grass' : null));
  polys('park', (p) => (p.class === 'park' || p.class === 'nature_reserve' ? 'grass' : null));
  polys('water', (p) => (p.class === 'swimming_pool' ? null : 'water'));
  polys('building', (p) => (Number(p.render_height ?? 0) >= 15 ? 'buildingTall' : 'building'));

  each('poi', (f, ext) => {
    if (f.type !== 1) return;
    const p = props(f), c = classifyMvtPoi(p); if (!c) return;
    const g = f.loadGeometry()[0]?.[0]; if (!g) return;
    const w = to(ext)(g);
    out.pois.push({ name: String(p.name), x: w.x, y: w.y, ...c });
  });
  return out;
}
