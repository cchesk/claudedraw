import { BBOX_HALF_M, BBOX_RETRY_HALF_M } from '../config';
import { chunkCacheKey, fetchChunk, OverpassError, type Phase } from '../geo/overpass';
import { demoChunk } from './demo';
import type { OverpassData } from './build';
import { hasEnoughStreets, World } from './world';

export class NotEnoughStreets extends Error {
  constructor() { super('Not enough streets around here — try a more central address.'); }
}

/** Fetch one phase of the OSM data for chunk (i,j) of a world (or the synthetic demo data behind ?demo=1). */
export function chunkFetcher(world: World, demo: boolean) {
  return async (i: number, j: number, phase: Phase, signal?: AbortSignal): Promise<OverpassData> => {
    const bbox = world.chunkBBox(i, j);
    if (demo) return demoChunk(bbox, phase);
    return fetchChunk(chunkCacheKey(world.lat0, world.lng0, world.half, i, j, phase), bbox, phase, signal);
  };
}

export interface PipelineOpts { demo: boolean; signal?: AbortSignal; onStep?: (n: 0 | 1 | 2) => void; halfM?: number }

/** geocoded point → Overpass (streets only, small and fast) → World with the centred chunk playable; buildings and parks follow in the background. Retries at 700m if too sparse (spec §6.2). */
export async function loadMap(lat: number, lng: number, o: PipelineOpts): Promise<World> {
  const sizes = [o.halfM ?? BBOX_HALF_M, BBOX_RETRY_HALF_M];
  for (const half of sizes) {
    o.onStep?.(0);
    const world = new World(lat, lng, half);
    const data = await chunkFetcher(world, o.demo)(0, 0, 'roads', o.signal);
    o.onStep?.(1);
    await new Promise((r) => setTimeout(r, 0)); // let the progress text paint before the CPU-heavy build
    world.ingest(data, 0, 0, 'roads');
    if (hasEnoughStreets(world)) { o.onStep?.(2); return world; }
  }
  throw new NotEnoughStreets();
}

export { OverpassError };
