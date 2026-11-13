// SR-T19 nightly E2E — SR-02 Summary review (04-UI-UX SR-02; AC-14.2, AC-14.3, AC-14.4, AC-14.5, AC-14.7). Synthetic data only.
// C14-owned location + own config (./playwright.config.ts). Not part of the per-task verify (needs `next dev` + browsers).
// NEEDS (writer/lead): stub-c2.mjs sessions `sid-smartreport-approver` (smartreport.summary.read + .approve + lab.result.read) and a stubbed
// /v1/smartreport origin with three draft summaries: `...a001` (approve -> 200 approved), `...a002` (approve -> 409 smartreport.summary_superseded),
// `...a003` (reject -> 200), plus GET /coded-sets/summary_reject_reasons and one approved summary `...a004` with reviews[] [built, approved].
// Until then these tests fail at the missing session/stub, which is the intended red state.
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const SUMMARY = (n: string) => `/smartreport/summaries/01940e00-0000-7000-8000-00000000${n}`;
const APPROVED_BANNER = /Approved\. The PDF report will include this summary the next time it is generated\./;
const SUPERSEDED_BANNER = 'Results changed after this summary was built. A new summary will be prepared.';

test.describe('SR-02 review', () => {
  test.beforeEach(async ({ context }) => useSid(context, 'sid-smartreport-approver'));

  test('approve -> approved banner with an "Open order results" link (AC-14.2)', async ({ page }) => {
    await page.goto(SUMMARY('a001'));
    await page.getByRole('button', { name: /^approve$/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^approve$/i }).click();
    await expect(page.getByText(APPROVED_BANNER)).toBeVisible();
    await expect(page.getByRole('link', { name: /open order results/i })).toHaveAttribute('href', /\/lab\/orders\/[0-9a-f-]{36}\/results$/);
  });

  test('approve of a superseded draft -> warning banner stays visible, with a link to the queue (AC-14.3)', async ({ page }) => {
    await page.goto(SUMMARY('a002'));
    await page.getByRole('button', { name: /^approve$/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^approve$/i }).click();
    await expect(page.getByRole('alert')).toContainText(SUPERSEDED_BANNER);
    await page.waitForTimeout(1000); // no router.refresh may wipe it (review item 1)
    await expect(page.getByRole('alert')).toContainText(SUPERSEDED_BANNER);
    await expect(page.getByRole('link', { name: /summaries|queue/i }).first()).toHaveAttribute('href', /\/smartreport\/summaries$/);
  });

  test('reject with a reason (AC-14.4)', async ({ page }) => {
    await page.goto(SUMMARY('a003'));
    await page.getByRole('button', { name: /^reject$/i }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel(/reason/i).click();
    await page.getByRole('option').first().click();
    await dlg.getByRole('button', { name: /^reject$/i }).click();
    await expect(page.getByText(/rejected/i).first()).toBeVisible();
  });

  test('History lists the reviews[] items oldest first (AC-14.7)', async ({ page }) => {
    await page.goto(SUMMARY('a004'));
    const items = page.getByRole('region', { name: /history/i }).getByRole('listitem');
    await expect(items.first()).toContainText(/built/i);
    await expect(items.nth(1)).toContainText(/approved/i);
  });
});
