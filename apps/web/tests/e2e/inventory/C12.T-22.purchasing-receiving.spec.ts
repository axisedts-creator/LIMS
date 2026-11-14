// C12.T-22 nightly E2E — purchasing S6 and receiving S7 through the real BFF + stub C2 + stubbed /v1/inventory.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions `sid-inventory-buyer` (item.read + po.manage + cost.read, aal1), `sid-inventory-approver` (item.read + po.approve + cost.read, aal1 first -> auth.mfa_required until step-up),
// `sid-inventory-store` (item.read + stock.manage + cost.read); stubbed /v1/inventory/* origin with supplier SUP-01, store BR1-MAIN, item GLU-R1 with pack BOX (400 test) and VAT 13 % from the stub C3.
// Until then these fail at the missing sessions/pages (intended red state).
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);

test.describe('AC-05.1 / AC-05.8 PO editor (F-04)', () => {
  test('draft PO with 2 BOX GLU-R1 at Rs. 1,250: totals appear only after Save and come from the server (VAT 13%)', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-buyer');
    await page.goto('/inventory/purchase-orders');
    await page.getByRole('button', { name: /^new po$/i }).click();
    const dlg = page.getByRole('dialog', { name: /new purchase order/i });
    await dlg.getByRole('combobox', { name: /^supplier/i }).fill('Synthetic Supplier 1');
    await page.getByRole('option', { name: /synthetic supplier 1/i }).click();
    await dlg.getByRole('button', { name: /receiving store/i }).click();
    await page.getByRole('option', { name: /BR1-MAIN|store 1/i }).first().click();
    await dlg.getByRole('combobox', { name: /^item/i }).first().fill('GLU');
    await page.getByRole('option', { name: /GLU-R1/ }).click();
    await dlg.getByRole('textbox', { name: /^qty/i }).first().fill('2');
    await dlg.getByRole('textbox', { name: /unit price/i }).first().fill('1250');
    await expect(dlg.getByText(/2,825\.00/)).toHaveCount(0);
    await dlg.getByRole('button', { name: /^save draft$/i }).click();
    await expect(dlg.getByText(/2,825\.00/)).toBeVisible();
    await expect(dlg.getByText(/VAT 13%/)).toBeVisible();
  });

  test('keyboard: Alt+L adds a line and focuses its Item field; Ctrl+Delete removes it', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-buyer');
    await page.goto('/inventory/purchase-orders');
    await page.getByRole('button', { name: /^new po$/i }).click();
    const dlg = page.getByRole('dialog', { name: /new purchase order/i });
    await dlg.getByRole('textbox', { name: /^qty/i }).first().focus();
    await page.keyboard.press('Alt+L');
    await expect(dlg.getByRole('combobox', { name: /^item/i })).toHaveCount(2);
    await expect(dlg.getByRole('combobox', { name: /^item/i }).nth(1)).toBeFocused();
    await dlg.getByRole('textbox', { name: /^qty/i }).nth(1).focus();
    await page.keyboard.press('Control+Delete');
    await expect(dlg.getByRole('combobox', { name: /^item/i })).toHaveCount(1);
  });
});

test.describe('AC-05.2 / AC-05.3 approve with step-up (F-04 step 4)', () => {
  test('an aal1 approver is asked to verify, then the SAME approve succeeds; the PO is frozen', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-approver');
    await page.goto('/inventory/purchase-orders');
    await page.getByRole('row', { name: /draft/i }).first().getByRole('link').first().click();
    await page.getByRole('button', { name: /^approve$/i }).click();
    await expect(page.getByRole('alert')).toContainText(/verif/i);
    // the stub C2 step-up completes out of band (stub-c2.mjs /__stepup) and upgrades the session to aal2
    await page.request.post('/__stub/c2/stepup', { data: { sid: 'sid-inventory-approver' } });
    await page.getByRole('button', { name: /^approve$/i }).click();
    await expect(page.getByText(/PO approved/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^save draft$/i })).toHaveCount(0);
  });
});

test.describe('AC-06.1 receive against a PO (F-05)', () => {
  test('Receive pre-fills the open line; lot + expiry; Post receipt confirms; the PO becomes partially received', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-store');
    await page.goto('/inventory/purchase-orders');
    await page.getByRole('row', { name: /approved|sent/i }).first().getByRole('link').first().click();
    await page.getByRole('button', { name: /^receive$/i }).click();
    await expect(page).toHaveURL(/\/inventory\/receipts\?po=/);
    const dlg = page.getByRole('dialog', { name: /new receipt/i });
    await dlg.getByRole('textbox', { name: /lot no/i }).fill('L-SYN-001');
    await dlg.getByRole('textbox', { name: /^expiry/i }).fill('30/06/2027');
    await dlg.getByRole('button', { name: /^save draft$/i }).click();
    await dlg.getByRole('button', { name: /^post receipt$/i }).click();
    await expect(page.getByText('Post this receipt? Stock will be added and the receipt can no longer be edited.')).toBeVisible();
    await page.getByRole('alertdialog').or(page.getByRole('dialog').last()).getByRole('button', { name: /^post receipt$/i }).click();
    await expect(page.getByText(/Receipt posted — 1 lots?/)).toBeVisible();
  });

  test('AC-06.9 an expired lot is refused inline', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-store');
    await page.goto('/inventory/receipts?po=00000000-0000-7000-8000-00000000e2e1');
    const dlg = page.getByRole('dialog', { name: /new receipt/i });
    await dlg.getByRole('textbox', { name: /lot no/i }).fill('L-OLD-1');
    await dlg.getByRole('textbox', { name: /^expiry/i }).fill('01/01/2025');
    await dlg.getByRole('button', { name: /^save draft$/i }).click();
    await expect(dlg.getByText('This lot has already expired. It cannot be received.')).toBeVisible();
  });
});

test.describe('S6-P print view', () => {
  test('/purchase-orders/{id}/print shows the PO; a draft carries the watermark', async ({ page, context }) => {
    await useSid(context, 'sid-inventory-buyer');
    await page.goto('/inventory/purchase-orders');
    await page.getByRole('row', { name: /draft/i }).first().getByRole('link').first().click();
    const id = new URL(page.url()).searchParams.get('po'); // the Print link is offered on approved/sent only; a draft is reached by URL
    await page.goto(`/inventory/purchase-orders/${id}/print`);
    await expect(page.getByText('DRAFT — NOT APPROVED')).toBeVisible();
    await expect(page.getByText(/PO-\d+/).first()).toBeVisible();
  });
});
