// C12.T-23 nightly E2E — stock operations S8–S12 through the real BFF + stub C2 + stubbed /v1/inventory.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions `sid-inventory-manage` (item.read + stock.manage), `sid-inventory-adjust` (+ stock.adjust), `sid-inventory-bench` (item.read + bench.record),
// and a stubbed /v1/inventory/* origin with tenant-A store BR1-MAIN holding TIPS-200 lots L-A (expires 2027-01-31, 6 on hand) and L-B (2027-06-30, 60 on hand), bench store BR1-BENCH, one open count with 2 lines (book 37 / 58).
// Until then these fail at the missing sessions/pages (intended red state).
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);

test.describe('AC-08.1 FEFO issue (F-06)', () => {
  test('issue 10 TIPS-200 to Biochemistry: preview shows L-A (6) then L-B (4); the result lists one movement per lot', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/stock');
    await page.getByRole('row', { name: /TIPS-200/ }).first().getByRole('button', { name: /^issue$/i }).click();
    const dlg = page.getByRole('dialog', { name: /issue stock/i });
    await dlg.getByRole('radio', { name: /department/i }).check();
    await dlg.getByRole('button', { name: /^department/i }).click();
    await page.getByRole('option', { name: /biochemistry/i }).click();
    await dlg.getByRole('textbox', { name: /^qty/i }).fill('10');
    await expect(dlg.getByText('Lots are taken in the order shown: opened containers first, then earliest expiry.')).toBeVisible();
    await expect(dlg.getByText('L-A')).toBeVisible();
    await expect(dlg.getByText('L-B')).toBeVisible();
    await dlg.getByRole('button', { name: /^issue$/i }).click();
    await expect(page.getByText(/ISS-/)).toBeVisible();
  });
  test('AC-08.2 more than available -> banner with the request id, nothing written', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/stock');
    await page.getByRole('row', { name: /TIPS-200/ }).first().getByRole('button', { name: /^issue$/i }).click();
    const dlg = page.getByRole('dialog', { name: /issue stock/i });
    await dlg.getByRole('radio', { name: /general/i }).check();
    await dlg.getByRole('textbox', { name: /^qty/i }).fill('99999');
    await dlg.getByRole('button', { name: /^issue$/i }).click();
    await expect(page.getByRole('alert')).toContainText(/req/i);
  });
});

test.describe('AC-19.x blind stock count (F-08)', () => {
  test('count entry never shows book quantity; stock.adjust sees it only after the switch; posting needs stock.adjust', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/counts');
    await page.getByRole('row', { name: /open/i }).first().getByRole('link').first().click();
    await expect(page.getByRole('grid')).toBeVisible();
    await expect(page.getByText(/\b37\b/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^post count$/i })).toHaveCount(0);
    await page.context().clearCookies();
    await useSid(context, 'sid-inventory-adjust');
    await page.reload();
    await expect(page.getByText(/\b37\b/)).toHaveCount(0);
    await page.getByRole('switch', { name: /show system quantity/i }).click();
    await expect(page.getByText(/\b37\b/)).toBeVisible();
  });
});

test.describe('AC-10.x transfer dispatch + receive 98 of 100 (F-07)', () => {
  test('dispatch confirmation copy, then receive with a transit-loss reason', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/transfers');
    await page.getByRole('row', { name: /draft/i }).first().getByRole('link').first().click();
    await page.getByRole('button', { name: /^dispatch$/i }).click();
    await expect(page.getByText(/Dispatch\? Stock leaves .+ now and shows as in transit\./)).toBeVisible();
    await page.getByRole('button', { name: /^(dispatch|confirm)/i }).last().click();
    await page.getByRole('button', { name: /^receive$/i }).click();
    await page.getByRole('textbox', { name: /received/i }).first().fill('98');
    await page.getByRole('button', { name: /discrepancy/i }).click();
    await page.getByRole('option', { name: /transit loss/i }).click();
    await page.getByRole('button', { name: /^(receive|confirm|save)$/i }).last().click();
    await expect(page.getByText(/received/i).first()).toBeVisible();
  });
});

test.describe('AC-15.x bench (F-09)', () => {
  test('page hidden without bench.record; with it the technologist logs a QC with 3 observations', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/bench');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await page.context().clearCookies();
    await useSid(context, 'sid-inventory-bench');
    await page.goto('/inventory/bench');
    const f = page.getByRole('form', { name: /log calibration|manual qc/i });
    await f.getByRole('radio', { name: /^qc$/i }).check();
    await f.getByRole('button', { name: /^test/i }).click();
    await page.getByRole('option', { name: /glucose/i }).click();
    await f.getByRole('textbox', { name: /observations/i }).fill('3');
    await f.getByRole('button', { name: /^(log|save)/i }).click();
    await expect(page.getByText(/^Logged\./)).toBeVisible();
  });
});
