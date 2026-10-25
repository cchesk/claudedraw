import { FAR_SPAWN_NOTICE_PX, LANDMARK_MIN_DIST_PX, PX_PER_M } from '../config';
import { nearestRoadPoint } from './collision';
import type { Landmark, MapModel, Segment, Vec } from './types';

export interface Spawn extends Vec { street: string; distM: number; far: boolean }

/** Snap the geocoded origin to the nearest walkable street point of the main network (spec §6.5). */
export function findSpawn(m: MapModel): Spawn | null {
  const p = nearestRoadPoint(m, m.originPx.x, m.originPx.y, m.reachable);
  if (!p) return null;
  return { x: p.x, y: p.y, street: m.ways[p.seg.way].name, distM: p.dist / PX_PER_M, far: p.dist > FAR_SPAWN_NOTICE_PX };
}

export interface PickOpts {
  count?: number;
  /** only consider places within this distance of `from` (px) — used for follow-up quests while exploring */
  maxDist?: number;
  /** POI keys already used by earlier quests */
  exclude?: ReadonlySet<string>;
}

/** Choose landmarks (spec §6.6). `rng` is injectable for tests; `luck` (0–100) tilts toward rarer categories. */
export function pickLandmarks(m: MapModel, from: Vec, luck: number, rng: () => number = Math.random, o: PickOpts = {}): Landmark[] {
  const count = o.count ?? 3, maxDist = o.maxDist ?? Infinity;
  const out: Landmark[] = [];
  const near = (x: number, y: number) => Math.hypot(x - from.x, y - from.y) <= maxDist;
  const far = (x: number, y: number, min: number) =>
    Math.hypot(x - from.x, y - from.y) >= min && out.every((l) => Math.hypot(l.poiX - x, l.poiY - y) >= min);

  const scored = m.pois
    .filter((p) => !o.exclude?.has(p.key) && near(p.x, p.y))
    .map((p) => ({ p, score: p.rarity * (luck / 100) + rng() * 1.5 }))
    .sort((a, b) => b.score - a.score);
  for (const { p } of scored) {
    if (out.length >= count) break;
    if (!far(p.x, p.y, LANDMARK_MIN_DIST_PX)) continue;
    const rp = nearestRoadPoint(m, p.x, p.y, m.reachable);
    if (!rp || Math.hypot(rp.x - from.x, rp.y - from.y) < 100) continue;
    if (out.some((l) => Math.hypot(l.x - rp.x, l.y - rp.y) < 100)) continue;
    out.push({ name: p.name, x: rp.x, y: rp.y, poiX: p.x, poiY: p.y, cat: p.cat, key: p.key });
  }

  // Fill with random street points, relaxing the spacing if the area is small.
  const segs: Segment[] = m.segments.filter((s) => m.reachable(s) && near((s.ax + s.bx) / 2, (s.ay + s.by) / 2));
  const total = segs.reduce((s, g) => s + g.len, 0);
  for (const min of [LANDMARK_MIN_DIST_PX, 160, 100, 60, 0]) {
    let tries = 0;
    while (out.length < count && tries++ < 400 && total > 0) {
      let r = rng() * total, seg = segs[0];
      for (const g of segs) { r -= g.len; if (r <= 0) { seg = g; break; } }
      const t = rng();
      const x = seg.ax + (seg.bx - seg.ax) * t, y = seg.ay + (seg.by - seg.ay) * t;
      if (!far(x, y, min) || Math.hypot(x - from.x, y - from.y) < 80) continue;
      out.push({ name: 'Hidden spot', x, y, poiX: x, poiY: y, cat: 'hidden' });
    }
  }
  return out;
}
