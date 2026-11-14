// C5.T-21 nightly E2E — staff verification queue (bulk verify, flagged-row acknowledgement, outcome dialog) and approval queue (aal1 step-up).
// ACs: AC-15.2, AC-16.3. Not part of the per-task verify (needs `next dev` + browsers), same as C5.T-11. Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions — `sid-lab-verifier` (lab.result.verify + .read, aal2), `sid-pathologist-aal1` (lab.result.approve + .read, aal1),
// `sid-limited` (lab permissions without lab.result.verify / lab.result.approve) — and a stubbed /v1/lab origin serving: GET /v1/lab/verification-queue (stage=verify)
// with REG0001 (flagged, needs acknowledgement of one flag) + REG0002 (unflagged) + one id the bulk call answers `common.not_found`; stage=approve with REG0003;
// POST /v1/lab/results/bulk-verify → results[]{id,outcome,code}; POST /v1/lab/results/bulk-approve → 403 auth.mfa_required for aal1 sessions.
// Until then these tests fail at the missing sessions/stub, which is the intended red state.
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);

test.describe('verification queue', () => {
  test('AC-15.2: flagged row needs each flag acknowledged; bulk verify → outcome dialog lists per-id done / not done incl. not found', async ({ page, context }) => {
    await useSid(context, 'sid-lab-verifier');
    await page.goto('/lab/verification');
    const flagged = page.getByRole('row', { name: /REG0001/ });
    await flagged.getByRole('checkbox', { name: /^select/i }).check();
    const verify = page.getByRole('button', { name: /^verify\s*\d+$/i });
    await expect(verify).toBeDisabled(); // unacknowledged flag blocks the bulk action
    for (const box of await flagged.getByRole('checkbox', { name: /^acknowledge/i }).all()) await box.check();
    await expect(verify).toBeEnabled();
    await page.getByRole('checkbox', { name: /select all/i }).check();
    await verify.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/\d+ done, \d+ not done/)).toBeVisible();
    await expect(dialog.getByText(/not found/i)).toBeVisible(); // `common.not_found` shown as readable text, per id
    expect(await dialog.textContent()).not.toMatch(/common\.not_found/); // raw code never rendered
    await dialog.getByRole('button', { name: /close|done|ok/i }).click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('approval queue', () => {
  test('AC-16.3: aal1 session → bulk approve → "Verify now" banner (auth.mfa_required), nothing approved', async ({ page, context }) => {
    await useSid(context, 'sid-pathologist-aal1');
    await page.goto('/lab/approval');
    await page.getByRole('checkbox', { name: /select all/i }).check();
    await page.getByRole('button', { name: /^approve\s*\d+$/i }).click();
    const banner = page.getByRole('alert');
    await expect(banner.getByRole('button', { name: /verify now/i })).toBeVisible();
    expect(await page.locator('body').textContent()).not.toMatch(/auth\.mfa_required/);
    await expect(page.getByRole('dialog')).toHaveCount(0); // no outcome dialog until step-up succeeds
  });
});

test.describe('denied state', () => {
  test('without lab.result.verify / lab.result.approve: no action button', async ({ page, context }) => {
    await useSid(context, 'sid-limited');
    for (const path of ['/lab/verification', '/lab/approval']) {
      await page.goto(path);
      await expect(page.getByRole('button', { name: /^(verify|approve)\s*\d*$/i })).toHaveCount(0);
    }
  });
});
