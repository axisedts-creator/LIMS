// C5.T-10 nightly E2E — label page print preview (PRD AC-02.1, AC-02.4; 04-UI-UX §3.1). Own config (./playwright.config.ts) so the C0 T0D-14 suite (tests/web-e2e) never matches it.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs session `sid-lab-labels` (lab.specimen.label_print) and a stubbed /v1/lab origin: POST /orders/{id}/label-prints -> 200 with two ready specimens
// (E2600000101, E2600000102), POST /specimens/labels -> labels (copies 1) with size { width_mm: 60, height_mm: 30 }, label_copies_default 1. The order id below is a fixture constant.
// Snapshot baseline (`label-preview-print.png`) is generated once with `--update-snapshots` by the lead; until then toHaveScreenshot is the intended red state.
import { test, expect, type BrowserContext } from '@playwright/test';

const ORDER = '01a1a98a-ac40-7000-8000-000000000001';
const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const MM = 96 / 25.4; // CSS px per mm

test.describe('label page print preview', () => {
  test.beforeEach(async ({ page, context }) => {
    await useSid(context, 'sid-lab-labels');
    // count the print dialog (window.print) without opening it
    await page.addInitScript(() => { (window as any).__prints = 0; window.print = () => { (window as any).__prints += 1; }; });
  });

  test('opens the print dialog once; print media shows only the labels, sized 60x30 mm from the API response', async ({ page }) => {
    await page.goto(`/lab/orders/${ORDER}/labels`);
    await expect(page.locator('[data-testid="label"]')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => (window as any).__prints)).toBe(1);

    await page.emulateMedia({ media: 'print' });
    const region = page.locator('[data-testid="print-region"]');
    await expect(region).toBeVisible();                                      // hidden on screen, visible in print
    const box = await page.locator('[data-testid="label"]').first().boundingBox();
    expect(Math.abs(box!.width - 60 * MM)).toBeLessThan(2);
    expect(Math.abs(box!.height - 30 * MM)).toBeLessThan(2);
    await expect(page.getByRole('button', { name: /print labels/i })).toBeHidden(); // chrome is not printed
    await expect(page.locator('[data-testid="label"]').first().locator('svg')).toBeVisible(); // Code 128 barcode
    await expect(page.locator('[data-testid="label"]').first()).toContainText('E2600000101');
    await expect(page.locator('[data-testid="label"]').first()).toHaveScreenshot('label-preview-print.png');
  });

  test('screen media: print region hidden, the specimen list and "Print labels" are shown; the print count stays 1', async ({ page }) => {
    await page.goto(`/lab/orders/${ORDER}/labels`);
    await expect(page.getByRole('button', { name: /print labels/i })).toBeVisible();
    await expect(page.locator('[data-testid="print-region"]')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).__prints)).toBe(1);
  });
});
