// C12.T-21 nightly E2E — master data S2-S5, S14 through the real BFF + stub C2 + stubbed /v1/inventory.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions `sid-inventory-read` (inventory.item.read) and `sid-inventory-manage` (read + master.manage),
// and a stubbed /v1/inventory/* origin with one tenant-A item GLU-R1, store BR1-ST1, supplier SUP-01. Until then these fail at the missing sessions (intended red state).
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const navLink = (page: Page, href: string) => page.getByRole('navigation').locator(`a[href="${href}"]`);

test.describe('route gating (04-UI-UX §1)', () => {
  test('read: Items, Stores, Suppliers render; no "New" buttons', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-read');
    for (const [path, h] of [['/inventory/items', /items/i], ['/inventory/stores', /stores/i], ['/inventory/suppliers', /suppliers/i]] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: h })).toBeVisible();
      await expect(page.getByRole('button', { name: /^new /i })).toHaveCount(0);
    }
  });
  test('no inventory.item.read: nav hidden, direct visit shows permission-denied', async ({ page, context }) => {
    await useSid(context, 'sid-limited');
    await page.goto('/inventory/items');
    await expect(navLink(page, '/inventory/items')).toHaveCount(0);
    await expect(page.getByTestId('permission-denied')).toBeVisible();
  });
});

test.describe('AC-01.1 / AC-01.2 create item, duplicate code', () => {
  test('create GLU-R9 in the drawer, then create it again -> "Code already used"', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/items');
    for (const attempt of [1, 2]) {
      await page.getByRole('button', { name: /^new item$/i }).click();
      await page.getByRole('textbox', { name: /^code/i }).fill('glu-r9');
      await page.getByRole('textbox', { name: /^name/i }).fill('Synthetic glucose reagent 9');
      await page.getByRole('button', { name: /^save$/i }).click();
      if (attempt === 1) await expect(page.getByRole('dialog')).toBeHidden();
      else await expect(page.getByRole('alert')).toContainText(/code already used/i);
    }
    await expect(page.getByRole('textbox', { name: /^code/i })).toHaveValue('GLU-R9'); // upper-cased on blur
  });
});

test.describe('scanner add-barcode (S3 Barcodes tab)', () => {
  test('keyboard-wedge scan + Enter adds the barcode, field clears, value never in the URL', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/items');
    await page.getByRole('link', { name: 'GLU-R1' }).click();
    await page.getByRole('tab', { name: /^barcodes$/i }).click();
    const f = page.getByRole('textbox', { name: /scan or type barcode/i });
    await f.pressSequentially('syn-e2e-0001', { delay: 5 });
    await f.press('Enter');
    await expect(page.getByText('SYN-E2E-0001')).toBeVisible();
    await expect(f).toHaveValue('');
    expect(page.url()).not.toMatch(/syn-e2e-0001/i);
  });
});

test.describe('AC-03.1 default consumption store, AC-04.2 supplier price', () => {
  test('stores list shows exactly one Default badge', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/stores');
    await expect(page.getByText(/^default$/i)).toHaveCount(1);
  });
  test('supplier item price 4500 is saved as 450000 paisa and shown as Rs 4,500', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-manage');
    await page.goto('/inventory/suppliers');
    await page.getByRole('row', { name: /SUP-01/ }).click();
    await page.getByRole('tab', { name: /^items$/i }).click();
    await page.getByRole('button', { name: /add item|set item|link item/i }).click();
    await page.getByRole('combobox', { name: /item/i }).fill('GLU');
    await page.getByRole('option', { name: /GLU-R1/ }).click();
    await page.getByRole('button', { name: /pack/i }).click();
    await page.getByRole('option', { name: /BOX/ }).click();
    await page.getByRole('textbox', { name: /last price/i }).fill('4500');
    await page.getByRole('textbox', { name: /lead time/i }).fill('7');
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByRole('row', { name: /GLU-R1/ })).toContainText('4,500');
  });
});
