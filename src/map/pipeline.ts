import { BBOX_HALF_M, BBOX_RETRY_HALF_M } from '../config';
import { chunkCacheKey, fetchChunk, OverpassError } from '../geo/overpass';
import { demoChunk } from './demo';
import type { OverpassData } from './build';
import { hasEnoughStreets, World } from './world';

export class NotEnoughStreets extends Error {
  constructor() { super('Not enough streets around here — try a more central address.'); }
}

/** Fetch the OSM data for chunk (i,j) of a world (or the synthetic demo data behind ?demo=1). */
export function chunkFetcher(world: World, demo: boolean) {
  return async (i: number, j: number, signal?: AbortSignal): Promise<OverpassData> => {
    const bbox = world.chunkBBox(i, j);
    if (demo) return demoChunk(bbox);
    return fetchChunk(chunkCacheKey(world.lat0, world.lng0, world.half, i, j), bbox, signal);
  };
}

export interface PipelineOpts { demo: boolean; signal?: AbortSignal; onStep?: (n: 0 | 1 | 2) => void; halfM?: number }

/** geocoded point → Overpass → World with the centred chunk loaded. Retries at 700m if too sparse (spec §6.2). */
export async function loadMap(lat: number, lng: number, o: PipelineOpts): Promise<World> {
  const sizes = [o.halfM ?? BBOX_HALF_M, BBOX_RETRY_HALF_M];
  for (const half of sizes) {
    o.onStep?.(0);
    const world = new World(lat, lng, half);
    const data = await chunkFetcher(world, o.demo)(0, 0, o.signal);
    o.onStep?.(1);
    await new Promise((r) => setTimeout(r, 0)); // let the progress text paint before the CPU-heavy build
    world.ingest(data, 0, 0);
    if (hasEnoughStreets(world)) { o.onStep?.(2); return world; }
  }
  throw new NotEnoughStreets();
}

export { OverpassError };
