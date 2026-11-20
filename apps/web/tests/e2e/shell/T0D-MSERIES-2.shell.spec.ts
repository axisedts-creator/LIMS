// T0D-MSERIES-2 — nightly Playwright E2E for the M series staff shell (13-M-SERIES s3, LD-251). Not part of the per-task verify (needs a running stack).
// Stack contract: same as T0D-UI-R04.shell.spec.ts (staff web at LIMS_E2E_WEB_URL, identity + frontdesk + lab API stub). Synthetic accounts:
//   lead@lab.test    / E2E-passphrase-101  (sees many groups, among them Front desk, Laboratory)
//   limited@lab.test / E2E-passphrase-102  (only lab.result.read -> a single "Laboratory" group; no Admin, no Billing)
// Sidebar contract: see src/core/shell/__tests__/m2.sidebar.test.tsx (nav "Main", group buttons with aria-expanded, searchbox "Find a screen", "Open menu" button).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function login(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
}
const side = (page: Page) => page.getByRole('navigation', { name: 'Main' });
async function axeViolations(page: Page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const r = await (window as any).axe.run(document, { resultTypes: ['violations'] }); // includes colour contrast in a real browser
    return r.violations.filter((v: any) => v.impact === 'critical' || v.impact === 'serious').map((v: any) => `${v.id}: ${v.help}`);
  });
}
const focused = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? '');

test.describe('wide viewport (sidebar fixed)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('geometry: sidebar 296 px, top bar 76 px, sidebar as tall as the viewport, list scrolls inside', async ({ page }) => {
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    expect((await side(page).boundingBox())!.width).toBeCloseTo(296, 0);
    expect((await side(page).boundingBox())!.height).toBeCloseTo(900, 0);
    expect((await page.getByRole('banner').boundingBox())!.height).toBeGreaterThanOrEqual(76);
    expect(await side(page).locator('.lims-rail-scroll').evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    await expect(side(page).getByRole('searchbox', { name: 'Find a screen' })).toBeVisible(); // never scrolls away
    await expect(side(page).getByTestId('user-card')).toBeVisible();
  });

  test('keyboard only: Tab reaches Find a screen and every entry of the open group, Enter on a group header opens it, Enter on an entry navigates', async ({ page }) => {
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    const open = side(page).locator('button[aria-expanded="true"]').first();
    const group = side(page).getByRole('group').filter({ has: open });
    const names = await group.getByRole('link').allInnerTexts();
    expect(names.length).toBeGreaterThan(0);
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    const seen: string[] = [];
    for (let i = 0; i < 120 && !names.every((n) => seen.includes(n.trim())); i++) {
      await page.keyboard.press('Tab');
      seen.push(await focused(page));
    }
    for (const n of names) expect(seen, n).toContain(n.trim());
    const target = group.getByRole('link').first();
    await target.focus();
    const href = await target.getAttribute('href');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${href}/?$`));
    await expect(side(page).locator('a[aria-current="page"]')).toHaveCount(1);
  });

  test('focus outline in the sidebar is 3 px accent.pop with a 2 px offset', async ({ page }) => {
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    await side(page).getByRole('searchbox', { name: 'Find a screen' }).focus();
    await page.keyboard.press('Tab');
    const o = await page.evaluate(() => { const s = getComputedStyle(document.activeElement as Element); return { w: s.outlineWidth, off: s.outlineOffset, c: s.outlineColor }; });
    expect(o.w).toBe('3px');
    expect(o.off).toBe('2px');
    expect(o.c).toBe('rgb(228, 242, 57)'); // accent.pop #E4F239
  });

  test('one group at a time; opening a group scrolls it to the top of the list', async ({ page }) => {
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    const headers = side(page).locator('button[aria-expanded]');
    const n = await headers.count();
    expect(n).toBeGreaterThan(2);
    await headers.nth(n - 1).click();
    await expect(side(page).locator('button[aria-expanded="true"]')).toHaveCount(1);
    await expect(headers.nth(n - 1)).toHaveAttribute('aria-expanded', 'true');
    const box = await headers.nth(n - 1).boundingBox();
    const list = await side(page).locator('.lims-rail-scroll').boundingBox();
    expect(Math.abs(box!.y - list!.y)).toBeLessThan(80); // group header at the top of the scroller
  });

  test('a role without a permission sees no entry for it (limited: one group, no Admin/Billing), and a direct visit shows permission denied', async ({ page }) => {
    await login(page, 'limited@lab.test', 'E2E-passphrase-102');
    await expect(side(page).getByRole('group')).toHaveCount(1);
    await expect(side(page).getByRole('group', { name: 'Laboratory' })).toBeVisible();
    for (const g of ['Admin', 'Billing', 'Front desk', 'Platform']) await expect(side(page).getByRole('group', { name: g })).toHaveCount(0);
    await page.goto('/admin/users');
    await expect(page.getByText("You don't have access to this page")).toBeVisible();
  });

  test('Find a screen filters as you type, expands the groups with matches, and says so when nothing matches', async ({ page }) => {
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    const box = side(page).getByRole('searchbox', { name: 'Find a screen' });
    await box.fill('work');
    const links = await side(page).locator('li[data-entry-id] > a:visible').allInnerTexts();
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.toLowerCase()).toContain('work');
    await expect(side(page).locator('li[data-subheading]:visible')).toHaveCount(0);
    await box.fill('zzzz-no-such-screen');
    await expect(side(page).getByText('No screen matches this search.')).toBeVisible();
    await box.fill('');
    await expect(side(page).locator('button[aria-expanded="true"]')).toHaveCount(1);
  });

  test('axe: no serious or critical violation (incl. colour contrast on the green sidebar and the lime pill)', async ({ page }) => {
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    expect(await axeViolations(page)).toEqual([]);
    await side(page).getByRole('searchbox', { name: 'Find a screen' }).fill('work');
    expect(await axeViolations(page)).toEqual([]);
  });

  test('the sign-in screen: hero, logo, white card, one primary button; axe clean', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('img', { name: 'Metro Labs' })).toBeVisible();
    await expect(page.locator('.lims-auth-card .lims-btn-primary')).toHaveCount(1);
    expect(await axeViolations(page)).toEqual([]);
  });
});

test.describe('narrow viewport (below 1024 px: drawer)', () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test('the sidebar is hidden, the menu button opens it as a drawer with trapped focus, Escape closes it', async ({ page }) => {
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    await expect(side(page)).toBeHidden();
    const menu = page.getByRole('banner').getByRole('button', { name: 'Open menu' });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(side(page)).toBeVisible();
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('nav[aria-label="Main"]')), `Tab #${i + 1} left the drawer`).toBe(true);
    }
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(side(page)).toBeHidden();
    await expect(menu).toBeFocused();
  });

  test('the menu button is not shown at 1024 px and up', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await login(page, 'lead@lab.test', 'E2E-passphrase-101');
    await expect(page.getByRole('banner').getByRole('button', { name: 'Open menu' })).toBeHidden();
    await expect(side(page)).toBeVisible();
  });
});
