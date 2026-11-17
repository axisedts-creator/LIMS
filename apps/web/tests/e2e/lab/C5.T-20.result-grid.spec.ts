// C5.T-20 nightly E2E — result entry grid, keyboard only (04-UI-UX §3.6/§3.7). ACs: AC-08.1, AC-11.1, AC-11.2. Not part of the per-task verify (needs `next dev` + browsers), same as C5.T-11/T-21.
// NEEDS (writer/lead): stub-c2.mjs session `sid-lab-tech` (lab.result.read + lab.result.enter + lab.result.verify, aal2) and a stubbed /v1/lab origin serving
// GET /v1/lab/orders/00000000-0000-7000-8000-000000000042/results (order REG0042: Hemoglobin HB pending, Leukocytes WBC pending, both in item CBC),
// POST /v1/lab/results/bulk-enter (ok per row), GET /v1/lab/results/{id}/history (3 approved Hb values), GET /v1/lab/patients/{pid}/analytes/{aid}/trend (>= 3 points).
// Until then these tests fail at the missing session/stub, the intended red state. Synthetic data only.
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const URL_ = '/lab/orders/00000000-0000-7000-8000-000000000042/results';

test('AC-08.1: type 13.4 in Hb, Enter → next row, Ctrl+S saves with one bulk-enter call; no mouse', async ({ page, context }) => {
  await useSid(context, 'sid-lab-tech');
  const bulk: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/bulk-enter')) bulk.push(r.url()); });
  await page.goto(URL_);
  const grid = page.getByRole('grid');
  await grid.getByRole('row', { name: /\bHB\b/ }).getByRole('gridcell').nth(1).focus(); // Value column (Analyte, Value, …)
  await page.keyboard.type('13.4');
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAccessibleName(/WBC|Leukocytes/i);
  await page.keyboard.type('7.2');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(grid.getByRole('row', { name: /\bHB\b/ }).getByText(/Resulted/)).toBeVisible();
  expect(bulk).toHaveLength(1);
});

test('AC-11.1 / AC-11.2: F2 shows the history panel, F3 the trend dialog, Esc closes it and focus returns to the cell', async ({ page, context }) => {
  await useSid(context, 'sid-lab-tech');
  await page.goto(URL_);
  const cell = page.getByRole('grid').getByRole('row', { name: /\bHB\b/ }).getByRole('gridcell').nth(1);
  await cell.focus();
  await page.keyboard.press('F2');
  await expect(page.getByText(/g_dl|g\/dL/).first()).toBeVisible();
  await page.keyboard.press('F2');
  await page.keyboard.press('F3');
  const dlg = page.getByRole('dialog', { name: /trend/i });
  await expect(dlg.locator('figure.lims-chart')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(cell).toBeFocused();
});

test('"?" lists the shortcuts; Alt+N without a worklist context does not navigate', async ({ page, context }) => {
  await useSid(context, 'sid-lab-tech');
  await page.goto(URL_);
  await page.getByRole('grid').getByRole('row', { name: /\bHB\b/ }).getByRole('gridcell').nth(1).focus();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toContainText('Ctrl+S');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+n');
  await expect(page).toHaveURL(new RegExp(URL_.replace(/\//g, '\\/')));
});
