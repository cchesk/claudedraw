import { COLORS, ROAD_DRAW_EXTRA } from '../config';
import type { Area, MapModel, Vec } from './types';

export interface PaintOpts { labels: boolean; trees: boolean; buildings: boolean; dash: boolean }
export const FULL: PaintOpts = { labels: true, trees: true, buildings: true, dash: true };
export const LOW: PaintOpts = { labels: false, trees: false, buildings: true, dash: false };

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

function drawTrees(ctx: CanvasRenderingContext2D, a: Area) {
  const [x0, y0, x1, y1] = a.bbox;
  const rnd = mulberry(Math.floor(x0 * 31 + y0 * 17 + a.size));
  const n = Math.min(60, Math.floor(a.size / (a.kind === 'wood' ? 700 : 1400)));
  ctx.fillStyle = COLORS.tree;
  for (let i = 0, placed = 0; i < n * 4 && placed < n; i++) {
    const p = { x: x0 + rnd() * (x1 - x0), y: y0 + rnd() * (y1 - y0) };
    if (!inside(p, a.rings[0]) || a.rings.slice(1).some((r) => inside(p, r))) continue;
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 + rnd() * 8, 0, Math.PI * 2); ctx.fill(); placed++;
  }
}

function strokeLine(ctx: CanvasRenderingContext2D, pts: Vec[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

/** Paint the whole static map in world coordinates (spec §6.7 layers: ground, areas, roads, labels). */
export function paintMap(ctx: CanvasRenderingContext2D, m: MapModel, o: PaintOpts = FULL) {
  ctx.fillStyle = COLORS.ground;
  ctx.fillRect(0, 0, m.width, m.height);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const order: Area['kind'][] = ['grass', 'wood', 'water', ...(o.buildings ? (['building', 'buildingTall'] as const) : [])];
  const fill: Record<Area['kind'], string> = { grass: COLORS.park, wood: COLORS.park, water: COLORS.water, building: COLORS.building, buildingTall: COLORS.buildingTall };
  for (const kind of order) {
    ctx.fillStyle = fill[kind];
    const list = m.areas.filter((a) => a.kind === kind).sort((a, b) => b.size - a.size);
    for (const a of list) { ringPath(ctx, a.rings); ctx.fill('evenodd'); }
    if (o.trees && (kind === 'grass' || kind === 'wood')) for (const a of list) drawTrees(ctx, a);
  }

  // footpaths: drawn thin, never walkable
  ctx.strokeStyle = COLORS.path; ctx.lineWidth = 3;
  for (const r of m.roads) if (r.kind === 'path') strokeLine(ctx, r.pts);
  // non-walkable roads (motorways, driveways, private, tunnels, disconnected fragments)
  ctx.strokeStyle = COLORS.otherRoad;
  for (const r of m.roads) if (r.kind === 'other') { ctx.lineWidth = r.hw * 2; strokeLine(ctx, r.pts); }
  // walkable streets
  const streets = m.roads.filter((r) => r.kind === 'street').sort((a, b) => a.hw - b.hw);
  ctx.strokeStyle = COLORS.street;
  for (const r of streets) { ctx.lineWidth = (r.hw + ROAD_DRAW_EXTRA) * 2; strokeLine(ctx, r.pts); }
  if (o.dash) {
    ctx.strokeStyle = COLORS.dash; ctx.lineWidth = 2; ctx.setLineDash([16, 12]); ctx.lineCap = 'butt';
    for (const r of streets) strokeLine(ctx, r.pts);
    ctx.setLineDash([]); ctx.lineCap = 'round';
  }

  if (o.labels) {
    ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = COLORS.label; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    (ctx as unknown as { letterSpacing?: string }).letterSpacing = '1px';
    for (const l of m.labels) {
      ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.angle); ctx.fillText(l.text, 0, 0); ctx.restore();
    }
    (ctx as unknown as { letterSpacing?: string }).letterSpacing = '0px';
  }
}

/** Pre-render the static layers once to an offscreen canvas at `scale` px per world px. */
export function renderStatic(m: MapModel, scale: number, o: PaintOpts = FULL): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(m.width * scale); c.height = Math.ceil(m.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  paintMap(ctx, m, o);
  return c;
}

/** Offscreen scale: crisp on hi-dpi, but capped so the bitmap stays under ~16M px. */
export function pickScale(m: MapModel, want: number) {
  const cap = Math.sqrt(16e6 / (m.width * m.height));
  return Math.max(0.5, Math.min(want, 2, cap));
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
