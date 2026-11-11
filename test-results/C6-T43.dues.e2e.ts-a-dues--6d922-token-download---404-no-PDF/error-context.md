# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: C6-T43.dues.e2e.ts >> a dues session cannot reach report content through the portal pages >> /r/{token}/report -> no report content (P3 404 -> back to the link page); /r/{token}/download -> 404, no PDF
- Location: ..\..\tests\portal-e2e\C6-T43.dues.e2e.ts:62:3

# Error details

```
Test timeout of 120000ms exceeded.
```

```
Error: page.waitForLoadState: Test timeout of 120000ms exceeded.
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
  1  | // C6-T43 apps/portal — the dues page /r/{token}/dues against stub-reporting-dues.mjs. AC-18.9; 08 A21.1; 03-APP-FLOW §2 row 5a, E35; 04-UI-UX §4 "Dues page". Synthetic data only.
  2  | // Run through playwright.dues.config.ts (portal :3202, stub :4128). Selectors/copy are from 04-UI-UX §4 (writer assumptions where noted in .orchestra/notes/C6-T43-tests.md).
  3  | import { test, expect, type Page } from '@playwright/test';
  4  | import { readFileSync } from 'node:fs';
  5  | import { join } from 'node:path';
  6  | 
  7  | const API = 'http://127.0.0.1:4128';
  8  | const BFF_KEY = readFileSync(join(__dirname, 'fixtures', 'bff-key.txt'), 'utf8').trim();
  9  | const T = (n: string) => n.padEnd(22, '0');
  10 | const AXE = readFileSync(require.resolve('axe-core', { paths: [join(__dirname, '..', '..', 'packages', 'ui')] }), 'utf8');
  11 | const apiLog = async (): Promise<any[]> => (await fetch(`${API}/__requests`)).json();
  12 | 
  13 | async function otp(page: Page, link: string) {
> 14 |   await page.goto(`/r/${T(link)}`); await page.waitForLoadState('networkidle');
     |                                                ^ Error: page.waitForLoadState: Test timeout of 120000ms exceeded.
  15 |   await page.getByRole('button', { name: 'Send me a code' }).click();
  16 |   await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/code$`), { timeout: 30_000 }); await page.waitForLoadState('networkidle');
  17 |   await page.getByLabel('Digit 1 of 6').click(); await page.keyboard.type('123456');
  18 |   const view = page.getByRole('button', { name: /View report|Continue|Verify/ }); if (await view.isVisible().catch(() => false)) await view.click();
  19 | }
  20 | async function axeScan(page: Page) {
  21 |   await page.evaluate(AXE);
  22 |   const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
  23 |   return (r.violations as any[]).map((v) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(' ')).join(' | ')}`);
  24 | }
  25 | test.beforeEach(async () => { await fetch(`${API}/__requests`, { method: 'DELETE' }); });
  26 | 
  27 | test.describe('AC-18.9 dues link: OTP lands on /r/{token}/dues', () => {
  28 |   test('after OTP (P2 link_purpose dues) the browser is on /dues; amount, pay buttons and "report will be sent" are shown; no report content, no Download', async ({ page }) => {
  29 |     await otp(page, 'dues2'); await expect(page).toHaveURL(new RegExp(`/r/${T('dues2')}/dues$`), { timeout: 30_000 });
  30 |     await expect(page.getByRole('heading', { name: 'Payment due' })).toBeVisible();
  31 |     await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible(); await expect(page.getByText('Your report will be sent once payment is complete.')).toBeVisible();
  32 |     await expect(page.getByRole('button', { name: 'Pay with eSewa' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Pay with Khalti' })).toBeVisible();
  33 |     await expect(page.getByText(/Complete Blood Count|Final|Test Diagnostics report|A\.B\./)).toHaveCount(0);
  34 |     await expect(page.getByRole('link', { name: /Download/ })).toHaveCount(0); await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
  35 |     const ax = await axeScan(page); expect(ax, ax.join('\n')).toEqual([]);
  36 |   });
  37 |   test('the page asks the API for P7 only: GET /portal/dues with the session credential; never /portal/report or a PDF; no token in any API URL', async ({ page }) => {
  38 |     await otp(page, 'dues2'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
  39 |     const log = await apiLog(); const dues = log.filter((r) => r.method === 'GET' && r.url === '/v1/reporting/portal/dues');
  40 |     expect(dues.length).toBeGreaterThan(0); expect(dues[0].cred).toBe('session.sess-dues2'); expect(dues[0].bffKey).toBe(BFF_KEY);
  41 |     expect(log.filter((r) => /\/portal\/report($|-versions)/.test(r.url))).toEqual([]);
  42 |     for (const r of log) { expect(r.url).not.toContain(T('dues2')); expect(r.url).not.toContain('sess-'); }
  43 |   });
  44 |   test('"Pay with eSewa" posts to the existing pay route with {gateway} only (PP1) — the dues session may request a payment', async ({ page }) => {
  45 |     await otp(page, 'dues2'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 }); await page.getByRole('button', { name: 'Pay with eSewa' }).click();
  46 |     await expect(page).toHaveURL(new RegExp(`/r/${T('dues2')}/payments/pr-1$`), { timeout: 30_000 });
  47 |     const pp1 = (await apiLog()).find((r) => r.method === 'POST' && r.url === '/v1/reporting/portal/payment-requests'); expect(pp1.body).toEqual({ gateway: 'esewa' }); expect(pp1.cred).toBe('session.sess-dues2');
  48 |   });
  49 |   test('no gateways (before C15) -> amount + "Please pay at the lab counter or in the app." and NO pay button', async ({ page }) => {
  50 |     await otp(page, 'duesnone'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
  51 |     await expect(page.getByText('Amount due: NPR 500.00')).toBeVisible(); await expect(page.getByText('Please pay at the lab counter or in the app.')).toBeVisible();
  52 |     await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  53 |   });
  54 |   test('balance 0 -> "Payment received — your report will be sent once it is released." and no amount / pay button', async ({ page }) => {
  55 |     await otp(page, 'duesz'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
  56 |     await expect(page.getByText('Payment received — your report will be sent once it is released.')).toBeVisible();
  57 |     await expect(page.getByText(/Amount due/)).toHaveCount(0); await expect(page.getByRole('button', { name: /^Pay with/ })).toHaveCount(0);
  58 |   });
  59 | });
  60 | 
  61 | test.describe('a dues session cannot reach report content through the portal pages', () => {
  62 |   test('/r/{token}/report -> no report content (P3 404 -> back to the link page); /r/{token}/download -> 404, no PDF', async ({ page }) => {
  63 |     await otp(page, 'dues2'); await expect(page).toHaveURL(/\/dues$/, { timeout: 30_000 });
  64 |     await page.goto(`/r/${T('dues2')}/report`); await expect(page.getByText(/Complete Blood Count|Download PDF|A\.B\./)).toHaveCount(0);
  65 |     const dl = await page.request.get(`/r/${T('dues2')}/download`, { maxRedirects: 0 }); expect(dl.status()).not.toBe(200); expect(dl.headers()['content-type'] ?? '').not.toContain('pdf');
  66 |   });
  67 | });
  68 | 
  69 | test.describe('control: a report link still lands on /report', () => {
  70 |   test('P2 link_purpose report -> /r/{token}/report with the report card', async ({ page }) => {
  71 |     await otp(page, 'duesrep'); await expect(page).toHaveURL(new RegExp(`/r/${T('duesrep')}/report$`), { timeout: 30_000 }); await expect(page.getByText('Complete Blood Count')).toBeVisible();
  72 |   });
  73 | });
  74 | 
```