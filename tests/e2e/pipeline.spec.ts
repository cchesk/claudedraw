import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { collectErrors } from './helpers';

// Exercises the real (non-demo) pipeline with the network mocked by committed OpenFreeMap tiles:
// geocode (Photon) → TileJSON → vector tiles → decode → World → render. No request leaves the machine.
const tile = (x: number, y: number) => readFileSync(new URL(`../fixtures/tiles/z14_${x}_${y}.pbf`, import.meta.url));
const FIX: Record<string, Buffer> = { '4957/6060': tile(4957, 6060), '4958/6060': tile(4958, 6060), '4957/6061': tile(4957, 6061) };
const place = { lat: 42.357, lng: -71.062 };

async function mockNet(page: Page, opts: { tiles?: 'fixtures' | 'abort' | 'empty' } = {}) {
  const calls = { tiles: 0, tilejson: 0 };
  await page.route(/photon\.komoot\.io\/api/, (r) => r.fulfill({
    json: { features: [{ geometry: { coordinates: [place.lng, place.lat] }, properties: { name: 'Downtown Crossing', street: 'Washington Street', housenumber: '1', city: 'Boston', state: 'Massachusetts', country: 'United States', type: 'house' } }] },
  }));
  await page.route(/openfreemap\.org\/planet$/, (r) => { calls.tilejson++; return r.fulfill({ json: { tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] } }); });
  await page.route(/planet\/test\/14\/(\d+)\/(\d+)\.pbf/, (r) => {
    calls.tiles++;
    if (opts.tiles === 'abort') return r.abort();
    const m = /14\/(\d+)\/(\d+)\.pbf/.exec(r.request().url())!;
    const body = opts.tiles === 'empty' ? undefined : FIX[`${m[1]}/${m[2]}`];
    return r.fulfill({ status: 200, body: body ?? Buffer.alloc(0), contentType: 'application/x-protobuf' });
  });
  return calls;
}

async function pickAddress(page: Page) {
  await page.goto('/');
  await page.click('#to-location');
  await page.fill('#addr', 'downtown crossing boston');
  await page.locator('.opt[data-i="0"]').click();
}

test('real pipeline with mocked Photon + OpenFreeMap tiles', async ({ page }) => {
  const errs = collectErrors(page);
  const calls = await mockNet(page);
  await pickAddress(page);
  await expect(page.locator('#preview')).toHaveClass(/has-map/, { timeout: 10000 });
  const afterPreview = calls.tiles;
  await page.click('#start');
  await expect(page.locator('#s-map')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.attrib-map')).toContainText('© OpenStreetMap contributors');
  expect(calls.tiles).toBeLessThanOrEqual(afterPreview + 3); // only new neighbours may be fetched; the preview's tiles are reused
  await expect(page.locator('#street')).not.toHaveText('');
  await expect(page.locator('#street')).not.toHaveText('Unnamed road');
  await expect(page.locator('#quest-count')).toHaveText('0 / 3');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/pipeline-map.png' });
  expect(errs).toEqual([]);
});

test('tile server failure shows an error with Retry / Pick another location', async ({ page }) => {
  await mockNet(page, { tiles: 'abort' });
  await pickAddress(page);
  await page.click('#start');
  await expect(page.locator('#loading-error')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#loading-retry')).toBeVisible();
  await page.click('#loading-other');
  await expect(page.locator('#s-location')).toBeVisible();
});

test('a place with no streets shows the "not enough streets" message', async ({ page }) => {
  await mockNet(page, { tiles: 'empty' });
  await pickAddress(page);
  await page.click('#start');
  await expect(page.locator('#loading-msg')).toContainText('Not enough streets', { timeout: 15000 });
});
