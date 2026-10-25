import type { Page } from '@playwright/test';

export function collectErrors(page: Page) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  return errs;
}

export async function noHorizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
}

export async function worldPos(page: Page) {
  return page.locator('#player').evaluate((el) => ({ x: Number((el as HTMLElement).dataset.x), y: Number((el as HTMLElement).dataset.y) }));
}
