// C6-T42 apps/portal — dues payment E2E with a fake gateway (stub-reporting-pay.mjs). AC-18.1..18.7; REQ-SEC-046/059; 03-APP-FLOW §2.7/2.8 rows 6-8; 04-UI-UX §4 (dues card, status, return).
// Needs apps/portal pages: report-page dues card, POST /r/{token}/pay (form, hidden nonce = Idempotency-Key -> PP1 -> 303), /r/{token}/payments/{id}, /r/payments/{id}/done.
// Run through playwright.pay.config.ts (portal :3201, stub :4127). Synthetic data only.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'http://127.0.0.1:4127';
const BFF_KEY = readFileSync(join(__dirname, 'fixtures', 'bff-key.txt'), 'utf8').trim();
const T = (n: string) => n.padEnd(22, '0');
const AXE = readFileSync(require.resolve('axe-core', { paths: [join(__dirname, '..', '..', 'packages', 'ui')] }), 'utf8');
const apiLog = async (): Promise<any[]> => (await fetch(`${API}/__requests`)).json();
const control = (mode: string) => fetch(`${API}/__control`, { method: 'POST', body: JSON.stringify({ mode }) });
const GATEWAY_URL = 'https://gateway.fake.invalid/pay/pr-1';

// ruling #7: under `next dev` the page is clicked/typed before hydration; wait for network idle and use generous navigation timeouts.
async function login(page: Page, link: string) {
  await page.goto(`/r/${T(link)}`); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/code$`), { timeout: 30_000 }); await page.waitForLoadState('networkidle');
  await page.getByLabel('Digit 1 of 6').click(); await page.keyboard.type('123456');
  const view = page.getByRole('button', { name: 'View report' }); if (await view.isVisible().catch(() => false)) await view.click();
  await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/report$`), { timeout: 30_000 });
}
async function axeScan(page: Page) {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
  return (r.violations as any[]).map((v) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(' ')).join(' | ')}`);
}
test.beforeEach(async () => { await fetch(`${API}/__requests`, { method: 'DELETE' }); await control('reset'); });

test.describe('AC-18.1 / AC-18.2 dues card on the report page', () => {
  test('AC-18.1: amount + one button per configured gateway', async ({ page }) => {
    await login(page, 'pay2');
    await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay with eSewa' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Pay with Khalti' })).toBeVisible();
    await expect(page.getByText('The exact amount is confirmed when you pay.')).toBeVisible();
  });
  test('AC-18.2: no gateways -> amount + counter/app copy and NO payment button; referrer link -> no dues section at all', async ({ page }) => {
    await login(page, 'paynone');
    await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible(); await expect(page.getByText('Please pay at the lab counter or in the app.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
    await page.context().clearCookies(); await login(page, 'payref');
    await expect(page.getByText(/Amount due/)).toHaveCount(0); await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  });
  test('AC-18.4: an open request -> "A payment is in progress." + link "See payment status"', async ({ page }) => {
    await login(page, 'payopen');
    await expect(page.getByText('A payment is in progress.')).toBeVisible(); await expect(page.getByRole('link', { name: 'See payment status' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  });
});

test.describe('AC-18.3 / 18.5 request + status page', () => {
  test('"Pay with eSewa" -> PP1 with {gateway} only + Idempotency-Key + session credential in the header; lands on the status page "Preparing your payment…"', async ({ page }) => {
    await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click();
    await expect(page).toHaveURL(new RegExp(`/r/${T('pay2')}/payments/pr-1$`)); await expect(page.getByText('Preparing your payment…')).toBeVisible();
    const pp1 = (await apiLog()).find((r) => r.method === 'POST' && r.url === '/v1/reporting/portal/payment-requests');
    expect(pp1, 'PP1 call').toBeTruthy(); expect(pp1.body).toEqual({ gateway: 'esewa' });                                  // never an amount (REQ-SEC-046)
    expect(String(pp1.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(16); expect(pp1.cred).toBe('session.sess-pay2'); expect(pp1.bffKey).toBe(BFF_KEY); expect(pp1.authorization).toBeUndefined();
    for (const r of await apiLog()) { expect(r.url).not.toContain(T('pay2')); expect(r.url).not.toContain('sess-'); expect(r.url).not.toContain('?'); }
  });
  test('the status page refreshes itself; once ready it shows "Continue to eSewa" linking to the gateway URL (no-referrer); the URL is not in the page before that', async ({ page }) => {
    await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click();
    await expect(page.getByText('Preparing your payment…')).toBeVisible(); expect(await page.content()).not.toContain('gateway.fake.invalid');
    await control('ready');
    const go = page.getByRole('link', { name: 'Continue to eSewa' }); await expect(go).toBeVisible({ timeout: 15_000 });
    await expect(go).toHaveAttribute('href', GATEWAY_URL); expect(((await go.getAttribute('rel')) ?? '') + ((await page.locator('meta[name="referrer"]').getAttribute('content').catch(() => '')) ?? '')).toMatch(/noreferrer|no-referrer/);
    const ax = await axeScan(page); expect(ax, ax.join('\n')).toEqual([]);
  });
  test('"We are confirming your payment" while held for review: no Continue link, no gateway URL in the page', async ({ page }) => {
    await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click(); await control('review');
    await expect(page.getByText(/We are confirming your payment\. This can take a few minutes\./)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /^Continue to/ })).toHaveCount(0); expect(await page.content()).not.toContain('gateway.fake.invalid');
  });
  test('AC-18.4: 409 payment_in_progress -> "A payment for this order is already in progress."', async ({ page }) => {
    await login(page, 'paycf'); await page.getByRole('button', { name: 'Pay with Khalti' }).click();
    await expect(page.getByText('A payment for this order is already in progress.')).toBeVisible();
  });
});

test.describe('AC-18.7 failed requests', () => {
  test('gateway_not_available (C15 phase stub) -> counter/app copy, no button, no Continue link', async ({ page }) => {
    await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click(); await control('failed_unavail');
    await expect(page.getByText('Online payment is not available right now. Please pay at the lab counter or in the app.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: /^Continue to/ })).toHaveCount(0); await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  });
  test('nothing_due -> "Nothing is due on this report."', async ({ page }) => {
    await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click(); await control('failed_nothing');
    await expect(page.getByText('Nothing is due on this report.')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('AC-18.6 return page /r/payments/{id}/done', () => {
  test('?outcome=settled while C15 still reports pending -> "Checking your payment…" (outcome never trusted, never shown, never forwarded); then completed -> "Payment received. Thank you."', async ({ page }) => {
    await login(page, 'pay2'); await control('ready');
    await page.goto('/r/payments/pr-1/done?outcome=PWNED-OUTCOME-settled');
    await expect(page.getByText('Checking your payment…')).toBeVisible(); await expect(page.getByText('Payment received. Thank you.')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('PWNED-OUTCOME');   // ruling #6: rendered text; Next's own flight payload echoes the request URL outside app code (log checks below stay)
    await control('completed'); await expect(page.getByText('Payment received. Thank you.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Back to your report' })).toBeVisible(); expect(await page.content()).not.toContain('gateway.fake.invalid');
    const log = await apiLog(); const pp2 = log.filter((r) => r.url === '/v1/reporting/portal/payment-requests/pr-1'); expect(pp2.length).toBeGreaterThan(0);
    for (const r of pp2) { expect(r.cred).toBe('session.sess-pay2'); expect(r.url).not.toContain('outcome'); }
    expect(JSON.stringify(log)).not.toContain('PWNED-OUTCOME');
    const ax = await axeScan(page); expect(ax, ax.join('\n')).toEqual([]);
  });
  test('failed / expired -> "The payment was not completed." + "Back to your report"', async ({ page }) => {
    await login(page, 'pay2');
    for (const m of ['failed_payment', 'expired']) {
      await control(m); await page.goto('/r/payments/pr-1/done?outcome=settled');
      await expect(page.getByText('The payment was not completed.')).toBeVisible(); await expect(page.getByRole('link', { name: 'Back to your report' })).toBeVisible();
    }
  });
  test('no portal session -> data-free "Open your report link again to see your payment status."; no payment-request API call is made', async ({ page }) => {
    await control('completed'); await page.goto('/r/payments/pr-1/done?outcome=settled');
    await expect(page.getByText('Open your report link again to see your payment status.')).toBeVisible();
    await expect(page.getByText(/Payment received|NPR|Amount/)).toHaveCount(0);
    expect((await apiLog()).filter((r) => r.url.startsWith('/v1/reporting/portal/payment-requests/') && r.cred.startsWith('session.'))).toEqual([]);
  });
});
