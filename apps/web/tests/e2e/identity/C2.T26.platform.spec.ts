// C2.T26 — nightly Playwright E2E for the platform console (PL-1..PL-8; AC-E1.1/E1.2/E1.3, AC-E2, AC-E3.1..E3.3, AC-E4.1/E4.6, US-E5, AC-E6). Not part of the per-task verify (needs a running stack).
// Stack contract: staff web at LIMS_E2E_WEB_URL, real C2 API + GoTrue (or an equivalent stub) behind LIMS_ORIGIN_API, synthetic data only:
//   super@platform.test / E2E-passphrase-101   platform_superadmin, TOTP enrolled (code = LIMS_E2E_TOTP, 6 digits), IP allowlisted
//   support@platform.test / E2E-passphrase-102 platform_support, TOTP enrolled (code = LIMS_E2E_TOTP_SUPPORT)
//   tenant admin of tenant `alpha`: admin@alpha.test / E2E-passphrase-201 (MFA code = LIMS_E2E_TOTP_ALPHA)
//   a seeded open dead letter (task identity.gotrue_signout) and an active tenant `alpha` with ≥1 branch, ≥1 centre
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, email: string, password: string, totp: string) {
  await page.goto('/auth/login');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('**/auth/mfa');
  await page.getByRole('textbox').first().click();
  await page.keyboard.type(totp);
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
}
const superLogin = (page: Page) => login(page, 'super@platform.test', 'E2E-passphrase-101', process.env.LIMS_E2E_TOTP ?? '000000');
const code = `synthetic_${Date.now().toString(36).slice(-6)}`;

test('PL-1 home shows the console label and the four tiles', async ({ page }) => {
  await superLogin(page);
  await page.goto('/platform');
  await expect(page.getByText('PLATFORM CONSOLE — the LIMS provider staff only')).toBeVisible();
  for (const t of [/tenants by status/i, /open dead letters/i, /active support sessions/i, /incomplete IRD annexes/i]) await expect(page.getByText(t)).toBeVisible();
});

test('a tenant admin cannot open the platform console (P-7): "Platform access only", no tenant data', async ({ page }) => {
  await login(page, 'admin@alpha.test', 'E2E-passphrase-201', process.env.LIMS_E2E_TOTP_ALPHA ?? '000000');
  await page.goto('/platform/tenants');
  await expect(page.getByText('Platform access only')).toBeVisible();
  await expect(page.getByRole('grid', { name: /tenants/i })).toHaveCount(0);
});

test('US-E1 provision a tenant: duplicate code is refused (AC-E1.2), a new code succeeds and shows the checklist + "Invitation sent" (AC-E1.1); activation without an accepted admin is refused (AC-E1.3)', async ({ page }) => {
  await superLogin(page);
  await page.goto('/platform/tenants/new');
  const fill = async (tenantCode: string) => {
    await page.getByLabel(/^tenant code/i).fill(tenantCode);
    await page.getByLabel(/^legal name/i).fill('Synthetic Gamma Pvt. Ltd.');
    await page.getByLabel(/^display name/i).fill('Synthetic Gamma Lab');
    await page.getByLabel(/branch code/i).fill('MAIN'); await page.getByLabel(/branch name/i).fill('Main Branch');
    await page.getByLabel(/centre code/i).fill('C01'); await page.getByLabel(/centre name/i).fill('Main Centre');
    await page.getByLabel(/centre type/i).selectOption('own');
    await page.getByLabel(/administrator email/i).fill(`admin@${tenantCode}.example.test`);
    await page.getByLabel(/administrator full name/i).fill('Synthetic Admin');
  };
  await fill('alpha');
  await page.getByRole('button', { name: /^provision tenant$/i }).click();
  await expect(page.getByText(/already (exists|in use|taken)|duplicate/i)).toBeVisible();
  await page.getByLabel(/^tenant code/i).fill(code);
  await page.getByRole('button', { name: /^provision tenant$/i }).click();
  await expect(page.getByText('Invitation sent')).toBeVisible();
  await page.goto('/platform/tenants');
  await page.getByRole('link', { name: new RegExp(code) }).click();
  await page.getByRole('button', { name: /^activate$/i }).click();
  const confirm = page.getByRole('dialog');
  if (await confirm.count()) await confirm.getByRole('button', { name: /^activate$/i }).click();
  await expect(page.getByText(/not ready/i)).toBeVisible();
});

test('US-E2 suspend with a reason, tenant users are refused, reactivate restores them', async ({ page, browser }) => {
  await superLogin(page);
  await page.goto('/platform/tenants');
  await page.getByRole('link', { name: /alpha/ }).first().click();
  await page.getByRole('button', { name: /^suspend/i }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: /reason/i }).fill('E2E suspension, ticket TCK-E2E');
  await page.getByRole('dialog').getByRole('button', { name: /^suspend/i }).click();
  await expect(page.getByText('Suspended').first()).toBeVisible();
  const tenantCtx = await browser.newContext();
  const tp = await tenantCtx.newPage();
  await tp.goto('/auth/login');
  await tp.getByLabel(/^email/i).fill('admin@alpha.test');
  await tp.getByLabel('Password', { exact: true }).fill('E2E-passphrase-201');
  await tp.getByRole('button', { name: 'Log in' }).click();
  await expect(tp.getByText('Access for your lab is currently suspended. Contact your lab administrator.')).toBeVisible();
  await tenantCtx.close();
  await page.getByRole('button', { name: /^reactivate$/i }).click();
  const confirm = page.getByRole('dialog');
  if (await confirm.count()) await confirm.getByRole('button', { name: /^reactivate$/i }).click();
  await expect(page.getByText('Active').first()).toBeVisible();
});

test('US-E3 IRD tracker: not_started offers only "In preparation" (AC-E3.3); submitting needs a date (AC-E3.1); B6 banner always visible (AC-E3.5)', async ({ page }) => {
  await superLogin(page);
  await page.goto('/platform/ird');
  await expect(page.getByText('Tracking only. IRD checklist and Annex 7 template are pending IRD clarification (B6).')).toBeVisible();
  await page.getByRole('button', { name: /alpha.*annex 7/i }).click();
  const p = page.getByRole('dialog').or(page.getByRole('complementary'));
  await expect(p.getByRole('button', { name: /^(mark )?completed/i })).toHaveCount(0);
  await p.getByRole('button', { name: /in preparation/i }).click();
  await p.getByRole('button', { name: /submitted/i }).click();
  await expect(page.getByRole('alert').first()).toBeVisible(); // submitted_on missing
});

test('US-E4 support session: open (read only, 30 min) → active card with countdown → Go to tenant admin shows the support banner → End', async ({ page }) => {
  await superLogin(page);
  await page.goto('/platform/support-sessions');
  await page.getByRole('button', { name: /open support session/i }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel(/^tenant/i).selectOption({ index: 1 }); // first real option = alpha (index 0 is the placeholder)
  await d.getByLabel(/^scope/i).selectOption('read_only');
  await d.getByLabel(/reason/i).fill('E2E check of the settings page, no patient details');
  await d.getByLabel(/ticket reference/i).fill('TCK-E2E-1');
  await d.getByRole('button', { name: /^open/i }).click();
  await expect(page.getByText('TCK-E2E-1')).toBeVisible();
  await page.getByRole('link', { name: /go to tenant admin/i }).click();
  await page.waitForURL('**/admin**');
  await expect(page.getByText(/The LIMS provider support is accessing this lab until/i)).toBeVisible();
  await page.goto('/platform/support-sessions');
  await page.getByRole('button', { name: /^end/i }).click();
  const confirm = page.getByRole('dialog');
  if (await confirm.count()) await confirm.getByRole('button', { name: /^end/i }).click();
  await expect(page.getByRole('link', { name: /go to tenant admin/i })).toHaveCount(0);
});

test('US-E4 AC-E4.6: without an active support session a platform user cannot reach tenant pages', async ({ page }) => {
  await superLogin(page);
  await page.goto('/admin/users');
  await expect(page.getByText(/support session|no access|don.t have access/i).first()).toBeVisible();
});

test('US-E5 dead letters: replay an open row with a note → state Replayed, buttons gone', async ({ page }) => {
  await superLogin(page);
  await page.goto('/platform/dead-letters');
  await page.getByRole('grid', { name: /dead letters?/i }).getByRole('link').first().click();
  await expect(page.getByText(/payload/i)).toHaveCount(0);
  await page.getByRole('button', { name: /^replay/i }).click();
  await page.getByRole('dialog').getByLabel(/note/i).fill('E2E replay');
  await page.getByRole('dialog').getByRole('button', { name: /^replay/i }).click();
  await expect(page.getByText('Replayed')).toBeVisible();
  await expect(page.getByRole('button', { name: /^replay/i })).toHaveCount(0);
});

test('US-E6 platform_support cannot open the staff screen; superadmin sees staff and sign-in events incl. platform_ip_denied rows with masked IPs', async ({ page }) => {
  await login(page, 'support@platform.test', 'E2E-passphrase-102', process.env.LIMS_E2E_TOTP_SUPPORT ?? '000000');
  await page.goto('/platform/staff');
  await expect(page.getByRole('grid', { name: /staff/i })).toHaveCount(0);
  await page.context().clearCookies();
  await superLogin(page);
  await page.goto('/platform/staff');
  await expect(page.getByRole('grid', { name: /staff/i })).toBeVisible();
  await page.goto('/platform/auth-events');
  await expect(page.getByRole('grid').first()).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?!\/)/); // list IPs are masked (last octet "x")
});
