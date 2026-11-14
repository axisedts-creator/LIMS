// RM-T05 — nightly Playwright E2E for applying a role pack from the admin console (11-ROLE-MATRIX §8, LD-141). Not part of the per-task verify (needs a running stack).
// Stack contract = C2.T20.admin.spec.ts: admin@lab.test (identity.role.manage, aal2) and viewer@lab.test (identity.user.read only).
// The screen URL comes from contracts/routes.yaml (CR-C2-RM-001); no path is hard-coded here.
// Covers: diff shown before save (nothing written until Apply), role without identity.role.manage cannot open it, axe.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse } from 'yaml';

const AXE_SRC = createRequire(__filename).resolve('axe-core/axe.min.js');
const SCREEN = (parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'contracts', 'routes.yaml'), 'utf8')).routes as any[])
  .find((r) => r.origin === 'staff_web' && r.owner === 'C2' && /^\/admin\/roles\/[^{]*pack/i.test(r.path))?.path as string;

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
const axe = async (page: Page) => {
  await page.addScriptTag({ path: AXE_SRC });
  const v = await page.evaluate(async () => (await (window as any).axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map((x: any) => x.id));
  expect(v).toEqual([]);
};

test.describe('role packs', () => {
  test('route for the screen exists in contracts/routes.yaml', () => { expect(SCREEN).toBeTruthy(); });

  test('admin picks a pack: the diff is shown first and nothing is written until Apply', async ({ page }) => {
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && /\/v1\/identity\//.test(r.url())) writes.push(`${r.method()} ${r.url()}`); });
    await login(page, 'admin@lab.test', 'E2E-passphrase-010');
    await page.goto(SCREEN);
    await expect(page.getByRole('heading', { level: 1, name: /role pack/i })).toBeVisible();
    await page.getByRole('radio', { name: /elabcorp/i }).check();
    const diff = page.getByRole('region', { name: /diff/i }).or(page.getByRole('group', { name: /diff/i }));
    await expect(diff).toBeVisible();
    await expect(diff).not.toContainText(/remov|revok|delet/i); // R6: re-apply never removes
    expect(writes).toEqual([]);
    await page.getByRole('button', { name: /^apply/i }).click();
    await expect(page.getByText(/applied|success/i).first()).toBeVisible();
    expect(writes.length).toBe(1);
    // re-apply: the diff now has nothing to apply
    await page.reload();
    await page.getByRole('radio', { name: /elabcorp/i }).check();
    await expect(page.getByRole('region', { name: /diff/i }).or(page.getByRole('group', { name: /diff/i }))).toContainText(/no changes|nothing to apply|already applied/i);
    await expect(page.getByRole('button', { name: /^apply/i })).toBeDisabled();
    await axe(page);
  });

  test('a role without identity.role.manage cannot open it (no packs, no Apply)', async ({ page }) => {
    await login(page, 'viewer@lab.test', 'E2E-passphrase-011');
    await page.goto('/admin/roles');
    await expect(page.getByRole('link', { name: /role pack/i })).toHaveCount(0); // no entry point either
    await page.goto(SCREEN);
    await expect(page.getByRole('button', { name: /^apply/i })).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
  });
});
