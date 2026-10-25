import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { collectErrors } from './helpers';

// Exercises the real (non-demo) pipeline with the network mocked by a committed OSM fixture:
// geocode (Photon) → Overpass → MapModel → render. No request leaves the machine.
const fx = JSON.parse(readFileSync(new URL('../fixtures/downtown.json', import.meta.url), 'utf8'));
const { lat, lng } = fx._meta;

test('real pipeline with mocked Photon + Overpass', async ({ page }) => {
  const errs = collectErrors(page);
  let overpassCalls = 0;
  await page.route(/photon\.komoot\.io\/api/, (r) => r.fulfill({
    json: { features: [{ geometry: { coordinates: [lng, lat] }, properties: { name: 'Downtown Crossing', street: 'Washington Street', housenumber: '1', city: 'Boston', state: 'Massachusetts', country: 'United States', type: 'house' } }] },
  }));
  await page.route(/overpass/, (r) => { overpassCalls++; return r.fulfill({ json: { elements: fx.elements } }); });
  await page.goto('/');
  await page.click('#to-location');
  await page.fill('#addr', 'downtown crossing boston');
  await page.locator('.opt[data-i="0"]').click();
  await expect(page.locator('#preview')).toHaveClass(/has-map/, { timeout: 10000 });
  await page.click('#start');
  await expect(page.locator('#s-map')).toBeVisible({ timeout: 15000 });
  expect(overpassCalls).toBe(1); // preview warmed the cache; starting did not hit the network again
  await expect(page.locator('#street')).not.toHaveText('');
  const names = new Set<string>(fx.elements.filter((e: { tags?: { name?: string; highway?: string } }) => e.tags?.highway && e.tags.name).map((e: { tags: { name: string } }) => e.tags.name));
  const shown = (await page.locator('#street').textContent())!;
  expect(shown.split(' & ').every((n) => names.has(n))).toBe(true);
  await expect(page.locator('#quest-count')).toHaveText('0 / 3');
  await page.screenshot({ path: 'test-results/pipeline-map.png' });
  expect(errs).toEqual([]);
});

test('Overpass failure shows an error with Retry / Pick another location', async ({ page }) => {
  await page.route(/photon\.komoot\.io\/api/, (r) => r.fulfill({ json: { features: [{ geometry: { coordinates: [lng, lat] }, properties: { name: 'X', city: 'Boston' } }] } }));
  await page.route(/overpass/, (r) => r.abort());
  await page.goto('/');
  await page.click('#to-location');
  await page.fill('#addr', 'boston');
  await page.locator('.opt[data-i="0"]').click();
  await page.click('#start');
  await expect(page.locator('#loading-error')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#loading-retry')).toBeVisible();
  await page.click('#loading-other');
  await expect(page.locator('#s-location')).toBeVisible();
});

test('a place with no streets shows the "not enough streets" message', async ({ page }) => {
  await page.route(/photon\.komoot\.io\/api/, (r) => r.fulfill({ json: { features: [{ geometry: { coordinates: [0, 0] }, properties: { name: 'Null Island' } }] } }));
  await page.route(/overpass/, (r) => r.fulfill({ json: { elements: [] } }));
  await page.goto('/');
  await page.click('#to-location');
  await page.fill('#addr', 'null island');
  await page.locator('.opt[data-i="0"]').click();
  await page.click('#start');
  await expect(page.locator('#loading-msg')).toContainText('Not enough streets', { timeout: 15000 });
});
