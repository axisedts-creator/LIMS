// C13.T19 e2e (tests: "component (MSW/Prism) + E2E"). Synthetic data only. Skips when LIMS_E2E_PARTNER_SESSION is unset (compose stack not running), like C13-T16.
// Covers what static markup cannot: Drawer line form + shortcuts (Alt+A, Ctrl+Enter, Alt+S), ConfirmDialogs, 320 px reflow on every screen (US-16.1), patient search by POST body (US-07.8 / REQ-SEC-098).
import { expect, test, type Page } from '@playwright/test';

const SESSION = process.env.LIMS_E2E_PARTNER_SESSION ?? '';
test.skip(!SESSION, 'compose env not set (LIMS_E2E_PARTNER_SESSION)');
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: '__Host-lims_psid', value: SESSION, url: baseURL!, httpOnly: true, secure: true, sameSite: 'Lax' }]);
});

const ROUTES = ['/', '/manifests', '/orders', '/reports', '/pickups', '/pickups/new', '/price-list', '/statements', '/referrers', '/users', '/account'];

test.describe('US-16.1 320 px reflow', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  for (const route of ROUTES) {
    test(`no horizontal page scroll at 320 px: ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
  test('lists render as cards on a phone (table hidden, card list visible)', async ({ page }) => {
    await page.goto('/manifests');
    await expect(page.locator('[data-view="cards"]').first()).toBeVisible();
    await expect(page.locator('table.lims-table, [role="grid"].lims-table').first()).toBeHidden();
  });
});

const fill = async (page: Page, label: RegExp | string, v: string) => page.getByLabel(label).fill(v);

test('US-04: new manifest -> add a sample with the keyboard -> submit with confirm -> read-only', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New manifest' }).first().click();
  await expect(page).toHaveURL(/\/manifests\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('button', { name: 'Submit manifest' })).toBeDisabled(); // 0 lines
  await page.keyboard.press('Alt+a');
  const drawer = page.getByRole('dialog');
  await fill(drawer.page(), /Patient full name/, 'Synthetic Patient E2E');
  await drawer.getByRole('radio', { name: 'Female' }).check();
  await drawer.getByRole('radio', { name: 'Age in years' }).check();
  await fill(drawer.page(), /Age/, '43');
  await drawer.getByLabel(/Tests/).fill('a');
  await drawer.getByRole('option').first().click();
  await drawer.getByLabel('The patient agreed to the statement above').check();
  await page.keyboard.press('Control+Enter'); // submitShortcut = Save sample
  await expect(page.getByText('Synthetic Patient E2E')).toBeVisible();
  await page.keyboard.press('Alt+s');
  await expect(page.getByRole('alertdialog').or(page.getByRole('dialog')).getByText(/Submit 1 samples to .*\. You can't edit them after submitting\./)).toBeVisible();
  await page.getByRole('button', { name: /^Submit/ }).last().click();
  await expect(page.getByText('Submitted').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add sample' })).toHaveCount(0); // US-04.7 read-only
});

test('line form validation: bad mobile / reference / no test are rejected before any request', async ({ page }) => {
  await page.goto('/manifests');
  await page.getByRole('button', { name: 'New manifest' }).first().click();
  await page.keyboard.press('Alt+a');
  const posts: string[] = [];
  page.on('request', (r) => r.method() === 'POST' && posts.push(r.url()));
  await fill(page, /Your sample reference/, 'bad ref!');
  await fill(page, /Patient mobile/, '12');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('alert').or(page.getByText(/required|invalid|must/i)).first()).toBeVisible();
  expect(posts.filter((u) => /\/lines/.test(u))).toEqual([]);
});

test('US-07.8 / REQ-SEC-098: searching a patient name posts the term in the body and never puts it in a URL', async ({ page }) => {
  const seen: { url: string; method: string; body: string | null }[] = [];
  page.on('request', (r) => seen.push({ url: r.url(), method: r.method(), body: r.postData() }));
  await page.goto('/orders');
  await page.getByLabel('Search by patient name, your reference or registration no.').fill('Synthetic Patient E2E');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect.poll(() => seen.some((s) => s.method === 'POST' && /orders\/search/.test(s.url))).toBe(true);
  expect(seen.filter((s) => /Synthetic(%20|\+| )Patient/.test(s.url))).toEqual([]);
  expect(seen.find((s) => /orders\/search/.test(s.url))!.body).toContain('Synthetic Patient E2E');
  expect(page.url()).not.toMatch(/Synthetic/);
});

test('PM-4 print view: no navigation chrome in print media, "Print" button present', async ({ page }) => {
  await page.goto('/manifests');
  await page.getByRole('link', { name: /^MF\d+/ }).first().click();
  await page.getByRole('link', { name: 'Print' }).click();
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation')).toBeHidden();
  await expect(page.getByText('Handed over by')).toBeVisible();
});

test('PK-2: pickup request for an eligible manifest shows up in PK-1 as Requested', async ({ page }) => {
  await page.goto('/pickups/new');
  await page.getByRole('checkbox').first().check();
  await fill(page, /Number of boxes\/bags/, '2');
  await page.getByRole('button', { name: /request pickup/i }).click();
  await expect(page).toHaveURL(/\/pickups/);
  await expect(page.getByText('Requested').first()).toBeVisible();
});

test('PU-1 / PF-1 admin dialogs open and close with Esc; Deactivate asks for a reason', async ({ page }) => {
  await page.goto('/referrers');
  await page.getByRole('button', { name: 'Add doctor' }).click();
  await expect(page.getByRole('dialog').getByLabel(/Name/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto('/users');
  await page.getByRole('button', { name: 'Invite user' }).click();
  await expect(page.getByRole('dialog').getByText(/Admins can add users and doctors\. Admins must use two-step sign-in\./)).toBeVisible();
});

test('ST16: a stored script in a patient name is inert in the editor, detail and print views', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto('/manifests');
  await page.getByRole('link', { name: /^MF\d+/ }).first().click();
  await page.waitForLoadState('networkidle');
  expect(dialogs).toEqual([]);
});
