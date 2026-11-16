// T0D-MSERIES-4 (LD-266) — nightly Playwright check: the Find a screen field keeps its pill height at every sidebar height.
// Stack contract: same as T0D-MSERIES-2.shell.spec.ts (staff web at LIMS_E2E_WEB_URL, identity stub). Synthetic account: lead@lab.test / E2E-passphrase-101.
// Not part of the per-task verify (needs a running stack). jsdom has no layout, so only a browser can see the oval.
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 1280, height: 1400 }]) {
  test.describe(`viewport ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('Find a screen is a 46 px pill (never an oval), the list scrolls inside the sidebar, the user card stays pinned', async ({ page }) => {
      await login(page, 'lead@lab.test', 'E2E-passphrase-101');
      const nav = page.getByRole('navigation', { name: 'Main' });
      const search = nav.getByRole('searchbox', { name: 'Find a screen' });
      await expect(search).toBeVisible();
      const box = (await search.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.height).toBeLessThanOrEqual(48);
      expect(box.width).toBeGreaterThan(box.height * 4); // a pill, not an oval
      expect(await search.evaluate((el) => getComputedStyle(el).flexGrow)).toBe('0');
      // sidebar fills the viewport; the entry list is what scrolls
      expect((await nav.boundingBox())!.height).toBeCloseTo(viewport.height, 0);
      expect(await nav.locator('.lims-rail-scroll').evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
      const card = nav.getByTestId('user-card');
      await expect(card).toBeVisible();
      const cardBox = (await card.boundingBox())!;
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height + 1);
    });

    test('compact density: the field is 40 px', async ({ page }) => {
      await login(page, 'lead@lab.test', 'E2E-passphrase-101');
      await page.evaluate(() => document.documentElement.setAttribute('data-density', 'compact'));
      const box = (await page.getByRole('navigation', { name: 'Main' }).getByRole('searchbox', { name: 'Find a screen' }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.height).toBeLessThanOrEqual(44);
    });
  });
}
