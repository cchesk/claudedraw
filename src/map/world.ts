import { HALF_WIDTH, HASH_CELL, MIN_SEGMENTS, PX_PER_M } from '../config';
import { bboxOfRect, makeProjector, toLatLng, toWorld, type BBox, type Projector } from '../geo/project';
import { TILE_Z, tileOf, tilePointLatLng } from '../geo/tiles';
import {
  bestRun, classifyArea, classifyHighway, classifyPoi, clean, joinRings, LABEL_CHAR_W, makeArea, OTHER_HW,
  UnionFind, type OverpassData,
} from './build';
import type { TileData } from './mvt';
import type { Area, Chunk, Intersection, Label, Poi, Road, Segment, Vec, WayInfo } from './types';

interface NodeAcc extends Intersection { ways: Set<number> }
const WELD_PX = 1.5; // vertices closer than this (0.75 m) are the same graph node

export const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

function bboxOfPts(p: Vec[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return [x0, y0, x1, y1];
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

/**
 * The unbounded street world. The geocoded origin is (0,0). Data arrives in chunks and is ingested one by one:
 *  - 'mercator' worlds (production): chunks are z14 vector tiles from OpenFreeMap, keyed "tx,ty".
 *  - 'centered' worlds (tests, ?demo=1, fixtures): chunks are 2·half-metre squares around the origin, keyed "i,j".
 * Collision, graph, labels and POIs are de-duplicated across chunks; each chunk keeps its own render features so
 * offscreen tiles can be drawn seamlessly.
 */
export class World {
  readonly proj: Projector;
  readonly pxPerM = PX_PER_M;
  readonly mode: 'centered' | 'mercator';
  readonly half: number;
  readonly originPx: Vec = { x: 0, y: 0 };
  readonly chunks = new Map<string, Chunk>();
  readonly segments: Segment[] = [];
  readonly ways: WayInfo[] = [];
  readonly intersections: Intersection[] = [];
  readonly pois: Poi[] = [];
  readonly labels: Label[] = [];
  /** minimap data */
  readonly miniRoads: { pts: Vec[]; bbox: [number, number, number, number] }[] = [];
  readonly miniAreas: Area[] = [];
  readonly hash = new Map<number, number[]>();
  version = 0;

  private wayIds = new Map<number, number>();
  private nodes = new Map<string, NodeAcc>();
  private weldGrid = new Map<number, { key: string; x: number; y: number }[]>();
  private nodeSeq = 0;
  private poiKeys = new Set<string>();
  private areaKeys = new Set<string>();
  private uf = new UnionFind();
  private mainKey: string | null = null;

  /** `half` metres: a centred square grid (tests/demo). Use World.mercator() for real tiles. */
  constructor(public lat0: number, public lng0: number, half: number, mode: 'centered' | 'mercator' = 'centered') {
    this.half = half; this.mode = mode;
    this.proj = makeProjector(lat0, lng0, PX_PER_M);
  }
  static mercator(lat0: number, lng0: number) { return new World(lat0, lng0, 0, 'mercator'); }

  // ---- chunk grid -------------------------------------------------------------------------------------------------
  chunkKey(i: number, j: number) { return `${i},${j}`; }
  chunkAt(x: number, y: number) {
    if (this.mode === 'mercator') { const ll = toLatLng(this.proj, x, y), t = tileOf(ll.lat, ll.lng, TILE_Z); return { i: t.x, j: t.y }; }
    const h = this.half * PX_PER_M;
    return { i: Math.floor((x / h + 1) / 2), j: Math.floor((y / h + 1) / 2) };
  }
  chunkRect(i: number, j: number): Rect {
    if (this.mode === 'mercator') {
      const nw = tilePointLatLng(i, j, 0, 0), se = tilePointLatLng(i, j, 4096, 4096);
      const a = toWorld(this.proj, nw.lat, nw.lng), b = toWorld(this.proj, se.lat, se.lng);
      return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    }
    const h = this.half * PX_PER_M;
    return { x0: (2 * i - 1) * h, y0: (2 * j - 1) * h, x1: (2 * i + 1) * h, y1: (2 * j + 1) * h };
  }
  chunkBBox(i: number, j: number): BBox {
    const r = this.chunkRect(i, j);
    return bboxOfRect(this.proj, r.x0, r.y0, r.x1, r.y1);
  }
  /** Street data loaded: the chunk is playable. */
  hasChunk(i: number, j: number) { return !!this.chunks.get(this.chunkKey(i, j))?.roadsLoaded; }
  hasDetail(i: number, j: number) { return !!this.chunks.get(this.chunkKey(i, j))?.detailLoaded; }

  /** Chunks overlapping a world rect that already have data. */
  chunksIn(r: Rect): Chunk[] {
    const a = this.chunkAt(r.x0, r.y0), b = this.chunkAt(r.x1, r.y1);
    const out: Chunk[] = [];
    for (let j = Math.min(a.j, b.j); j <= Math.max(a.j, b.j); j++) for (let i = Math.min(a.i, b.i); i <= Math.max(a.i, b.i); i++) {
      const c = this.chunks.get(this.chunkKey(i, j)); if (c?.roadsLoaded) out.push(c);
    }
    return out;
  }

  /** Is this segment part of the street network the player can actually reach from the spawn area? */
  reachable = (s: Segment) => this.mainKey === null || this.uf.find(s.nk) === this.uf.find(this.mainKey);
  streetWayCount() { return new Set(this.segments.map((s) => s.way)).size; }

  // ---- graph building ---------------------------------------------------------------------------------------------
  /** Snap a vertex onto an existing node within WELD_PX, so roads that meet (even across tile edges) connect. */
  private weld(x: number, y: number): string {
    const cx = Math.floor(x / 4), cy = Math.floor(y / 4);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const l = this.weldGrid.get(cellKey(cx + dx, cy + dy));
      if (l) for (const n of l) if (Math.hypot(n.x - x, n.y - y) <= WELD_PX) return n.key;
    }
    const key = `n${this.nodeSeq++}`;
    const k = cellKey(cx, cy), l = this.weldGrid.get(k);
    if (l) l.push({ key, x, y }); else this.weldGrid.set(k, [{ key, x, y }]);
    return key;
  }

  private addToHash(idx: number, s: Segment) {
    const x0 = Math.floor((Math.min(s.ax, s.bx) - s.hw) / HASH_CELL), x1 = Math.floor((Math.max(s.ax, s.bx) + s.hw) / HASH_CELL);
    const y0 = Math.floor((Math.min(s.ay, s.by) - s.hw) / HASH_CELL), y1 = Math.floor((Math.max(s.ay, s.by) + s.hw) / HASH_CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const k = cellKey(cx, cy);
      const l = this.hash.get(k);
      if (l) l.push(idx); else this.hash.set(k, [idx]);
    }
  }

  private touchNode(key: string, p: Vec, wayIdx: number, name: string, dir: Vec) {
    let n = this.nodes.get(key);
    if (!n) this.nodes.set(key, (n = { x: p.x, y: p.y, names: [], dirs: [], ways: new Set() }));
    const had = n.ways.size >= 2;
    n.ways.add(wayIdx);
    if (!n.names.includes(name)) n.names.push(name);
    n.dirs.push(dir);
    if (!had && n.ways.size >= 2) this.intersections.push(n);
  }

  /** Register a walkable street polyline (world px): collision segments, graph nodes, connectivity, minimap. */
  private addStreet(wp: Vec[], name: string, cls: string, hw: number): number {
    const idx = this.ways.length;
    this.ways.push({ name: name || 'Unnamed road', cls, hw });
    const label = name || 'Unnamed road';
    const keys = wp.map((p) => this.weld(p.x, p.y));
    keys.forEach((k, i) => { this.uf.find(k); if (i) this.uf.union(keys[i - 1], k); });
    for (let i = 1; i < wp.length; i++) {
      const a = wp[i - 1], b = wp[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.5 || keys[i - 1] === keys[i]) continue;
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
      const seg: Segment = { ax: a.x, ay: a.y, bx: b.x, by: b.y, hw, dx, dy, len, way: idx, nk: keys[i - 1] };
      this.segments.push(seg);
      this.addToHash(this.segments.length - 1, seg);
      this.touchNode(keys[i - 1], a, idx, label, { x: dx, y: dy });
      this.touchNode(keys[i], b, idx, label, { x: -dx, y: -dy });
    }
    this.miniRoads.push({ pts: wp, bbox: bboxOfPts(wp) });
    return idx;
  }

  /** A street name along a polyline: one label on its longest straight run, never two of the same name close together. */
  private addLabel(name: string, wp: Vec[]) {
    if (!name) return;
    const run = bestRun(wp), text = name.toUpperCase();
    if (run.len < 50 || text.length * LABEL_CHAR_W > run.len * 0.92) return;
    if (this.labels.some((l) => l.text === text && Math.hypot(l.x - run.x, l.y - run.y) < 250)) return;
    this.labels.push({ text, x: run.x, y: run.y, angle: run.angle });
  }

  private addPoi(name: string, x: number, y: number, key: string, cat: string, rarity: number) {
    if (this.poiKeys.has(key) || this.pois.some((o) => o.name === name && Math.hypot(o.x - x, o.y - y) < 120)) return;
    this.poiKeys.add(key);
    this.pois.push({ name, x, y, key, cat, rarity });
  }

  private addMiniArea(a: Area) {
    if ((a.kind === 'grass' || a.kind === 'wood' || a.kind === 'water') && !this.areaKeys.has(a.key)) { this.areaKeys.add(a.key); this.miniAreas.push(a); }
  }

  /**
   * Choose the street network the player lives in: the component of the street nearest the origin (if it is a real
   * network, ≥150 m), otherwise the longest one. Call after the first chunk(s) are in.
   */
  pickMain() {
    const len = new Map<string, number>();
    for (const s of this.segments) { const r = this.uf.find(s.nk); len.set(r, (len.get(r) ?? 0) + s.len); }
    let best = -1, bestKey: string | null = null;
    for (const [r, l] of len) if (l > best) { best = l; bestKey = r; }
    let nd = Infinity, near: string | null = null;
    for (const s of this.segments) {
      const vx = s.bx - s.ax, vy = s.by - s.ay, t = Math.max(0, Math.min(1, ((this.originPx.x - s.ax) * vx + (this.originPx.y - s.ay) * vy) / (vx * vx + vy * vy)));
      const d = Math.hypot(this.originPx.x - (s.ax + t * vx), this.originPx.y - (s.ay + t * vy));
      if (d < nd && (len.get(this.uf.find(s.nk)) ?? 0) >= 150 * PX_PER_M) { nd = d; near = this.uf.find(s.nk); }
    }
    this.mainKey = near ?? bestKey;
  }

  private chunkFor(i: number, j: number): Chunk {
    const key = this.chunkKey(i, j);
    const c = this.chunks.get(key) ?? { i, j, roads: [], areas: [], rev: 0, roadsLoaded: false, detailLoaded: false };
    this.chunks.set(key, c);
    return c;
  }

  /** Add one decoded OpenFreeMap vector tile (production data path). */
  ingestTile(tx: number, ty: number, d: TileData): Chunk {
    const chunk = this.chunkFor(tx, ty);
    for (const r of d.roads) {
      chunk.roads.push({ pts: r.pts, cls: r.cls, hw: r.hw, walkable: r.kind === 'street', kind: r.kind, bbox: bboxOfPts(r.pts) });
      if (r.kind === 'street') this.addStreet(r.pts, r.name, r.cls, r.hw);
    }
    for (const l of d.labels) this.addLabel(l.name, l.pts);
    d.areas.forEach((a, n) => {
      const area = makeArea(a.kind, a.rings, `${a.layer}:${tx}:${ty}:${n}`);
      if (!area) return;
      chunk.areas.push(area); this.addMiniArea(area);
    });
    for (const p of d.pois) this.addPoi(p.name, p.x, p.y, `${p.name}|${Math.round(p.x / 8)},${Math.round(p.y / 8)}`, p.cat, p.rarity);
    chunk.roadsLoaded = chunk.detailLoaded = true;
    chunk.rev++; this.version++;
    if (this.mainKey === null) this.pickMain();
    return chunk;
  }

  /** Add one Overpass-shaped chunk (tests, fixtures and ?demo=1). Safe to call for neighbours as the player walks. */
  ingest(data: OverpassData, i = 0, j = 0, phase: 'all' | 'roads' | 'detail' = 'all'): Chunk {
    const chunk = this.chunkFor(i, j);
    const { roads, areas } = chunk;
    const w = (p: { lat: number; lon: number }): Vec => toWorld(this.proj, p.lat, p.lon);
    for (const el of data.elements) {
      const tags = el.tags ?? {};
      const ek = `${el.type[0]}${el.id}`;
      if (el.type === 'way') {
        const pts = clean(el.geometry);
        if (pts.length < 2) continue;
        if (tags.highway) {
          const cls = classifyHighway(tags);
          if (cls === 'skip') continue;
          const hw = cls === 'street' ? HALF_WIDTH[tags.highway] ?? 16 : OTHER_HW[tags.highway] ?? 10;
          const wp = pts.map(w);
          roads.push({ pts: wp, cls: tags.highway, hw, walkable: cls === 'street', kind: cls, bbox: bboxOfPts(wp) });
          if (cls === 'street' && !this.wayIds.has(el.id)) {
            const name = tags.name || tags.ref || '';
            this.wayIds.set(el.id, this.addStreet(wp, name, tags.highway, hw));
            this.addLabel(name, wp);
          }
          continue;
        }
        const kind = classifyArea(tags);
        if (kind && pts.length >= 4 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lon === pts[pts.length - 1].lon) {
          const a = makeArea(kind, [pts.slice(0, -1).map(w)], ek);
          if (a) { areas.push(a); this.addMiniArea(a); }
        }
        const poi = tags.name ? classifyPoi(tags) : null;
        if (poi) {
          const c = pts.reduce((s, p) => { const q = w(p); return { x: s.x + q.x / pts.length, y: s.y + q.y / pts.length }; }, { x: 0, y: 0 });
          this.addPoi(tags.name, c.x, c.y, ek, poi.cat, poi.rarity);
        }
      } else if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
        const poi = tags.name ? classifyPoi(tags) : null;
        if (poi) { const p = w({ lat: el.lat, lon: el.lon }); this.addPoi(tags.name, p.x, p.y, ek, poi.cat, poi.rarity); }
      } else if (el.type === 'relation') {
        const kind = classifyArea(tags);
        if (!kind || kind === 'building' || kind === 'buildingTall') continue;
        const outers = joinRings((el.members ?? []).filter((m) => m.role === 'outer').map((m) => clean(m.geometry)));
        const inners = joinRings((el.members ?? []).filter((m) => m.role === 'inner').map((m) => clean(m.geometry)));
        outers.forEach((o, n) => {
          const a = makeArea(kind, [o.map(w), ...inners.map((r) => r.map(w))], `${ek}.${n}`);
          if (a) { areas.push(a); this.addMiniArea(a); }
        });
      }
    }
    if (phase !== 'detail') chunk.roadsLoaded = true;
    if (phase !== 'roads') chunk.detailLoaded = true;
    chunk.rev++; this.version++;
    if (this.mainKey === null) this.pickMain();
    return chunk;
  }

  /** All render features of loaded chunks overlapping `r` (areas first, roads on top, like paintFeatures draws them). */
  featuresIn(r: Rect): { roads: Road[]; areas: Area[] } {
    const roads: Road[] = [], areas: Area[] = [];
    for (const c of this.chunksIn(r)) { for (const q of c.roads) roads.push(q); for (const a of c.areas) areas.push(a); }
    return { roads, areas };
  }
}

/** Convenience: a centred world with chunk (0,0) loaded. Used by tests, demo and fixtures. */
export function buildMap(data: OverpassData, lat0: number, lng0: number, halfM: number): World {
  const w = new World(lat0, lng0, halfM);
  w.ingest(data, 0, 0);
  w.pickMain();
  return w;
}

/** True when the loaded streets are enough to play (spec §5.4: at least 3 street segments). */
export function hasEnoughStreets(m: World) {
  return m.streetWayCount() >= MIN_SEGMENTS;
}
