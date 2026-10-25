import { fetchTile, TILE_Z, tileOf, TileError } from '../geo/tiles';
import { demoChunk } from './demo';
import { decodeTile } from './mvt';
import type { Phase } from './streamer';
import { hasEnoughStreets, World } from './world';

export class NotEnoughStreets extends Error {
  constructor() { super('Not enough streets around here — try a more central address.'); }
}

/** Demo grids are centred squares of this half-size (metres). */
const DEMO_HALF_M = 400;

export function newWorld(lat: number, lng: number, demo: boolean) {
  return demo ? new World(lat, lng, DEMO_HALF_M) : World.mercator(lat, lng);
}

/** Fetch + ingest one chunk of a world: an OpenFreeMap vector tile, or the synthetic demo grid behind ?demo=1. */
export function chunkLoader(world: World, demo: boolean) {
  return async (i: number, j: number, phase: Phase, signal?: AbortSignal): Promise<void> => {
    if (demo) { world.ingest(demoChunk(world.chunkBBox(i, j), phase), i, j, phase); return; }
    if (phase === 'detail') return; // tiles arrive complete
    const buf = await fetchTile(i, j, signal);
    if (signal?.aborted) throw new TileError('aborted', 'aborted');
    world.ingestTile(i, j, decodeTile(buf, i, j, world.proj));
  };
}

export interface PipelineOpts { demo: boolean; signal?: AbortSignal; onStep?: (n: 0 | 1 | 2) => void }

/**
 * geocoded point → vector tile(s) → World, playable. The tile under the origin is loaded first (≈0.3 s); neighbours
 * join if the origin is near an edge or the area is sparse (spec §6.2 retry), so the nearest street is never missed.
 */
export async function loadMap(lat: number, lng: number, o: PipelineOpts): Promise<World> {
  const world = newWorld(lat, lng, o.demo);
  const load = chunkLoader(world, o.demo);
  const home = world.chunkAt(0, 0);
  // distance (world px) from the origin to a chunk's rectangle; 900 px = 450 m
  const near = (i: number, j: number) => {
    const r = world.chunkRect(i, j);
    return Math.hypot(Math.max(r.x0, 0, -r.x1), Math.max(r.y0, 0, -r.y1)) <= 900;
  };
  o.onStep?.(0);
  await load(home.i, home.j, 'roads', o.signal);
  o.onStep?.(1);
  await new Promise((r) => setTimeout(r, 0)); // let the progress text paint
  const ring = [-1, 0, 1].flatMap((dj) => [-1, 0, 1].map((di) => ({ i: home.i + di, j: home.j + dj }))).filter((c) => !(c.i === home.i && c.j === home.j));
  // neighbours the origin is close to (a street just across the tile edge may be the nearest one)
  await Promise.all(ring.filter((c) => near(c.i, c.j)).map((c) => load(c.i, c.j, 'roads', o.signal)));
  if (!hasEnoughStreets(world)) {
    await Promise.all(ring.filter((c) => !world.hasChunk(c.i, c.j)).map((c) => load(c.i, c.j, 'roads', o.signal)));
    if (!hasEnoughStreets(world)) throw new NotEnoughStreets();
  }
  world.pickMain();
  o.onStep?.(2);
  return world;
}

export { TILE_Z, tileOf };
