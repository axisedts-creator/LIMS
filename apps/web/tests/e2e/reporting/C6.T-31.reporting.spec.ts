// C6.T-31 nightly E2E — staff reporting: worklist → detail → release, and the denied state (04-UI-UX §2.1, §2.2).
// C6-owned location + own config (./playwright.config.ts) so the C0 T0D-14 suite (tests/web-e2e) never matches it.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions — `sid-reporting-release` (reporting.report.read + .release), `sid-reporting-read`
// (reporting.report.read only), `sid-limited` (no reporting permission) — and a stubbed /v1/reporting/* origin serving
// one report R2611050001 (display_status ready_to_release) whose newest version is `rendered`. Until then these tests
// fail at the missing sessions/stub, which is the intended red state.
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);

test.describe('reporting worklist → detail → release', () => {
  test('ready-to-release row opens the detail and Release moves the version to released', async ({ page, context }) => {
    await useSid(context, 'sid-reporting-release');
    await page.goto('/reporting?tab=ready_to_release');
    const row = page.getByRole('row', { name: /R2611050001/ });
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: /R2611050001/ }).click();
    await expect(page).toHaveURL(/\/reporting\/reports\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: /^release$/i }).click();
    const dlg = page.getByRole('dialog');
    if (await dlg.isVisible()) await dlg.getByRole('button', { name: /^release$/i }).click();
    await expect(page.getByText(/released/i).first()).toBeVisible();
  });

  test('read-only user sees the worklist but no Release / bulk controls', async ({ page, context }) => {
    await useSid(context, 'sid-reporting-read');
    await page.goto('/reporting?tab=ready_to_release');
    await expect(page.getByRole('row', { name: /R2611050001/ })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('row', { name: /R2611050001/ }).getByRole('link', { name: /R2611050001/ }).click();
    await expect(page.getByRole('button', { name: /^release$/i })).toHaveCount(0);
  });
});

test.describe('denied state', () => {
  test('without reporting.report.read: permission-denied shown, no report data, no nav entry', async ({ page, context }) => {
    await useSid(context, 'sid-limited');
    await page.goto('/reporting');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await expect(page.getByText('R2611050001')).toHaveCount(0);
    await expect(page.getByRole('navigation').locator('a[href="/reporting"]')).toHaveCount(0);
  });
});
