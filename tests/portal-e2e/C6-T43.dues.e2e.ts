// C6-T43 apps/portal — the dues page /r/{token}/dues against stub-reporting-dues.mjs. AC-18.9; 08 A21.1; 03-APP-FLOW §2 row 5a, E35; 04-UI-UX §4 "Dues page". Synthetic data only.
// Run through playwright.dues.config.ts (portal :3202, stub :4128). Selectors/copy are from 04-UI-UX §4 (writer assumptions where noted in .orchestra/notes/C6-T43-tests.md).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'http://127.0.0.1:4128';
const BFF_KEY = readFileSync(join(__dirname, 'fixtures', 'bff-key.txt'), 'utf8').trim();
const T = (n: string) => n.padEnd(22, '0');
const AXE = readFileSync(require.resolve('axe-core', { paths: [join(__dirname, '..', '..', 'packages', 'ui')] }), 'utf8');
const apiLog = async (): Promise<any[]> => (await fetch(`${API}/__requests`)).json();

async function otp(page: Page, link: string) {
  await page.goto(`/r/${T(link)}`); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/code$`), { timeout: 30_000 }); await page.waitForLoadState('networkidle');
  await page.getByLabel('Digit 1 of 6').click(); await page.keyboard.type('123456');
  const view = page.getByRole('button', { name: /View report|Continue|Verify/ }); if (await view.isVisible().catch(() => false)) await view.click();
}
async function axeScan(page: Page) {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
  return (r.violations as any[]).map((v) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(' ')).join(' | ')}`);
}
test.beforeEach(async () => { await fetch(`${API}/__requests`, { method: 'DELETE' }); });

test.describe('AC-18.9 dues link: OTP lands on /r/{token}/dues', () => {
  test('after OTP (P2 link_purpose dues) the browser is on /dues; amount, pay buttons and "report will be sent" are shown; no report content, no Download', async ({ page }) => {
    await otp(page, 'dues2'); await expect(page).toHaveURL(new RegExp(`/r/${T('dues2')}/dues$`), { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Payment due' })).toBeVisible();
    await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible(); await expect(page.getByText('Your report will be sent once payment is complete.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay with eSewa' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Pay with Khalti' })).toBeVisible();
    await expect(page.getByText(/Complete Blood Count|Final|Test Diagnostics report|A\.B\./)).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0); await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
    const ax = await axeScan(page); expect(ax, ax.join('\n')).toEqual([]);
  });
  test('the page asks the API for P7 only: GET /portal/dues with the session credential; never /portal/report or a PDF; no token in any API URL', async ({ page }) => {
    await otp(page, 'dues2'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
    const log = await apiLog(); const dues = log.filter((r) => r.method === 'GET' && r.url === '/v1/reporting/portal/dues');
    expect(dues.length).toBeGreaterThan(0); expect(dues[0].cred).toBe('session.sess-dues2'); expect(dues[0].bffKey).toBe(BFF_KEY);
    expect(log.filter((r) => /\/portal\/report($|-versions)/.test(r.url))).toEqual([]);
    for (const r of log) { expect(r.url).not.toContain(T('dues2')); expect(r.url).not.toContain('sess-'); }
  });
  test('"Pay with eSewa" posts to the existing pay route with {gateway} only (PP1) — the dues session may request a payment', async ({ page }) => {
    await otp(page, 'dues2'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 }); await page.getByRole('button', { name: 'Pay with eSewa' }).click();
    await expect(page).toHaveURL(new RegExp(`/r/${T('dues2')}/payments/pr-1$`), { timeout: 30_000 });
    const pp1 = (await apiLog()).find((r) => r.method === 'POST' && r.url === '/v1/reporting/portal/payment-requests'); expect(pp1.body).toEqual({ gateway: 'esewa' }); expect(pp1.cred).toBe('session.sess-dues2');
  });
  test('no gateways (before C15) -> amount + "Please pay at the lab counter or in the app." and NO pay button', async ({ page }) => {
    await otp(page, 'duesnone'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
    await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible(); await expect(page.getByText('Please pay at the lab counter or in the app.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  });
  test('balance 0 -> "Payment received — your report will be sent once it is released." and no amount / pay button', async ({ page }) => {
    await otp(page, 'duesz'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
    await expect(page.getByText('Payment received — your report will be sent once it is released.')).toBeVisible();
    await expect(page.getByText(/Amount due/)).toHaveCount(0); await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  });
});

test.describe('a dues session cannot reach report content through the portal pages', () => {
  test('/r/{token}/report -> no report content (P3 404 -> back to the link page); /r/{token}/download -> 404, no PDF', async ({ page }) => {
    await otp(page, 'dues2'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
    await page.goto(`/r/${T('dues2')}/report`); await expect(page.getByText(/Complete Blood Count|Download PDF|A\.B\./)).toHaveCount(0);
    const dl = await page.request.get(`/r/${T('dues2')}/download`, { maxRedirects: 0 }); expect(dl.status()).not.toBe(200); expect(dl.headers()['content-type'] ?? '').not.toContain('pdf');
  });
});

test.describe('control: a report link still lands on /report', () => {
  test('P2 link_purpose report -> /r/{token}/report with the report card', async ({ page }) => {
    await otp(page, 'duesrep'); await expect(page).toHaveURL(new RegExp(`/r/${T('duesrep')}/report$`), { timeout: 30_000 }); await expect(page.getByText('Complete Blood Count')).toBeVisible();
  });
});
