import { ASSIST_ANGLE, ASSIST_RADIUS, BOUNDS_INSET } from '../config';
import type { MapModel, Segment, Vec } from './types';

export interface SegHit { d: number; t: number; cx: number; cy: number }

export function distToSegment(px: number, py: number, s: Segment): SegHit {
  const vx = s.bx - s.ax, vy = s.by - s.ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 === 0 ? 0 : ((px - s.ax) * vx + (py - s.ay) * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = s.ax + t * vx, cy = s.ay + t * vy;
  return { d: Math.hypot(px - cx, py - cy), t, cx, cy };
}

export function inBounds(m: MapModel, x: number, y: number) {
  return x >= BOUNDS_INSET && y >= BOUNDS_INSET && x <= m.width - BOUNDS_INSET && y <= m.height - BOUNDS_INSET;
}

function cellOf(m: MapModel, x: number, y: number) {
  const { cell, cols, rows } = m.hash;
  const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cell))), cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cell)));
  return (m.hash.cells as number[][])[cy * cols + cx];
}

/** Segments whose walkable band contains the point, nearest first. */
export function segmentsAt(m: MapModel, x: number, y: number): { seg: Segment; hit: SegHit }[] {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > m.width || y > m.height) return [];
  const out: { seg: Segment; hit: SegHit }[] = [];
  for (const i of cellOf(m, x, y)) {
    const seg = m.segments[i];
    const hit = distToSegment(x, y, seg);
    if (hit.d <= seg.hw) out.push({ seg, hit });
  }
  return out.sort((a, b) => a.hit.d / a.seg.hw - b.hit.d / b.seg.hw);
}

/** Spec §7: inside bounds (inset) AND within some walkable segment's half-width. */
export function isWalkable(m: MapModel, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !inBounds(m, x, y)) return false;
  for (const i of cellOf(m, x, y)) {
    const seg = m.segments[i];
    if (distToSegment(x, y, seg).d <= seg.hw) return true;
  }
  return false;
}

export interface RoadPoint extends Vec { dist: number; seg: Segment }

/** Nearest point on any walkable centreline. Segments are pre-clipped to the bounds, so the result is always walkable. */
export function nearestRoadPoint(m: MapModel, x: number, y: number, filter?: (s: Segment) => boolean): RoadPoint | null {
  let best: RoadPoint | null = null;
  for (const seg of m.segments) {
    if (filter && !filter(seg)) continue;
    const h = distToSegment(x, y, seg);
    if (!best || h.d < best.dist) best = { x: h.cx, y: h.cy, dist: h.d, seg };
  }
  return best;
}

export interface MoveResult { x: number; y: number; moved: boolean; blocked: boolean }

/**
 * One movement step (spec §7). `d` is a unit vector. Order: direct → slide along road → corner assist → blocked.
 * The returned position is guaranteed walkable if the start position was.
 */
export function stepMove(m: MapModel, px: number, py: number, dx: number, dy: number, step: number): MoveResult {
  if (step <= 0 || (dx === 0 && dy === 0)) return { x: px, y: py, moved: false, blocked: false };
  // 1. direct
  const nx = px + dx * step, ny = py + dy * step;
  if (isWalkable(m, nx, ny)) return { x: nx, y: ny, moved: true, blocked: false };

  // 2. slide: project the input onto the direction of each road we're standing on, best-aligned first
  const here = segmentsAt(m, px, py);
  const cands = here
    .map(({ seg }) => ({ seg, dot: dx * seg.dx + dy * seg.dy }))
    .filter((c) => Math.abs(c.dot) > 0.05)
    .sort((a, b) => Math.abs(b.dot) - Math.abs(a.dot));
  for (const { seg, dot } of cands) {
    const sx = px + seg.dx * dot * step, sy = py + seg.dy * dot * step;
    if (isWalkable(m, sx, sy)) return { x: sx, y: sy, moved: true, blocked: false };
  }

  // 3. corner assist: pull toward a nearby intersection when the input points broadly down a street leaving it
  let bestN: { x: number; y: number; dist: number } | null = null;
  for (const n of m.intersections) {
    const dist = Math.hypot(n.x - px, n.y - py);
    if (dist > ASSIST_RADIUS || dist < 0.01 || (bestN && dist >= bestN.dist)) continue;
    if (n.dirs.some((v) => Math.acos(Math.max(-1, Math.min(1, v.x * dx + v.y * dy))) <= ASSIST_ANGLE)) bestN = { x: n.x, y: n.y, dist };
  }
  if (bestN) {
    const k = Math.min(step, bestN.dist) / bestN.dist;
    const ax = px + (bestN.x - px) * k, ay = py + (bestN.y - py) * k;
    if (isWalkable(m, ax, ay)) return { x: ax, y: ay, moved: true, blocked: false };
  }
  return { x: px, y: py, moved: false, blocked: true };
}

/** Name of the street under the player; "A & B" within 20px of an intersection with a differently named street. */
export function streetNameAt(m: MapModel, x: number, y: number): string {
  for (const n of m.intersections) {
    if (Math.hypot(n.x - x, n.y - y) <= 20 && n.names.length > 1) return n.names.slice(0, 2).join(' & ');
  }
  const here = segmentsAt(m, x, y);
  return here.length ? m.ways[here[0].seg.way].name : '';
}

const SUBSTEP = 6;

/** stepMove in sub-steps of ≤6px so a frame hitch can never tunnel across a thin gap between streets. */
export function advance(m: MapModel, px: number, py: number, dx: number, dy: number, step: number): MoveResult {
  let x = px, y = py, moved = false, blocked = false;
  const n = Math.max(1, Math.ceil(step / SUBSTEP));
  for (let i = 0; i < n; i++) {
    const r = stepMove(m, x, y, dx, dy, step / n);
    if (r.moved) { x = r.x; y = r.y; moved = true; } else { blocked = true; break; }
  }
  return { x, y, moved, blocked };
}
