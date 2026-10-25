import { expect, test } from '@playwright/test';
import { collectErrors, worldPos } from './helpers';

test('desktop: character → location → loading → map, controls, pause', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/?demo=1');
  await expect(page.locator('#s-character')).toBeVisible();

  // keyboard browsing wraps, Tinker selected
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#cta-name')).toHaveText('Tinker');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#cta-name')).toHaveText('Scout');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveAttribute('data-id', 'tinker');
  await page.click('#to-location');

  // Start is disabled until a geocoded result is selected; free text is not enough
  await expect(page.locator('#start')).toBeDisabled();
  await page.fill('#addr', '221 maple');
  await expect(page.locator('#start')).toBeDisabled();
  await page.locator('.opt[data-i="0"]').click();
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#preview-name')).toHaveText('Tinker');
  await page.click('#start');

  await expect(page.locator('#s-map')).toBeVisible();
  await expect(page.locator('.attrib-map')).toContainText('© OpenStreetMap contributors');
  await expect(page.locator('#hud-name')).toHaveText('Tinker');
  await expect(page.locator('#street')).not.toHaveText('');
  const start = await worldPos(page);

  await page.keyboard.down('d'); await page.waitForTimeout(700); await page.keyboard.up('d');
  const moved = await worldPos(page);
  expect(Math.abs(moved.x - start.x) + Math.abs(moved.y - start.y)).toBeGreaterThan(5);

  // holding into a block never leaves the street: the street pill still has a name afterwards
  await page.keyboard.down('s'); await page.waitForTimeout(1500); await page.keyboard.up('s');
  await expect(page.locator('#street')).not.toHaveText('');

  // pause / resume / change location
  await page.keyboard.press('Escape');
  await expect(page.locator('#paused')).toHaveClass(/show/);
  await expect(page.locator('#resume')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#paused')).not.toHaveClass(/show/);
  await page.click('#pause');
  await page.click('#change-loc');
  await expect(page.locator('#s-location')).toBeVisible();
  expect(errs).toEqual([]);
});

test('desktop: Enter on a typed address picks the first suggestion and starts', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.click('#to-location');
  await page.fill('#addr', '221 maple');
  await page.keyboard.press('Enter');
  await expect(page.locator('#s-map')).toBeVisible({ timeout: 15000 });
});

test('desktop: fixed stage scales at other sizes', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await page.goto('/?demo=1');
  const t = await page.locator('#stage').evaluate((el) => el.style.transform);
  expect(t).toContain('scale(0.78125)');
});

test('desktop: the map is endless — running far loads more chunks and stays on streets', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/?demo=1');
  await page.keyboard.press('ArrowLeft'); // Scout, the fastest explorer
  await page.keyboard.press('ArrowLeft');
  await page.click('#to-location');
  await page.fill('#addr', '221 maple');
  await page.locator('.opt[data-i="0"]').click();
  await page.click('#start');
  await expect(page.locator('#s-map')).toBeVisible();
  const chunks0 = Number(await page.locator('#s-map').getAttribute('data-chunks'));
  expect(chunks0).toBeGreaterThanOrEqual(1);
  await page.keyboard.down('d'); await page.keyboard.down('Shift');
  await expect.poll(async () => (await worldPos(page)).x, { timeout: 30000 }).toBeGreaterThan(2500);
  await page.keyboard.up('d'); await page.keyboard.up('Shift');
  expect(Number(await page.locator('#s-map').getAttribute('data-chunks'))).toBeGreaterThan(chunks0);
  await expect(page.locator('#street')).not.toHaveText('');
  await page.screenshot({ path: 'test-results/endless-map.png' });
  expect(errs).toEqual([]);
});
