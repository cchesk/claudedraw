import { COLORS, PX_PER_M, ROAD_DRAW_EXTRA } from '../config';
import type { Area, Label, Road, Vec } from './types';
import type { World } from './world';

export interface PaintOpts { trees: boolean; buildings: boolean; dash: boolean }
export const FULL: PaintOpts = { trees: true, buildings: true, dash: true };
export const LOW: PaintOpts = { trees: false, buildings: true, dash: false };

export interface Rect { x0: number; y0: number; x1: number; y1: number }

const hits = (b: readonly [number, number, number, number], r: Rect, pad = 0) =>
  b[2] + pad >= r.x0 && b[0] - pad <= r.x1 && b[3] + pad >= r.y0 && b[1] - pad <= r.y1;

function ringPath(ctx: CanvasRenderingContext2D, rings: Vec[][]) {
  ctx.beginPath();
  for (const r of rings) {
    r.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  }
}

function inside(pt: Vec, ring: Vec[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Small deterministic PRNG so trees don't move between renders. */
function mulberry(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function drawTrees(ctx: CanvasRenderingContext2D, a: Area, r: Rect) {
  const [x0, y0, x1, y1] = a.bbox;
  const rnd = mulberry(Math.floor(x0 * 31 + y0 * 17 + a.size));
  const n = Math.min(60, Math.floor(a.size / (a.kind === 'wood' ? 700 : 1400)));
  ctx.fillStyle = COLORS.tree;
  for (let i = 0, placed = 0; i < n * 4 && placed < n; i++) {
    const p = { x: x0 + rnd() * (x1 - x0), y: y0 + rnd() * (y1 - y0) }, rad = 6 + rnd() * 8;
    if (!inside(p, a.rings[0]) || a.rings.slice(1).some((q) => inside(p, q))) continue;
    placed++;
    if (p.x + rad < r.x0 || p.x - rad > r.x1 || p.y + rad < r.y0 || p.y - rad > r.y1) continue;
    ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); ctx.fill();
  }
}

function strokeLine(ctx: CanvasRenderingContext2D, pts: Vec[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

const FILL: Record<Area['kind'], string> = { grass: COLORS.park, wood: COLORS.park, water: COLORS.water, building: COLORS.building, buildingTall: COLORS.buildingTall };

/** Paint ground, areas and roads (spec §6.7 layers) of one chunk's features inside `r`, in world coordinates. */
export function paintFeatures(ctx: CanvasRenderingContext2D, roads: readonly Road[], areas: readonly Area[], r: Rect, o: PaintOpts = FULL) {
  ctx.fillStyle = COLORS.ground;
  ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); ctx.clip();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const order: Area['kind'][] = ['grass', 'wood', 'water', ...(o.buildings ? (['building', 'buildingTall'] as const) : [])];
  for (const kind of order) {
    ctx.fillStyle = FILL[kind];
    const list = areas.filter((a) => a.kind === kind && hits(a.bbox, r)).sort((a, b) => b.size - a.size);
    for (const a of list) { ringPath(ctx, a.rings); ctx.fill('evenodd'); }
    if (o.trees && (kind === 'grass' || kind === 'wood')) for (const a of list) drawTrees(ctx, a, r);
  }

  const vis = roads.filter((q) => hits(q.bbox, r, q.hw + ROAD_DRAW_EXTRA));
  // footpaths: drawn thin, never walkable
  ctx.strokeStyle = COLORS.path; ctx.lineWidth = 3;
  for (const q of vis) if (q.kind === 'path') strokeLine(ctx, q.pts);
  // non-walkable roads (motorways, driveways, private, tunnels)
  ctx.strokeStyle = COLORS.otherRoad;
  for (const q of vis) if (q.kind === 'other') { ctx.lineWidth = q.hw * 2; strokeLine(ctx, q.pts); }
  // walkable streets
  const streets = vis.filter((q) => q.kind === 'street').sort((a, b) => a.hw - b.hw);
  ctx.strokeStyle = COLORS.street;
  for (const q of streets) { ctx.lineWidth = (q.hw + ROAD_DRAW_EXTRA) * 2; strokeLine(ctx, q.pts); }
  if (o.dash) {
    ctx.strokeStyle = COLORS.dash; ctx.lineWidth = 2; ctx.setLineDash([16, 12]); ctx.lineCap = 'butt';
    for (const q of streets) strokeLine(ctx, q.pts);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** Street names, drawn live on top of the tiles so they stay crisp and never get cut at tile edges. */
export function drawLabels(ctx: CanvasRenderingContext2D, labels: readonly Label[], r: Rect) {
  ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = COLORS.label; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const c = ctx as unknown as { letterSpacing?: string };
  c.letterSpacing = '1px';
  for (const l of labels) {
    if (l.x < r.x0 - 150 || l.x > r.x1 + 150 || l.y < r.y0 - 150 || l.y > r.y1 + 150) continue;
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.angle); ctx.fillText(l.text, 0, 0); ctx.restore();
  }
  c.letterSpacing = '0px';
}

/** Lazily rendered, LRU-cached offscreen tiles (spec §6.7). A render tile may straddle several fetched chunks. */
export class TileCache {
  private tiles = new Map<string, { canvas: HTMLCanvasElement; used: number; sig: string }>();
  private tick = 0;
  scale = 1;
  /** how many tile bitmaps have been painted so far (a thrashing cache would make this explode) */
  renders = 0;
  readonly px: number;
  constructor(private world: World, private max = 48, private makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')) { this.px = world.mode === 'mercator' ? 512 : (world.half * PX_PER_M) / 2; }

  /** Re-rendering is skipped for tiles that fit: allow as many as ~96 MB of tile bitmaps (at least 24, so a window always fits). */
  setScale(s: number) {
    if (Math.abs(s - this.scale) / this.scale <= 0.25) return;
    this.scale = s; this.tiles.clear();
    this.max = Math.max(24, Math.min(96, Math.floor(96e6 / (4 * (this.px * s) ** 2))));
  }
  clear() { this.tiles.clear(); }

  private rect(tx: number, ty: number): Rect { return { x0: tx * this.px, y0: ty * this.px, x1: (tx + 1) * this.px, y1: (ty + 1) * this.px }; }
  /** identifies which chunk data a tile was drawn from, so it can be redrawn when more arrives */
  private sig(r: Rect) { return this.world.chunksIn(r).map((c) => `${c.i},${c.j}:${c.rev}`).join('|'); }

  has(tx: number, ty: number) { return this.tiles.has(`${tx},${ty}`); }

  /** True when the tile exists but its chunks have gained data (e.g. buildings arrived) since it was drawn. */
  isStale(tx: number, ty: number) {
    const t = this.tiles.get(`${tx},${ty}`);
    return !!t && t.sig !== this.sig(this.rect(tx, ty));
  }

  /** The tile canvas (re-rendering it first if allowed and needed), or null if no chunk covering it has data yet. */
  get(tx: number, ty: number, canCreate = true): HTMLCanvasElement | null {
    const key = `${tx},${ty}`;
    let t = this.tiles.get(key);
    const r = this.rect(tx, ty), sig = this.sig(r);
    if (!sig) return t?.canvas ?? null;
    if (!t || (canCreate && t.sig !== sig)) {
      if (!canCreate) return null;
      this.renders++;
      const c = t?.canvas ?? this.makeCanvas();
      c.width = c.height = Math.ceil(this.px * this.scale);
      const ctx = c.getContext('2d')!;
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.translate(-r.x0, -r.y0);
      const f = this.world.featuresIn(r);
      paintFeatures(ctx, f.roads, f.areas, r);
      // mark it most-recently-used BEFORE trimming, or a full cache would evict the tile it just drew
      this.tiles.set(key, (t = { canvas: c, used: ++this.tick, sig }));
      if (this.tiles.size > this.max) this.evict();
    }
    t.used = ++this.tick;
    return t.canvas;
  }

  private evict() {
    const sorted = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k] of sorted.slice(0, this.tiles.size - this.max)) this.tiles.delete(k);
  }
}

/** Offscreen tile scale: crisp on hi-dpi, capped so a tile stays small. */
export function pickScale(want: number) { return Math.max(0.5, Math.min(want, 1.5)); }

/** Minimap: the real road network around the player, north up. `radiusPx` is world px from centre to edge. */
export function drawMinimap(ctx: CanvasRenderingContext2D, w: World, cx: number, cy: number, radiusPx: number, size: number) {
  const s = size / (2 * radiusPx);
  const r: Rect = { x0: cx - radiusPx, y0: cy - radiusPx, x1: cx + radiusPx, y1: cy + radiusPx };
  ctx.save();
  ctx.fillStyle = COLORS.ground; ctx.fillRect(0, 0, size, size);
  ctx.translate(size / 2 - cx * s, size / 2 - cy * s); ctx.scale(s, s);
  for (const a of w.miniAreas) {
    if (!hits(a.bbox, r)) continue;
    ctx.fillStyle = FILL[a.kind]; ringPath(ctx, a.rings); ctx.fill('evenodd');
  }
  ctx.strokeStyle = '#3A4766'; ctx.lineWidth = Math.max(10, 3 / s); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const q of w.miniRoads) if (hits(q.bbox, r)) strokeLine(ctx, q.pts);
  ctx.restore();
}

export function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, pulse = 0) {
  ctx.fillStyle = color; ctx.globalAlpha = 0.14 + pulse * 0.08;
  ctx.beginPath(); ctx.arc(x, y, 26 + pulse * 4, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.ink; ctx.strokeStyle = color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 4.2 : 9, a = -Math.PI / 2 + (i * Math.PI) / 5; ctx.lineTo(x + Math.cos(a) * r, y + 0.5 + Math.sin(a) * r); }
  ctx.closePath(); ctx.fill();
}
