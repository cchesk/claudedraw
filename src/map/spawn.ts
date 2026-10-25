import { FAR_SPAWN_NOTICE_PX, LANDMARK_MIN_DIST_PX, PX_PER_M } from '../config';
import { nearestRoadPoint } from './collision';
import type { Landmark, MapModel, Vec } from './types';

export interface Spawn extends Vec { street: string; distM: number; far: boolean }

/** Snap the geocoded origin to the nearest walkable street point (spec §6.5). */
export function findSpawn(m: MapModel): Spawn | null {
  const p = nearestRoadPoint(m, m.originPx.x, m.originPx.y);
  if (!p) return null;
  return { x: p.x, y: p.y, street: m.ways[p.seg.way].name, distM: p.dist / PX_PER_M, far: p.dist > FAR_SPAWN_NOTICE_PX };
}

/** Choose 3 landmarks (spec §6.6). `rng` is injectable for tests; `luck` (0–100) tilts toward rarer categories. */
export function pickLandmarks(m: MapModel, spawn: Vec, luck: number, rng: () => number = Math.random, count = 3): Landmark[] {
  const out: Landmark[] = [];
  const far = (x: number, y: number, min: number) =>
    Math.hypot(x - spawn.x, y - spawn.y) >= min && out.every((l) => Math.hypot(l.poiX - x, l.poiY - y) >= min);

  const scored = m.pois
    .map((p) => ({ p, score: p.rarity * (luck / 100) + rng() * 1.5 }))
    .sort((a, b) => b.score - a.score);
  for (const { p } of scored) {
    if (out.length >= count) break;
    if (!far(p.x, p.y, LANDMARK_MIN_DIST_PX)) continue;
    const rp = nearestRoadPoint(m, p.x, p.y);
    if (!rp || Math.hypot(rp.x - spawn.x, rp.y - spawn.y) < 100) continue;
    if (out.some((l) => Math.hypot(l.x - rp.x, l.y - rp.y) < 100)) continue;
    out.push({ name: p.name, x: rp.x, y: rp.y, poiX: p.x, poiY: p.y, cat: p.cat });
  }

  // Fill with random street points, relaxing the spacing if the map is small.
  const total = m.segments.reduce((s, g) => s + g.len, 0);
  for (const min of [LANDMARK_MIN_DIST_PX, 160, 100, 60, 0]) {
    let tries = 0;
    while (out.length < count && tries++ < 400 && total > 0) {
      let r = rng() * total, seg = m.segments[0];
      for (const g of m.segments) { r -= g.len; if (r <= 0) { seg = g; break; } }
      const t = rng();
      const x = seg.ax + (seg.bx - seg.ax) * t, y = seg.ay + (seg.by - seg.ay) * t;
      if (!far(x, y, min) || Math.hypot(x - spawn.x, y - spawn.y) < 80) continue;
      out.push({ name: 'Hidden spot', x, y, poiX: x, poiY: y, cat: 'hidden' });
    }
  }
  return out;
}
