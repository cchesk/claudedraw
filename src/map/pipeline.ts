import { BBOX_HALF_M, BBOX_RETRY_HALF_M } from '../config';
import { fetchOsm, OverpassError } from '../geo/overpass';
import { buildMap, hasEnoughStreets } from './build';
import { demoData } from './demo';
import type { MapModel } from './types';

export class NotEnoughStreets extends Error {
  constructor() { super('Not enough streets around here — try a more central address.'); }
}

export interface PipelineOpts { demo: boolean; signal?: AbortSignal; onStep?: (n: 0 | 1 | 2) => void; halfM?: number }

/** geocoded point → Overpass → MapModel. Retries once at 700m if the area is too sparse (spec §6.2). */
export async function loadMap(lat: number, lng: number, o: PipelineOpts): Promise<MapModel> {
  const sizes = [o.halfM ?? BBOX_HALF_M, BBOX_RETRY_HALF_M];
  for (let i = 0; i < sizes.length; i++) {
    o.onStep?.(0);
    const half = sizes[i];
    const data = o.demo ? demoData(lat, lng, half) : await fetchOsm(lat, lng, half, o.signal);
    o.onStep?.(1);
    await new Promise((r) => setTimeout(r, 0)); // let the progress text paint before the CPU-heavy build
    const map = buildMap(data, lat, lng, half);
    if (hasEnoughStreets(map)) { o.onStep?.(2); return map; }
  }
  throw new NotEnoughStreets();
}

export { OverpassError };
