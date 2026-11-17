// C3.T-35 nightly E2E — SCR-18/19 through the real BFF + stub C2 (browser leg of "export → edit → import → commit").
// Not part of the per-task verify (needs `next dev`, browsers, stub C2 sessions + a stubbed /v1/catalog origin — see C3.T-32.catalog.spec.ts header).
// Sessions: sid-catalog-read (catalog.test.read), sid-catalog-finance (read + price_list.read/manage, aal2), sid-catalog-manage (test.read/manage). Synthetic data only.
import { test, expect, type BrowserContext } from '@playwright/test';
import { Buffer } from 'node:buffer';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test.describe('SCR-18 gating (04-UI-UX §4, 08 A13 P-10)', () => {
  test('catalog.test.read only: history visible, no upload / kind radios; nav entry present', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-read');
    await page.goto('/catalog/imports');
    await expect(page.getByRole('navigation').locator('a[href="/catalog/imports"]')).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.locator('input[type=file]')).toHaveCount(0);
  });

  test('downloads are same-origin attachments with nosniff + no-store, and no storage URL / bearer token reaches the page (REQ-SEC-085, REQ-SEC-068)', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-finance');
    const auth: string[] = [];
    page.on('request', (r) => auth.push(r.headers()['authorization'] ?? ''));
    await page.goto('/catalog/imports');
    const res = await page.request.get('/catalog/import-templates/price_list');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toMatch(/^attachment/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(auth.filter(Boolean)).toEqual([]);
    expect((await page.request.get('/catalog/import-templates/not_a_kind')).status()).toBe(400);
  });
});

test.describe('F-16 → F-15 export → edit → import → commit', () => {
  test('finance exports, uploads an edited file, sees validated + stale-base, commits once', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-finance');
    await page.goto('/catalog/imports');
    await page.getByRole('radio', { name: /price list prices/i }).check();
    await page.getByLabel(/price list/i).click();
    await page.getByRole('option', { name: /PL-DRX/ }).click();
    await page.getByRole('button', { name: /download current data/i }).click();
    await expect(page.getByRole('link', { name: /^download$/i }).first()).toBeVisible({ timeout: 30_000 }); // export polled to ready (2 s cadence)

    // "edit in Excel": the stub API validates by sha256, so the fixture bytes are fixed
    await page.locator('input[type=file]').setInputFiles({ name: 'prices-edited.xlsx', mimeType: XLSX, buffer: Buffer.from('PK\u0003\u0004synthetic-edited') });
    await page.getByRole('button', { name: /^upload/i }).click();
    await expect(page).toHaveURL(/\/catalog\/imports\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Ready to commit').first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /^commit/i }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('textbox', { name: /change reason/i }).fill('Replace with edited Q4 prices');
    await d.getByRole('textbox', { name: /confirm/i }).fill('PL-DRX');
    const go = d.getByRole('button', { name: /^commit$/i });
    if (await d.getByRole('checkbox', { name: /changed after this file was exported/i }).count()) {
      await expect(go).toBeDisabled();
      await d.getByRole('checkbox', { name: /changed after this file was exported/i }).check();
    }
    await expect(go).toBeEnabled();
    await go.dblclick(); // one commit only (AC-16.7)
    await expect(page.getByText(/^Committed$/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: /version|view/i }).first()).toHaveAttribute('href', /\/catalog\/price-lists\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}/);
  });
});
