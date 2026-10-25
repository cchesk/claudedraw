import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildQuery, fetchRemote } from '../../src/geo/overpass';
import { OVERPASS_URLS } from '../../src/config';

const bbox = { south: 42.35, west: -71.07, north: 42.36, east: -71.06 };
const ok = (n: number) => new Response(JSON.stringify({ elements: Array.from({ length: n }, (_, i) => ({ type: 'node', id: i })) }));
const hang = (signal: AbortSignal) => new Promise<Response>((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('queries', () => {
  it('roads phase asks for streets and named POIs, never buildings', () => {
    const q = buildQuery(bbox, 'roads');
    expect(q).toContain('way["highway"]'); expect(q).toContain('["name"]["tourism"]');
    expect(q).not.toContain('"building"'); expect(q).toContain('out geom');
  });
  it('detail phase asks for buildings, parks, water and footpaths, not the street network', () => {
    const q = buildQuery(bbox, 'detail');
    for (const t of ['way["building"]', 'natural', 'footway', 'multipolygon']) expect(q).toContain(t);
    expect(q).not.toContain('way["highway"]["highway"!~');
  });
});

describe('hedged Overpass requests', () => {
  it('asks the next server when the first one is slow, and the first answer wins', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push(url);
      return url === OVERPASS_URLS[0] ? hang(init.signal as AbortSignal) : Promise.resolve(ok(3));
    });
    const p = fetchRemote('q');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([OVERPASS_URLS[0]]);
    await vi.advanceTimersByTimeAsync(4000);
    const r = await p;
    expect(r.elements).toHaveLength(3);
    expect(calls).toEqual([OVERPASS_URLS[0], OVERPASS_URLS[1]]);
  });
  it('moves on immediately when a server errors, and reports why if all fail', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('busy', { status: 429 })));
    const p = fetchRemote('q').catch((e) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const e = await p;
    expect(e.detail).toContain('429');
  });
});
