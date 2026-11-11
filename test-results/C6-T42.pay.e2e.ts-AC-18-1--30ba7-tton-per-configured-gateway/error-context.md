# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: C6-T42.pay.e2e.ts >> AC-18.1 / AC-18.2 dues card on the report page >> AC-18.1: amount + one button per configured gateway
- Location: ..\..\tests\portal-e2e\C6-T42.pay.e2e.ts:33:3

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.waitForLoadState: Test timeout of 60000ms exceeded.
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - main [ref=e2]:
    - heading "View your lab report" [level=1] [ref=e3]
    - generic [ref=e4]:
      - paragraph [ref=e5]: For your security we will send a 6-digit code to the phone number or email the lab has for you.
      - button "Send me a code" [ref=e7] [cursor=pointer]
  - contentinfo [ref=e8]: Your data stays on servers in Nepal.
  - button "Open Next.js Dev Tools" [ref=e14] [cursor=pointer]
  - alert [ref=e18]
```

# Test source

```ts
  1   | // C6-T42 apps/portal — dues payment E2E with a fake gateway (stub-reporting-pay.mjs). AC-18.1..18.7; REQ-SEC-046/059; 03-APP-FLOW §2.7/2.8 rows 6-8; 04-UI-UX §4 (dues card, status, return).
  2   | // Needs apps/portal pages: report-page dues card, POST /r/{token}/pay (form, hidden nonce = Idempotency-Key -> PP1 -> 303), /r/{token}/payments/{id}, /r/payments/{id}/done.
  3   | // Run through playwright.pay.config.ts (portal :3201, stub :4127). Synthetic data only.
  4   | import { test, expect, type Page } from '@playwright/test';
  5   | import { readFileSync } from 'node:fs';
  6   | import { join } from 'node:path';
  7   | 
  8   | const API = 'http://127.0.0.1:4127';
  9   | const BFF_KEY = readFileSync(join(__dirname, 'fixtures', 'bff-key.txt'), 'utf8').trim();
  10  | const T = (n: string) => n.padEnd(22, '0');
  11  | const AXE = readFileSync(require.resolve('axe-core', { paths: [join(__dirname, '..', '..', 'packages', 'ui')] }), 'utf8');
  12  | const apiLog = async (): Promise<any[]> => (await fetch(`${API}/__requests`)).json();
  13  | const control = (mode: string) => fetch(`${API}/__control`, { method: 'POST', body: JSON.stringify({ mode }) });
  14  | const GATEWAY_URL = 'https://gateway.fake.invalid/pay/pr-1';
  15  | 
  16  | // ruling #7: under `next dev` the page is clicked/typed before hydration; wait for network idle and use generous navigation timeouts.
  17  | async function login(page: Page, link: string) {
> 18  |   await page.goto(`/r/${T(link)}`); await page.waitForLoadState('networkidle');
      |                                                ^ Error: page.waitForLoadState: Test timeout of 60000ms exceeded.
  19  |   await page.getByRole('button', { name: 'Send me a code' }).click();
  20  |   await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/code$`), { timeout: 30_000 }); await page.waitForLoadState('networkidle');
  21  |   await page.getByLabel('Digit 1 of 6').click(); await page.keyboard.type('123456');
  22  |   const view = page.getByRole('button', { name: 'View report' }); if (await view.isVisible().catch(() => false)) await view.click();
  23  |   await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/report$`), { timeout: 30_000 });
  24  | }
  25  | async function axeScan(page: Page) {
  26  |   await page.evaluate(AXE);
  27  |   const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
  28  |   return (r.violations as any[]).map((v) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(' ')).join(' | ')}`);
  29  | }
  30  | test.beforeEach(async () => { await fetch(`${API}/__requests`, { method: 'DELETE' }); await control('reset'); });
  31  | 
  32  | test.describe('AC-18.1 / AC-18.2 dues card on the report page', () => {
  33  |   test('AC-18.1: amount + one button per configured gateway', async ({ page }) => {
  34  |     await login(page, 'pay2');
  35  |     await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible();
  36  |     await expect(page.getByRole('button', { name: 'Pay with eSewa' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Pay with Khalti' })).toBeVisible();
  37  |     await expect(page.getByText('The exact amount is confirmed when you pay.')).toBeVisible();
  38  |   });
  39  |   test('AC-18.2: no gateways -> amount + counter/app copy and NO payment button; referrer link -> no dues section at all', async ({ page }) => {
  40  |     await login(page, 'paynone');
  41  |     await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible(); await expect(page.getByText('Please pay at the lab counter or in the app.')).toBeVisible();
  42  |     await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  43  |     await page.context().clearCookies(); await login(page, 'payref');
  44  |     await expect(page.getByText(/Amount due/)).toHaveCount(0); await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  45  |   });
  46  |   test('AC-18.4: an open request -> "A payment is in progress." + link "See payment status"', async ({ page }) => {
  47  |     await login(page, 'payopen');
  48  |     await expect(page.getByText('A payment is in progress.')).toBeVisible(); await expect(page.getByRole('link', { name: 'See payment status' })).toBeVisible();
  49  |     await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  50  |   });
  51  | });
  52  | 
  53  | test.describe('AC-18.3 / 18.5 request + status page', () => {
  54  |   test('"Pay with eSewa" -> PP1 with {gateway} only + Idempotency-Key + session credential in the header; lands on the status page "Preparing your payment…"', async ({ page }) => {
  55  |     await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click();
  56  |     await expect(page).toHaveURL(new RegExp(`/r/${T('pay2')}/payments/pr-1$`)); await expect(page.getByText('Preparing your payment…')).toBeVisible();
  57  |     const pp1 = (await apiLog()).find((r) => r.method === 'POST' && r.url === '/v1/reporting/portal/payment-requests');
  58  |     expect(pp1, 'PP1 call').toBeTruthy(); expect(pp1.body).toEqual({ gateway: 'esewa' });                                  // never an amount (REQ-SEC-046)
  59  |     expect(String(pp1.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(16); expect(pp1.cred).toBe('session.sess-pay2'); expect(pp1.bffKey).toBe(BFF_KEY); expect(pp1.authorization).toBeUndefined();
  60  |     for (const r of await apiLog()) { expect(r.url).not.toContain(T('pay2')); expect(r.url).not.toContain('sess-'); expect(r.url).not.toContain('?'); }
  61  |   });
  62  |   test('the status page refreshes itself; once ready it shows "Continue to eSewa" linking to the gateway URL (no-referrer); the URL is not in the page before that', async ({ page }) => {
  63  |     await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click();
  64  |     await expect(page.getByText('Preparing your payment…')).toBeVisible(); expect(await page.content()).not.toContain('gateway.fake.invalid');
  65  |     await control('ready');
  66  |     const go = page.getByRole('link', { name: 'Continue to eSewa' }); await expect(go).toBeVisible({ timeout: 15_000 });
  67  |     await expect(go).toHaveAttribute('href', GATEWAY_URL); expect(((await go.getAttribute('rel')) ?? '') + ((await page.locator('meta[name="referrer"]').getAttribute('content').catch(() => '')) ?? '')).toMatch(/noreferrer|no-referrer/);
  68  |     const ax = await axeScan(page); expect(ax, ax.join('\n')).toEqual([]);
  69  |   });
  70  |   test('"We are confirming your payment" while held for review: no Continue link, no gateway URL in the page', async ({ page }) => {
  71  |     await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click(); await control('review');
  72  |     await expect(page.getByText(/We are confirming your payment\. This can take a few minutes\./)).toBeVisible({ timeout: 15_000 });
  73  |     await expect(page.getByRole('link', { name: /^Continue to/ })).toHaveCount(0); expect(await page.content()).not.toContain('gateway.fake.invalid');
  74  |   });
  75  |   test('AC-18.4: 409 payment_in_progress -> "A payment for this order is already in progress."', async ({ page }) => {
  76  |     await login(page, 'paycf'); await page.getByRole('button', { name: 'Pay with Khalti' }).click();
  77  |     await expect(page.getByText('A payment for this order is already in progress.')).toBeVisible();
  78  |   });
  79  | });
  80  | 
  81  | test.describe('AC-18.7 failed requests', () => {
  82  |   test('gateway_not_available (C15 phase stub) -> counter/app copy, no button, no Continue link', async ({ page }) => {
  83  |     await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click(); await control('failed_unavail');
  84  |     await expect(page.getByText('Online payment is not available right now. Please pay at the lab counter or in the app.')).toBeVisible({ timeout: 15_000 });
  85  |     await expect(page.getByRole('link', { name: /^Continue to/ })).toHaveCount(0); await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  86  |   });
  87  |   test('nothing_due -> "Nothing is due on this report."', async ({ page }) => {
  88  |     await login(page, 'pay2'); await page.getByRole('button', { name: 'Pay with eSewa' }).click(); await control('failed_nothing');
  89  |     await expect(page.getByText('Nothing is due on this report.')).toBeVisible({ timeout: 15_000 });
  90  |   });
  91  | });
  92  | 
  93  | test.describe('AC-18.6 return page /r/payments/{id}/done', () => {
  94  |   test('?outcome=settled while C15 still reports pending -> "Checking your payment…" (outcome never trusted, never shown, never forwarded); then completed -> "Payment received. Thank you."', async ({ page }) => {
  95  |     await login(page, 'pay2'); await control('ready');
  96  |     await page.goto('/r/payments/pr-1/done?outcome=PWNED-OUTCOME-settled');
  97  |     await expect(page.getByText('Checking your payment…')).toBeVisible(); await expect(page.getByText('Payment received. Thank you.')).toHaveCount(0);
  98  |     expect(await page.locator('body').innerText()).not.toContain('PWNED-OUTCOME');   // ruling #6: rendered text; Next's own flight payload echoes the request URL outside app code (log checks below stay)
  99  |     await control('completed'); await expect(page.getByText('Payment received. Thank you.')).toBeVisible({ timeout: 15_000 });
  100 |     await expect(page.getByRole('link', { name: 'Back to your report' })).toBeVisible(); expect(await page.content()).not.toContain('gateway.fake.invalid');
  101 |     const log = await apiLog(); const pp2 = log.filter((r) => r.url === '/v1/reporting/portal/payment-requests/pr-1'); expect(pp2.length).toBeGreaterThan(0);
  102 |     for (const r of pp2) { expect(r.cred).toBe('session.sess-pay2'); expect(r.url).not.toContain('outcome'); }
  103 |     expect(JSON.stringify(log)).not.toContain('PWNED-OUTCOME');
  104 |     const ax = await axeScan(page); expect(ax, ax.join('\n')).toEqual([]);
  105 |   });
  106 |   test('failed / expired -> "The payment was not completed." + "Back to your report"', async ({ page }) => {
  107 |     await login(page, 'pay2');
  108 |     for (const m of ['failed_payment', 'expired']) {
  109 |       await control(m); await page.goto('/r/payments/pr-1/done?outcome=settled');
  110 |       await expect(page.getByText('The payment was not completed.')).toBeVisible(); await expect(page.getByRole('link', { name: 'Back to your report' })).toBeVisible();
  111 |     }
  112 |   });
  113 |   test('no portal session -> data-free "Open your report link again to see your payment status."; no payment-request API call is made', async ({ page }) => {
  114 |     await control('completed'); await page.goto('/r/payments/pr-1/done?outcome=settled');
  115 |     await expect(page.getByText('Open your report link again to see your payment status.')).toBeVisible();
  116 |     await expect(page.getByText(/Payment received|NPR|Amount/)).toHaveCount(0);
  117 |     expect((await apiLog()).filter((r) => r.url.startsWith('/v1/reporting/portal/payment-requests/') && r.cred.startsWith('session.'))).toEqual([]);
  118 |   });
```