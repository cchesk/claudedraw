import { readFileSync } from 'node:fs';
import type { OverpassData } from '../../src/map/build';
import { buildMap } from '../../src/map/world';
import { demoData } from '../../src/map/demo';

export const FIXTURES = ['downtown', 'suburb', 'park'] as const;

export function loadFixture(name: (typeof FIXTURES)[number]) {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as OverpassData & { _meta: { lat: number; lng: number; halfM: number } };
  const { lat, lng, halfM } = raw._meta;
  return { data: raw, lat, lng, halfM, map: buildMap(raw, lat, lng, halfM) };
}

export function demoMap() {
  return buildMap(demoData(40, -75, 400), 40, -75, 400);
}

/** Small seeded PRNG so fuzz runs are reproducible. */
export function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
