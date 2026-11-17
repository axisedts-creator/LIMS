// T0D-UI-R04 — nightly Playwright E2E for the staff shell (10-DESIGN-SYSTEM §3).
// UPDATED by T0D-MSERIES-2 (LD-251): the 8-heading rail + 248/72 collapse became the 14-group accordion sidebar; keyboard, geometry, permission and drawer E2E moved to T0D-MSERIES-2.shell.spec.ts. Not part of the per-task verify (needs a running stack).
// Stack contract: staff web at LIMS_E2E_WEB_URL, identity + frontdesk + lab API stub behind LIMS_ORIGIN_API, synthetic accounts:
//   lead@lab.test    / E2E-passphrase-101  (sees many of the 13 tenant groups: Front desk, Laboratory, Reporting, Billing, Catalog, ...)
//   limited@lab.test / E2E-passphrase-102  (only lab.result.read -> a single "Laboratory" group; no Billing, no Admin)
// The stub knows barcode E2600000101 (order ORDER_ID below) and patients named "Demo Patient A/B".
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ORDER_ID = process.env.LIMS_E2E_ORDER_ID ?? '01a1a98a-ac40-7000-8000-0000000d00c9';

async function login(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
}
const rail = (page: Page) => page.getByRole('navigation', { name: 'Main' });
async function axeViolations(page: Page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const r = await (window as any).axe.run(document, { resultTypes: ['violations'] }); // includes colour contrast in a real browser
    return r.violations.filter((v: any) => v.impact === 'critical' || v.impact === 'serious').map((v: any) => `${v.id}: ${v.help}`);
  });
}

test('a direct visit to a page without the permission shows the permission-denied page', async ({ page }) => {
  await login(page, 'limited@lab.test', 'E2E-passphrase-102');
  await expect(rail(page).getByRole('group')).toHaveCount(1);
  await page.goto('/admin/users');
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
});

test('axe: expanded shell has no serious or critical violations (incl. colour contrast)', async ({ page }) => {
  await login(page, 'lead@lab.test', 'E2E-passphrase-101');
  expect(await axeViolations(page)).toEqual([]);
});

test('Ctrl+K focuses search from anywhere; a scanner burst on an empty page opens the order', async ({ page }) => {
  await login(page, 'lead@lab.test', 'E2E-passphrase-101');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.getByRole('searchbox').blur();
  await page.keyboard.type('E2600000101', { delay: 5 }); // wedge-speed burst
  await expect(page.getByRole('searchbox')).toHaveValue('E2600000101');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/frontdesk/orders/${ORDER_ID}$`));
});

test('the active centre is always visible in the top bar', async ({ page }) => {
  await login(page, 'lead@lab.test', 'E2E-passphrase-101');
  await expect(page.getByRole('banner').getByText(/centre/i).first()).toBeVisible();
});
