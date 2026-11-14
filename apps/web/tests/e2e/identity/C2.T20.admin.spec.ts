// C2.T20 — nightly Playwright E2E for the tenant admin console (AD-1..AD-15, ME-1). Not part of the per-task verify (needs a running stack).
// Stack contract (extends C2.T12): staff web at LIMS_E2E_WEB_URL over a stub/real identity API with synthetic accounts:
//   admin@lab.test / E2E-passphrase-010 (lab_admin, aal2 via LIMS_E2E_TOTP, all centres)   viewer@lab.test / E2E-passphrase-011 (identity.user.read only)
// Covers: US-B1 invite flow, US-B4 lock dialog, US-B2 role editor privileged→MFA, US-D1/D2 audit list→entry, US-D4 export + requester-only download, US-G1 access review, permission gating, a11y.
import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';

const AXE_SRC = createRequire(__filename).resolve('axe-core/axe.min.js'); // axe-core is a web devDependency [PIN-C0]; @axe-core/playwright is not installed

async function login(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  if (email.startsWith('admin@')) {
    await page.waitForURL('**/auth/mfa');
    await page.getByRole('textbox').first().click();
    await page.keyboard.type(process.env.LIMS_E2E_TOTP ?? '000000');
    await page.getByRole('button', { name: 'Verify' }).click();
  }
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
}

test.describe('admin console', () => {
  test('nav shows the Administration group for an admin and hides items the viewer lacks', async ({ page }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto('/admin/users');
    const nav = page.getByRole('navigation');
    for (const n of ['Users', 'Roles', 'Branches', 'Audit log']) await expect(nav.getByRole('link', { name: n })).toBeVisible();
    await page.context().clearCookies();
    await login(page, 'viewer@lab.test', 'E2E-passphrase-011');
    await page.goto('/admin/users');
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toHaveCount(0); // permission-denied / not-found instead of data
  });

  test('US-B1 invite: form validation, hub-lab warning, success returns to the list with the new invited user', async ({ page }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto('/admin/users');
    await page.keyboard.press('n'); // `n` = primary New action (04-UI-UX §3)
    await expect(page).toHaveURL(/\/admin\/users\/new$/);
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await page.getByLabel(/^email/i).fill('test.user.e2e@example.test');
    await page.getByLabel(/full name/i).fill('Synthetic E2E User');
    await page.getByLabel(/roles/i).click();
    await page.getByRole('option', { name: /lab technician/i }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByText(/These roles receive or work on samples/)).toBeVisible();
    await page.getByRole('radio', { name: /all centres/i }).check();
    await page.keyboard.press('Control+Enter'); // Ctrl+Enter submits
    await expect(page).toHaveURL(/\/admin\/users(\/[0-9a-f-]{36})?$/);
    await page.goto('/admin/users?status=invited');
    await expect(page.getByText('Synthetic E2E User')).toBeVisible();
    await expect(page.getByText('test.user.e2e@example.test')).toHaveCount(0); // list masks emails
  });

  test('US-B4 lock dialog needs a reason; locked badge appears in the list', async ({ page }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto('/admin/users?status=active');
    await page.getByRole('row', { name: /Synthetic Sita Rai/ }).click();
    await page.getByRole('button', { name: /actions|more/i }).click();
    await page.getByRole('menuitem', { name: /^lock/i }).click();
    await expect(page.getByText('Locked users are logged out immediately and cannot log in until unlocked.')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /^lock/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible(); // not submitted without a reason
    await page.getByLabel(/reason/i).click();
    await page.getByRole('option', { name: 'Security concern' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^lock/i }).click();
    await expect(page.getByText('Locked').first()).toBeVisible();
  });

  test('US-B2 role editor: selecting a privileged permission forces MFA required', async ({ page }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto('/admin/roles/new');
    await page.getByLabel(/^name/i).fill('E2E privileged');
    await page.getByLabel(/^code/i).fill('e2e_privileged');
    await page.getByRole('checkbox', { name: 'lab.result.approve' }).check();
    const sw = page.getByRole('switch', { name: /mfa required/i });
    await expect(sw).toBeChecked();
    await expect(sw).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: 'platform.tenant.manage' })).toBeDisabled();
  });

  test('US-D1/D2 audit list → entry: 31-day cap, entry shows DiffTable and the recorded-view notice', async ({ page }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto('/admin/audit');
    await expect(page.getByRole('grid', { name: /audit/i })).toBeVisible();
    await page.goto('/admin/audit?occurred_at_from=2026-01-01T00:00:00Z&occurred_at_to=2026-11-01T00:00:00Z');
    await expect(page.getByText('Choose 31 days or fewer')).toBeVisible();
    await page.goto('/admin/audit');
    await page.getByRole('row').nth(1).click();
    await expect(page).toHaveURL(/\/admin\/audit\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Your viewing of this entry is recorded.')).toBeVisible();
    await expect(page.getByRole('table').getByText('changed').first()).toBeVisible();
  });

  test('US-D4 export: create → appears → requester can download a CSV; link never exposes a token', async ({ page, context }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto('/admin/exports');
    await page.getByRole('button', { name: /new export/i }).click();
    await expect(page.getByText(/every administrator of your lab is notified/)).toBeVisible();
    await page.getByRole('radio', { name: 'Audit log' }).check();
    await page.getByRole('button', { name: 'Create export' }).click();
    const dl = page.getByRole('link', { name: /download/i }).first();
    await expect(dl).toBeVisible({ timeout: 90_000 });
    const href = (await dl.getAttribute('href'))!;
    expect(href).toMatch(/^\/admin\/exports\/[0-9a-f-]{36}\/file$/);
    const res = await context.request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['content-disposition']).toMatch(/attachment/);
  });

  test('US-G1 access review: no export control; recording a review updates the banner', async ({ page }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto('/admin/access-review');
    await expect(page.getByRole('button', { name: /export|download|csv/i })).toHaveCount(0);
    await page.getByRole('button', { name: /record review completed/i }).click();
    await page.getByLabel(/notes/i).fill('Synthetic quarterly review');
    await page.getByRole('dialog').getByRole('button', { name: /record|confirm|save/i }).click();
    await expect(page.getByText(/Last review:/)).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: /Last review/ })).toHaveCount(0); // fresh review → no overdue warning
  });

  test('a11y: axe (WCAG 2.2 AA tags) is clean on the main admin screens', async ({ page }) => {
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    for (const p of ['/admin/users', '/admin/users/new', '/admin/roles', '/admin/centres', '/admin/settings', '/admin/sessions', '/admin/audit', '/admin/exports', '/admin/access-review', '/admin/me']) {
      await page.goto(p);
      await page.addScriptTag({ path: AXE_SRC });
      const violations = await page.evaluate(async () => (await (window as any).axe.run(document.body, { runOnly: ['wcag2a', 'wcag2aa', 'wcag22aa'] })).violations.map((v: any) => v.id as string));
      expect(violations.map((v: string) => `${p}: ${v}`), p).toEqual([]);
    }
  });
});
