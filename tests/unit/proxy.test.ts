import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../../server/app.mjs';

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
const listen = (s: http.Server) => new Promise<string>((res) => { servers.push(s); s.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)); });

/** A fake Overpass: counts calls, optional delay / failure. */
function fakeOverpass(opts: { delay?: number; status?: number } = {}) {
  const calls: string[] = [];
  const s = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      calls.push(decodeURIComponent(body.slice(5)));
      setTimeout(() => {
        if (opts.status) { res.writeHead(opts.status); return res.end('busy'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ elements: [{ type: 'node', id: calls.length, lat: 1, lon: 2 }] }));
      }, opts.delay ?? 0);
    });
  });
  return { s, calls };
}
const url = (base: string, phase = 'roads', extra = '') => `${base}/overpass?phase=${phase}&south=42.35&west=-71.07&north=42.36&east=-71.06${extra}`;
const mk = async (up: string[], o: Record<string, unknown> = {}) => {
  const app = createApp({ upstreams: up.map((u) => u + '/api/interpreter'), minGapMs: 0, hedgeMs: 200, ...o });
  return { app, base: await listen(app.server) };
};

describe('map proxy', () => {
  it('runs the shared query upstream, caches it, and serves the repeat from memory', async () => {
    const f = fakeOverpass(); const up = await listen(f.s);
    const { base } = await mk([up]);
    const a = await fetch(url(base)); expect(a.status).toBe(200);
    expect(a.headers.get('x-cache')).toBe('MISS'); expect(a.headers.get('access-control-allow-origin')).toBe('*');
    expect((await a.json()).elements).toHaveLength(1);
    const b = await fetch(url(base)); expect(b.headers.get('x-cache')).toBe('HIT');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('way["highway"]'); expect(f.calls[0]).toContain('out geom');
    // the two phases are cached separately
    await fetch(url(base, 'detail')); expect(f.calls).toHaveLength(2);
    expect(f.calls[1]).toContain('way["building"]');
  });
  it('de-duplicates concurrent requests for the same chunk', async () => {
    const f = fakeOverpass({ delay: 150 }); const up = await listen(f.s);
    const { base } = await mk([up]);
    const rs = await Promise.all([1, 2, 3, 4].map(() => fetch(url(base))));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(f.calls).toHaveLength(1);
  });
  it('hedges to the next upstream when the first is slow, and falls over when it errors', async () => {
    const slow = fakeOverpass({ delay: 2000 }), fast = fakeOverpass();
    const { base } = await mk([await listen(slow.s), await listen(fast.s)]);
    const t = Date.now(); const r = await fetch(url(base));
    expect(r.status).toBe(200); expect(Date.now() - t).toBeLessThan(1500);
    const bad = fakeOverpass({ status: 429 }), good = fakeOverpass();
    const { base: b2 } = await mk([await listen(bad.s), await listen(good.s)]);
    expect((await fetch(url(b2))).status).toBe(200);
  });
  it('returns 502 when every upstream fails, and serves stale data if it has any', async () => {
    const bad = fakeOverpass({ status: 504 });
    const { base } = await mk([await listen(bad.s)]);
    const r = await fetch(url(base)); expect(r.status).toBe(502);
    const f = fakeOverpass(); const up = await listen(f.s);
    const { base: b2, app } = await mk([up], { ttlMs: 1 });
    await fetch(url(b2)); await new Promise((r2) => setTimeout(r2, 5));
    const old = (app.server as unknown as { listeners: unknown }); void old;
    f.s.close();
    const stale = await fetch(url(b2));
    expect(stale.status).toBe(200); expect(stale.headers.get('x-cache')).toBe('STALE');
  });
  it('validates input: only the two fixed queries, sane bbox sizes, GET only', async () => {
    const f = fakeOverpass(); const { base } = await mk([await listen(f.s)]);
    expect((await fetch(url(base, 'evil'))).status).toBe(400);
    expect((await fetch(`${base}/overpass?phase=roads&south=a&west=1&north=2&east=3`)).status).toBe(400);
    expect((await fetch(`${base}/overpass?phase=roads&south=0&west=0&north=5&east=5`)).status).toBe(400);
    expect((await fetch(`${base}/overpass?phase=roads&south=2&west=0&north=1&east=1`)).status).toBe(400);
    expect((await fetch(url(base), { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect(f.calls).toHaveLength(0);
    const h = await (await fetch(`${base}/health`)).json(); expect(h.ok).toBe(true);
  });
  it('gzips for browsers and still works for clients that do not accept gzip', async () => {
    const f = fakeOverpass(); const { base } = await mk([await listen(f.s)]);
    const gz = await new Promise<Buffer>((res) => http.get(url(base), { headers: { 'accept-encoding': 'gzip' } }, (r) => { expect(r.headers['content-encoding']).toBe('gzip'); const c: Buffer[] = []; r.on('data', (d) => c.push(d)); r.on('end', () => res(Buffer.concat(c))); }));
    expect(JSON.parse(gunzipSync(gz).toString()).elements).toHaveLength(1);
    const plain = await new Promise<string>((res) => http.get(url(base), { headers: { 'accept-encoding': 'identity' } }, (r) => { expect(r.headers['content-encoding']).toBeUndefined(); let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }));
    expect(JSON.parse(plain).elements).toHaveLength(1);
  });
  it('evicts the least recently used entries beyond the byte budget', async () => {
    const f = fakeOverpass(); const { base, app } = await mk([await listen(f.s)], { maxBytes: 200 });
    for (let i = 0; i < 5; i++) await fetch(`${base}/overpass?phase=roads&south=${42 + i * 0.01}&west=-71.07&north=${42.01 + i * 0.01}&east=-71.06`);
    expect(app.cache.size).toBeLessThan(5); expect(app.bytes).toBeLessThanOrEqual(200 + 200);
  });
});
