import { HASH_CELL, MIN_SEGMENTS, PX_PER_M, HALF_WIDTH } from '../config';
import { bboxOfRect, makeProjector, toWorld, type BBox, type Projector } from '../geo/project';
import {
  bestRun, classifyArea, classifyHighway, classifyPoi, clean, joinRings, keyOf, LABEL_CHAR_W, makeArea, OTHER_HW,
  UnionFind, type OverpassData, type Pt,
} from './build';
import type { Area, Chunk, Intersection, Label, Poi, Segment, Vec, WayInfo } from './types';

interface NodeAcc extends Intersection { ways: Set<number> }

/**
 * The unbounded street world. The geocoded origin is (0,0). OSM data arrives in square chunks (2·half metres)
 * that are ingested one by one; collision, graph, labels and POIs are de-duplicated across chunks, while each chunk
 * keeps its own render features so tiles can be drawn seamlessly.
 */
export class World {
  readonly proj: Projector;
  readonly pxPerM = PX_PER_M;
  readonly half: number;
  readonly originPx: Vec = { x: 0, y: 0 };
  readonly chunks = new Map<string, Chunk>();
  readonly segments: Segment[] = [];
  readonly ways: WayInfo[] = [];
  readonly intersections: Intersection[] = [];
  readonly pois: Poi[] = [];
  readonly labels: Label[] = [];
  /** minimap data, de-duplicated across chunks */
  readonly miniRoads: { pts: Vec[]; bbox: [number, number, number, number] }[] = [];
  readonly miniAreas: Area[] = [];
  readonly hash = new Map<number, number[]>();
  version = 0;

  private wayIds = new Map<number, number>();
  private nodes = new Map<string, NodeAcc>();
  private poiKeys = new Set<string>();
  private areaKeys = new Set<string>();
  private labelCount = new Map<string, number>();
  private uf = new UnionFind();
  private mainKey: string | null = null;

  constructor(public lat0: number, public lng0: number, half: number) {
    this.half = half;
    this.proj = makeProjector(lat0, lng0, PX_PER_M);
  }

  /** side of a chunk in world px */
  get chunkPx() { return 2 * this.half * PX_PER_M; }
  chunkKey(i: number, j: number) { return `${i},${j}`; }
  chunkAt(x: number, y: number) {
    const h = this.half * PX_PER_M;
    return { i: Math.floor((x / h + 1) / 2), j: Math.floor((y / h + 1) / 2) };
  }
  chunkRect(i: number, j: number) {
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

  /** Is this segment part of the street network the player can actually reach from the spawn area? */
  reachable = (s: Segment) => this.mainKey === null || this.uf.find(s.nk) === this.uf.find(this.mainKey);

  streetWayCount() { return this.ways.length; }

  private w = (p: Pt): Vec => toWorld(this.proj, p.lat, p.lon);

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

  private registerWay(id: number, tags: Record<string, string>, pts: Pt[], hw: number) {
    const idx = this.ways.length;
    const name = tags.name || tags.ref || 'Unnamed road';
    this.ways.push({ name, cls: tags.highway, hw });
    this.wayIds.set(id, idx);
    const wp = pts.map(this.w);
    for (let i = 0; i < pts.length; i++) {
      const key = keyOf(pts[i]);
      this.uf.find(key);
      if (i > 0) this.uf.union(keyOf(pts[i - 1]), key);
    }
    for (let i = 1; i < wp.length; i++) {
      const a = wp[i - 1], b = wp[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.5) continue;
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
      const seg: Segment = { ax: a.x, ay: a.y, bx: b.x, by: b.y, hw, dx, dy, len, way: idx, nk: keyOf(pts[i - 1]) };
      this.segments.push(seg);
      this.addToHash(this.segments.length - 1, seg);
      this.touchNode(keyOf(pts[i - 1]), a, idx, name, { x: dx, y: dy });
      this.touchNode(keyOf(pts[i]), b, idx, name, { x: -dx, y: -dy });
    }
    this.miniRoads.push({ pts: wp, bbox: bboxOfPts(wp) });
    if (name !== 'Unnamed road') {
      const run = bestRun(wp);
      const text = name.toUpperCase();
      const n = this.labelCount.get(name) ?? 0;
      const near = this.labels.some((l) => l.text === text && Math.hypot(l.x - run.x, l.y - run.y) < 250);
      if (run.len >= 50 && text.length * LABEL_CHAR_W <= run.len * 0.92 && n < 3 && !near) {
        this.labels.push({ text, x: run.x, y: run.y, angle: run.angle });
        this.labelCount.set(name, n + 1);
      }
    }
  }

  /** Spawn-area component = the largest connected street network among what has been ingested so far. */
  private pickMain() {
    const len = new Map<string, number>();
    for (const s of this.segments) { const r = this.uf.find(s.nk); len.set(r, (len.get(r) ?? 0) + s.len); }
    let best = -1;
    for (const [r, l] of len) if (l > best) { best = l; this.mainKey = r; }
  }

  /** Add one Overpass chunk (spec §6.2/§6.4). Safe to call for neighbours as the player walks. */
  ingest(data: OverpassData, i = 0, j = 0, phase: 'all' | 'roads' | 'detail' = 'all'): Chunk {
    const key = this.chunkKey(i, j);
    const chunk: Chunk = this.chunks.get(key) ?? { i, j, roads: [], areas: [], rev: 0, roadsLoaded: false, detailLoaded: false };
    const { roads, areas } = chunk;
    const addArea = (a: Area | null) => {
      if (!a) return;
      areas.push(a);
      if ((a.kind === 'grass' || a.kind === 'wood' || a.kind === 'water') && !this.areaKeys.has(a.key)) { this.areaKeys.add(a.key); this.miniAreas.push(a); }
    };
    const addPoi = (tags: Record<string, string>, x: number, y: number, key: string) => {
      const c = classifyPoi(tags);
      if (!c || this.poiKeys.has(key)) return;
      if (this.pois.some((o) => o.name === tags.name && Math.hypot(o.x - x, o.y - y) < 120)) return;
      this.poiKeys.add(key);
      this.pois.push({ name: tags.name, x, y, key, ...c });
    };
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
          const wp = pts.map(this.w);
          roads.push({ pts: wp, cls: tags.highway, hw, walkable: cls === 'street', kind: cls, bbox: bboxOfPts(wp) });
          if (cls === 'street' && !this.wayIds.has(el.id)) this.registerWay(el.id, tags, pts, hw);
          continue;
        }
        const kind = classifyArea(tags);
        if (kind && pts.length >= 4 && keyOf(pts[0]) === keyOf(pts[pts.length - 1])) addArea(makeArea(kind, [pts.slice(0, -1).map(this.w)], ek));
        if (tags.name) {
          const c = pts.reduce((s, p) => { const q = this.w(p); return { x: s.x + q.x / pts.length, y: s.y + q.y / pts.length }; }, { x: 0, y: 0 });
          addPoi(tags, c.x, c.y, ek);
        }
      } else if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
        const p = this.w({ lat: el.lat, lon: el.lon });
        addPoi(tags, p.x, p.y, ek);
      } else if (el.type === 'relation') {
        const kind = classifyArea(tags);
        if (!kind || kind === 'building' || kind === 'buildingTall') continue;
        const outers = joinRings((el.members ?? []).filter((m) => m.role === 'outer').map((m) => clean(m.geometry)));
        const inners = joinRings((el.members ?? []).filter((m) => m.role === 'inner').map((m) => clean(m.geometry)));
        outers.forEach((o, n) => addArea(makeArea(kind, [o.map(this.w), ...inners.map((r) => r.map(this.w))], `${ek}.${n}`)));
      }
    }
    if (phase !== 'detail') chunk.roadsLoaded = true;
    if (phase !== 'roads') chunk.detailLoaded = true;
    chunk.rev++;
    this.chunks.set(key, chunk);
    if (this.mainKey === null || !this.segments.some((s) => this.uf.find(s.nk) === this.uf.find(this.mainKey!))) this.pickMain();
    this.version++;
    return chunk;
  }
}

export const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

function bboxOfPts(p: Vec[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  return [x0, y0, x1, y1];
}

/** Convenience: a world with the single centred chunk (0,0) loaded. Used by tests, demo and the location preview. */
export function buildMap(data: OverpassData, lat0: number, lng0: number, halfM: number): World {
  const w = new World(lat0, lng0, halfM);
  w.ingest(data, 0, 0);
  return w;
}

/** True when the first chunk has enough walkable street to play (spec §5.4: at least 3 street segments). */
export function hasEnoughStreets(m: World) {
  return new Set(m.segments.map((s) => s.way)).size >= MIN_SEGMENTS;
}


