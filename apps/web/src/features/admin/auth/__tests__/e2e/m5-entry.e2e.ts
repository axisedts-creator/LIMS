// T0D-MSERIES-5 (LD-276) Playwright check of the live sign-in screen (done_when 7). NOT part of the vitest verify: it needs a running web app.
// Run: LIMS_E2E_WEB_URL=http://localhost:3000 pnpm --dir apps/web exec playwright test --config src/features/admin/auth/__tests__/e2e/playwright.config.ts
// Without LIMS_E2E_WEB_URL the suite fails on purpose (a skipped check is not a pass).
import { expect, test } from '@playwright/test';

const BASE = process.env.LIMS_E2E_WEB_URL ?? '';

test.beforeAll(() => {
  if (!BASE) throw new Error('set LIMS_E2E_WEB_URL (dev server or staging) to run the sign-in layout check');
});

for (const [name, width, height] of [['1440', 1440, 900], ['390', 390, 844]] as const) {
  test.describe(`sign-in at ${name} px`, () => {
    test.use({ viewport: { width, height } });

    test('no horizontal scroll', async ({ page }) => {
      await page.goto(`${BASE}/auth/login`);
      await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, 'scrollWidth - clientWidth').toBeLessThanOrEqual(0);
    });

    test('the board elements are on screen', async ({ page }) => {
      await page.goto(`${BASE}/auth/login`);
      await expect(page.getByText('Staff sign-in', { exact: true })).toBeVisible();
      await expect(page.getByLabel(/^work email/i)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeAttached();
      await expect(page.getByRole('img', { name: /96-well plate/ })).toBeAttached();
      expect(await page.locator('.lims-auth-chip').count()).toBe(3);
      expect(await page.locator('.lims-auth-well').count()).toBe(96);
      await expect(page.locator('.lims-auth-steps, .lims-art, .lims-auth-band')).toHaveCount(0);
    });
  });
}

test.describe('1440 px: form and button without scrolling', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('Work email, Password and Continue are inside the first screen', async ({ page }) => {
    await page.goto(`${BASE}/auth/login`);
    for (const loc of [page.getByLabel(/^work email/i), page.getByLabel('Password', { exact: true }), page.getByRole('button', { name: 'Continue' })]) {
      await expect(loc).toBeInViewport({ ratio: 1 });
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});

test.describe('reduced motion', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  test('the plate stays tilted and nothing animates', async ({ page }) => {
    await page.goto(`${BASE}/auth/login`);
    const info = await page.evaluate(() => {
      const plate = document.querySelector('.lims-auth-plate') as HTMLElement;
      const well = document.querySelector('.lims-auth-well') as HTMLElement;
      const chip = document.querySelector('.lims-auth-chip') as HTMLElement;
      return {
        plateAnim: getComputedStyle(plate).animationName, plateTransform: getComputedStyle(plate).transform,
        wellAnim: getComputedStyle(well).animationName, chipAnim: getComputedStyle(chip).animationName,
      };
    });
    expect([info.plateAnim, info.wellAnim, info.chipAnim]).toEqual(['none', 'none', 'none']);
    expect(info.plateTransform).not.toBe('none');
  });
});
