// T0D-UI-R04 — nightly Playwright E2E for the staff shell (10-DESIGN-SYSTEM §3). Not part of the per-task verify (needs a running stack).
// Stack contract: staff web at LIMS_E2E_WEB_URL, identity + frontdesk + lab API stub behind LIMS_ORIGIN_API, synthetic accounts:
//   lead@lab.test    / E2E-passphrase-101  (sees every group: Front desk, Lab, Reports, Accounts, Catalog, Instruments, People & access, Settings)
//   limited@lab.test / E2E-passphrase-102  (only lab.result.read -> a single "Lab" group; no Accounts, no People & access)
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

test('keyboard only: Tab reaches the rail links in order and Enter opens a page', async ({ page }) => {
  await login(page, 'lead@lab.test', 'E2E-passphrase-101');
  const links = await rail(page).getByRole('link').allInnerTexts();
  expect(links.length).toBeGreaterThan(3);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const seen: string[] = [];
  for (let i = 0; i < 60 && seen.filter((s) => links.includes(s)).length < links.length; i++) {
    await page.keyboard.press('Tab');
    seen.push((await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? '')) as string);
  }
  expect(seen.filter((s) => links.includes(s))).toEqual(links);
  const target = rail(page).getByRole('link').nth(1);
  await target.focus();
  const href = await target.getAttribute('href');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${href}/?$`));
  await expect(rail(page).locator('a[aria-current="page"]')).toHaveCount(1);
});

test('rail collapses 248 -> 72 px; every icon keeps its name and a tooltip', async ({ page }) => {
  await login(page, 'lead@lab.test', 'E2E-passphrase-101');
  const nav = rail(page);
  expect((await nav.boundingBox())!.width).toBeCloseTo(248, 0);
  await nav.getByRole('button', { name: /collapse/i }).click();
  await expect(nav).toHaveAttribute('data-collapsed', 'true');
  expect((await nav.boundingBox())!.width).toBeCloseTo(72, 0);
  for (const a of await nav.getByRole('link').all()) {
    const name = await a.evaluate((el) => (el as HTMLElement).innerText || el.getAttribute('aria-label') || '');
    expect(name.trim().length).toBeGreaterThan(0);
  }
  const first = nav.getByRole('link').first();
  await first.focus();
  await expect(page.getByRole('tooltip')).toHaveText((await first.textContent())!.trim());
  await first.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('a role without a permission sees no entry for it, and a direct visit shows the permission-denied page', async ({ page }) => {
  await login(page, 'limited@lab.test', 'E2E-passphrase-102');
  const nav = rail(page);
  await expect(nav.getByRole('group')).toHaveCount(1);
  await expect(nav.getByRole('group', { name: 'Lab' })).toBeVisible();
  for (const g of ['Accounts', 'People & access', 'Settings', 'Front desk']) await expect(nav.getByRole('group', { name: g })).toHaveCount(0);
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
