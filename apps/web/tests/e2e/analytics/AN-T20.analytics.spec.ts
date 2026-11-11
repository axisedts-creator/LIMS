// AN-T20 nightly E2E — analytics exports and schedules (04-UI-UX §6–§8; US-17.1/.4/.7, US-18.1/.2).
// C8-owned location + own config (./playwright.config.ts) so the C0 T0D-14 suite (tests/web-e2e) never matches it.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): a stub-c2.mjs session `sid-analytics-owner` (analytics.dashboard.read + analytics.data.export + analytics.schedule.manage)
// and a stubbed /v1/analytics/* origin that serves: GET /reports/income, POST /exports (202 -> export `queued`, then `ready` on the next list),
// GET /exports, GET /exports/{id}/file (xlsx bytes, Content-Disposition attachment), GET/POST /schedules, GET/PUT /schedules/{id}
// (PUT answers 409 `analytics.version_conflict` when If-Match is stale), GET /filter-options. Until then these tests fail at the missing
// session/stub, which is the intended red state.
import { test, expect, type BrowserContext } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);

test.describe('owner exports an XLSX and downloads it', () => {
  test('report → Export (xlsx) → My exports shows Ready → Download returns 200 as an attachment', async ({ page, context }) => {
    await useSid(context, 'sid-analytics-owner');
    await page.goto('/analytics/reports/income');
    await page.getByRole('button', { name: /^export$/i }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('radio', { name: /excel|xlsx/i }).check();
    await dlg.getByRole('button', { name: /^(export|request export)$/i }).click();

    await page.goto('/analytics/exports');
    const row = page.getByRole('row', { name: /income/i }).first();
    await expect(row.getByText('Ready')).toBeVisible({ timeout: 30_000 }); // page polls every 3 s while queued/building
    const link = row.getByRole('link', { name: /download/i });
    await expect(link).toHaveAttribute('href', /\/analytics\/exports\/[0-9a-f-]{36}\/file$/);

    const res = await page.request.get((await link.getAttribute('href'))!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toMatch(/^attachment/i);
    expect(res.headers()['cache-control']).toMatch(/no-store/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
  });
});

test.describe('schedule create / edit / conflict', () => {
  test('create a schedule, edit it, then a stale edit gets 409 and shows the conflict banner', async ({ browser, page, context }) => {
    await useSid(context, 'sid-analytics-owner');
    const name = `E2E Daily MIS ${Date.now()}`;

    await page.goto('/analytics/schedules/new');
    await page.getByLabel(/name/i).first().fill(name);
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page).toHaveURL(/\/analytics\/schedules(\?.*)?$/);
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();

    // open the same schedule in a second session, so one of the two edits is stale
    const other = await browser.newContext();
    await useSid(other, 'sid-analytics-owner');
    const page2 = await other.newPage();
    await row.getByRole('link', { name: new RegExp(name) }).click();
    await expect(page).toHaveURL(/\/analytics\/schedules\/[0-9a-f-]{36}$/);
    const editUrl = page.url();
    await page2.goto(editUrl);

    await page.getByLabel(/name/i).first().fill(`${name} v2`);
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page).toHaveURL(/\/analytics\/schedules(\?.*)?$/); // first edit wins (PUT with If-Match "<version>")

    await page2.getByLabel(/name/i).first().fill(`${name} v3`);
    await page2.getByRole('button', { name: /^save$/i }).click();
    await expect(page2.getByRole('alert')).toContainText(/changed|someone else|reload/i); // 409 version_conflict banner
    await expect(page2).toHaveURL(editUrl); // stays on the form, nothing navigates
    await other.close();
  });
});
