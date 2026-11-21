// C12.T-24 nightly E2E — rules S13, waiting consumption S15, reports S17 through the real BFF + stub C2 + stubbed /v1/inventory.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions `sid-inventory-manager` (item.read + master.manage + cost.read + report.export, all centres), `sid-inventory-read` (item.read only, one centre);
// stubbed /v1/inventory/* with one current per_test rule (GLU on BIO-1 -> GLU-R1 x1), two unresolved facts for BIO-1/GLU, store BR1-MAIN, report fixtures for every report_code, and a CSV for export.csv.
// Until then these fail at the missing sessions/pages (intended red state).
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);

test.describe('S13 rules (AC-12.1, AC-12.6, AC-12.7, AC-14.2)', () => {
  test('choose a kind -> the guidance appears; Preview shows the deduction in a drawer; Save adds the rule to the list', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manager');
    await page.goto('/inventory/rules');
    await page.getByRole('button', { name: /^new rule$/i }).click();
    const dlg = page.getByRole('dialog', { name: /new consumption rule/i });
    await dlg.getByRole('radio', { name: /per qc observation/i }).check();
    await expect(dlg.getByText(/If you leave the analyte empty, this is deducted once for every analyte in every QC run\./)).toBeVisible();
    await dlg.getByRole('radio', { name: /per test/i }).check();
    await expect(dlg.getByText('Deducted once for each test on an order when its first result is verified.')).toBeVisible();
    await dlg.getByRole('combobox', { name: /^test/i }).fill('Glu');
    await page.getByRole('option', { name: /glucose|GLU/i }).first().click();
    await dlg.getByRole('combobox', { name: /^item/i }).fill('GLU');
    await page.getByRole('option', { name: /GLU-R1/ }).click();
    await dlg.getByRole('textbox', { name: /^quantity/i }).fill('2');
    await dlg.getByRole('button', { name: /^preview$/i }).click();
    await expect(page.getByRole('dialog', { name: /preview/i })).toContainText(/GLU-R1|glucose reagent/i);
    await page.keyboard.press('Escape');
    await dlg.getByRole('button', { name: /^save/i }).click();
    await expect(page.getByRole('grid')).toContainText('GLU-R1');
  });

  test('Change quantity shows the supersede copy; a read-only user sees neither New rule nor Change quantity', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manager');
    await page.goto('/inventory/rules');
    await page.getByRole('button', { name: /change quantity/i }).first().click();
    await expect(page.getByText('The old rule stops now. Earlier deductions are not changed.')).toBeVisible();
    await page.keyboard.press('Escape');
    await context.clearCookies();
    await useSid(context, 'sid-inventory-read');
    await page.goto('/inventory/rules');
    await expect(page.getByRole('button', { name: /^new rule$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /change quantity/i })).toHaveCount(0);
  });
});

test.describe('S15 waiting consumption (AC-12.9)', () => {
  test('post an unresolved deduction to a store: the row leaves the queue', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manager');
    await page.goto('/inventory/unresolved');
    await expect(page.getByText('These deductions could not be posted because no store is linked to the analyser and no default store is set.')).toBeVisible();
    const rows = page.getByRole('row').filter({ hasText: 'No store found' });
    const before = await rows.count();
    await rows.first().getByRole('button', { name: /post to store/i }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: /^store/i }).click();
    await page.getByRole('option', { name: /BR1-MAIN|store 1/i }).first().click();
    await dlg.getByRole('button', { name: /^(post|save|confirm)/i }).click();
    await expect(rows).toHaveCount(before - 1);
  });
  test('dismiss needs a reason from the fact_dismiss list', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manager');
    await page.goto('/inventory/unresolved');
    await page.getByRole('row').filter({ hasText: 'No store found' }).first().getByRole('button', { name: /^dismiss$/i }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: /^(dismiss|confirm|save)/i }).click();
    await expect(dlg).toBeVisible(); // reason missing: nothing happened
    await dlg.getByRole('button', { name: /^reason/i }).click();
    await page.getByRole('option', { name: 'Duplicate entry' }).click();
    await dlg.getByRole('button', { name: /^(dismiss|confirm|save)/i }).click();
    await expect(dlg).toBeHidden();
  });
});

test.describe('S17 reports (AC-21.1 – AC-21.9)', () => {
  test('tabs switch reports; CPT shows the footnote and the Breakdown drawer; an inventory manager sees Export CSV', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manager');
    await page.goto('/inventory/reports');
    await expect(page.getByRole('tab')).toHaveCount(7);
    await page.getByRole('tab', { name: 'Cost per test' }).click();
    await expect(page.getByText('CPT excludes wastage, expiry and count differences. See the Wastage report.')).toBeVisible();
    await page.getByRole('button', { name: /breakdown/i }).first().click();
    await expect(page.getByRole('dialog', { name: /breakdown/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Reconciliation' }).click();
    await expect(page.getByRole('grid')).toHaveCount(2);
    await expect(page.getByRole('link', { name: /export csv/i })).toBeVisible();
  });
  test('Export CSV downloads a CSV attachment (AC-21.8)', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manager');
    await page.goto('/inventory/reports?report=wastage');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /export csv/i }).click()]);
    expect(dl.suggestedFilename()).toMatch(/\.csv$/);
  });
  test('a read-only single-centre user: no Cost per test tab, no Reconciliation tab, no Export CSV (AC-21.9)', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-read');
    await page.goto('/inventory/reports');
    await expect(page.getByRole('tab', { name: 'Cost per test' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Reconciliation' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /export csv/i })).toHaveCount(0);
  });
  test('a period longer than 366 days shows the message at the date field', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manager');
    await page.goto('/inventory/reports?from=2024-01-01&to=2026-01-01');
    await expect(page.getByRole('group', { name: /period|date range|dates/i })).toContainText(/366|too (long|large|wide)|at most/i);
  });
});
