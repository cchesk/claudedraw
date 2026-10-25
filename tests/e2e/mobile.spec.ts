import { expect, test, type Page } from '@playwright/test';
import { collectErrors, noHorizontalOverflow, worldPos } from './helpers';

async function touchPoints(page: Page, type: string, pts: { x: number; y: number; id: number }[]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  return cdp;
}

test('phone: whole flow by touch, joystick + RUN, pause', async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto('/?demo=1');
  expect(await noHorizontalOverflow(page)).toBe(true);
  await expect(page.locator('body')).toHaveClass(/fluid/);
  await expect(page.locator('body')).toHaveClass(/touch/);

  await page.tap('.card[data-id="scout"]');
  await expect(page.locator('#cta-name')).toHaveText('Scout');
  await page.tap('#to-location');
  expect(await noHorizontalOverflow(page)).toBe(true);
  await page.fill('#addr', '221 maple');
  await page.locator('.opt[data-i="0"]').tap();
  await page.locator('#start').scrollIntoViewIfNeeded();
  await page.tap('#start');
  await expect(page.locator('#s-map')).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  await expect(page.locator('#run')).toBeVisible();
  await expect(page.locator('.hud-keys')).toBeHidden();
  await expect(page.locator('.attrib-map')).toBeVisible();

  const vp = page.viewportSize()!;
  const sx = Math.round(vp.width * 0.2), sy = Math.round(vp.height * 0.72);
  const before = await page.locator('#street').textContent();
  const p0 = await worldPos(page);
  const cdp = await touchPoints(page, 'touchStart', [{ x: sx, y: sy, id: 1 }]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + 50, y: sy, id: 1 }] });
  await expect(page.locator('#stick')).not.toHaveClass(/idle/);
  await page.waitForTimeout(600);
  const p1 = await worldPos(page);
  expect(Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y)).toBeGreaterThan(5);

  // second finger holds RUN while the stick is still down
  const runBox = (await page.locator('#run').boundingBox())!;
  const f1 = { x: sx + 50, y: sy, id: 1 }, f2 = { x: runBox.x + 40, y: runBox.y + 40, id: 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [f1, f2] });
  await expect(page.locator('#run')).toHaveClass(/(^| )on( |$)/);
  await expect(page.locator('#stick')).not.toHaveClass(/idle/);
  // lift the RUN finger only: RUN stops while the stick keeps going
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [f2] });
  await expect(page.locator('#run')).not.toHaveClass(/(^| )on( |$)/);
  await expect(page.locator('#stick')).not.toHaveClass(/idle/);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [f1] });
  await expect(page.locator('#stick')).toHaveClass(/idle/);
  expect(await page.locator('#street').textContent()).toBeTruthy();
  void before;

  await page.tap('#pause');
  await expect(page.locator('#paused')).toHaveClass(/show/);
  await expect(page.locator('#paused .rotate-hint').first()).toBeVisible();
  await page.tap('#resume');
  await expect(page.locator('#paused')).not.toHaveClass(/show/);
  expect(errs).toEqual([]);
});

test('phone: HUD fits the screen without clipping', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.tap('#to-location');
  await page.fill('#addr', '221 maple');
  await page.locator('.opt[data-i="0"]').tap();
  await page.locator('#start').scrollIntoViewIfNeeded();
  await page.tap('#start');
  await expect(page.locator('#s-map')).toBeVisible();
  const vp = page.viewportSize()!;
  for (const sel of ['.hud-char', '.hud-quest', '.hud-mini', '#pause', '#run', '.hud-street']) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5); expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
  }
});
