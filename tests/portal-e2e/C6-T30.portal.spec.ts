// C6-T30 apps/portal — Playwright E2E + axe. AC-11.1..11.12, AC-10.1..10.3 (UI); REQ-SEC-068/089/090/091/092/098; 04-UI-UX §4.
// Needs apps/portal (not yet built) + stub-reporting.mjs (started by playwright.config.ts). Synthetic data only.
// Not covered here (API/worker side, other tasks): AC-11.10 access_log row `report.portal_download`, OTP message content, nginx limit_req (AC-10.4).
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORTAL = 'http://localhost:3200';
const API = 'http://127.0.0.1:4126';
const BFF_KEY = readFileSync(join(__dirname, 'fixtures', 'bff-key.txt'), 'utf8').trim();
const COOKIE = '__Host-lims_portal';
const T = (n: string) => n.padEnd(22, '0'); // 22-char link / QR token
const AXE = readFileSync(require.resolve('axe-core', { paths: [join(__dirname, '..', '..', 'packages', 'ui')] }), 'utf8');

const apiLog = async (): Promise<any[]> => (await fetch(`${API}/__requests`)).json();
const apiReset = () => fetch(`${API}/__requests`, { method: 'DELETE' });
const apiControl = (mode: string) => fetch(`${API}/__control`, { method: 'POST', body: JSON.stringify({ mode }) });
// Masks per-response randomness only (REQ-SEC-089 nonce CSP; Next.js __next_r render id) — ruling C6-T30-ruling.md. Applied to the raw body AND to the JSON.stringify'd form (escaped quotes).
const norm = (s: string) =>
  s.replace(/nonce-[A-Za-z0-9+/=_-]+/g, 'nonce-X')
    .replace(/nonce="[^"]*"/g, 'nonce="X"')
    .replace(/nonce=\\"[^"\\]*\\"/g, 'nonce=\\"X\\"')
    .replace(/nonce(\\*)":(\\*)"[^"\\]*\\*"/g, 'nonce$1":$2"X$2"') // RSC flight payload {"nonce":"…"} (self.__next_f.push), raw + escaped at any depth
    .replace(/__next_r="[^"]*"/g, '__next_r="X"')
    .replace(/__next_r=\\"[^"\\]*\\"/g, '__next_r=\\"X\\"');

async function enterCode(page: Page, code: string) {
  await page.getByLabel('Digit 1 of 6').click();
  await page.keyboard.type(code);
}
async function login(page: Page, link: string) {
  await page.goto(`/r/${T(link)}`);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/code$`));
  await enterCode(page, '123456');
  const view = page.getByRole('button', { name: 'View report' });
  if (await view.isVisible().catch(() => false)) await view.click();
  await expect(page).toHaveURL(new RegExp(`/r/${T(link)}/report$`));
}
async function axeScan(page: Page) {
  await page.evaluate(AXE);
  const r = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
  return (r.violations as any[]).map((v) => `${v.id}: ${v.nodes.map((n: any) => n.target.join(' ')).join(' | ')}`);
}
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

test.beforeEach(async () => { await apiReset(); await apiControl('reset'); });

test.describe('AC-11.1 link landing + OTP request', () => {
  test('landing copy; no API call and no OTP on page load (link-preview bots, T3)', async ({ page }) => {
    await page.goto(`/r/${T('ok')}`);
    await expect(page.getByRole('heading', { name: 'View your lab report' })).toBeVisible();
    await expect(page.getByText('For your security we will send a 6-digit code to the phone number or email the lab has for you.')).toBeVisible();
    expect((await apiLog()).filter((r) => r.method === 'POST')).toEqual([]);
  });

  test('"Send me a code" -> P1 with link credential header; code page says registered number, no mask', async ({ page }) => {
    await page.goto(`/r/${T('ok')}`, {});
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page).toHaveURL(new RegExp(`/r/${T('ok')}/code$`));
    await expect(page.getByText('Code sent to the mobile number registered with the lab.')).toBeVisible();
    await expect(page.getByText(/expires in 10 minutes/i)).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/\*{2,}|ending in|\d{3,}\s?\d{3,}/);
    const p1 = (await apiLog()).find((r) => r.method === 'POST' && r.url === '/v1/reporting/portal/otp-challenges');
    expect(p1, 'P1 call').toBeTruthy();
    expect(p1.cred).toBe(`link.${T('ok')}`);
  });
});

test.describe('AC-11.2 / AC-11.12 session + report page', () => {
  test('valid code starts a session; report summary + Download PDF + Sign out; cookie flags; no token in JS-reachable state', async ({ page, context }) => {
    const bodies: string[] = [];
    page.on('response', async (r) => { if (/text|json|javascript/.test(r.headers()['content-type'] ?? '')) bodies.push(await r.text().catch(() => '')); });
    await login(page, 'ok');
    await expect(page.getByText('Test Diagnostics').first()).toBeVisible();
    await expect(page.getByText('Report for A.B.')).toBeVisible();
    await expect(page.getByText('Final')).toBeVisible();
    await expect(page.getByText(/Issued /)).toBeVisible();
    await expect(page.getByText('Complete Blood Count')).toBeVisible();
    await expect(page.getByText('Lipid Profile')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download PDF' }).or(page.getByRole('button', { name: 'Download PDF' }))).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' }).or(page.getByRole('link', { name: 'Sign out' }))).toBeVisible();
    const c = (await context.cookies(PORTAL)).find((x) => x.name === COOKIE);
    expect(c, `${COOKIE} cookie`).toBeTruthy();
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    expect(c!.expires).toBeGreaterThan(0);
    expect(c!.expires * 1000).toBeLessThanOrEqual(Date.now() + 61 * 60_000); // absolute 60 min (AC-11.8)
    expect(await page.evaluate(() => document.cookie)).not.toContain('lims_portal');
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain('sess-');
    expect(bodies.join('\n')).not.toContain('sess-ok'); // session token never reaches the browser (REQ-SEC-068)
    const log = await apiLog();
    const rep = log.find((r) => r.url === '/v1/reporting/portal/report');
    expect(rep.cred).toBe('session.sess-ok');
    for (const r of log) { // credential always in the header, never in API URLs / query (AC-11.9, REQ-SEC-098)
      expect(r.url).not.toContain(T('ok'));
      expect(r.url).not.toContain('sess-');
      expect(r.url).not.toContain('?');
      expect(r.bffKey).toBe(BFF_KEY);
      expect(r.authorization).toBeUndefined();
    }
  });

  test('no PHI beyond the spec: no phone / dob / address on the report page', async ({ page }) => {
    await login(page, 'ok');
    expect(await page.locator('body').innerText()).not.toMatch(/\+?977|date of birth|\bDOB\b|address/i);
  });

  test('AC-11.12 no session: report page, download and sign-out do not serve content', async ({ page, request }) => {
    await page.goto(`/r/${T('ok')}/report`);
    await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveCount(0);
    await expect(page.getByText('Complete Blood Count')).toHaveCount(0);
    const d = await request.get(`/r/${T('ok')}/download`, { maxRedirects: 0 });
    expect(d.headers()['content-type'] ?? '').not.toContain('application/pdf');
    expect((await d.body()).toString().startsWith('%PDF')).toBe(false);
    const rep = (await apiLog()).filter((r) => r.url.startsWith('/v1/reporting/portal/report') && r.cred.startsWith('session.'));
    expect(rep).toEqual([]);
  });
});

test.describe('AC-11.3 attempts', () => {
  test('wrong code: message + focus on alert; 5th wrong exhausts; right code afterwards still fails', async ({ page }) => {
    await page.goto(`/r/${T('ex5')}`);
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page).toHaveURL(new RegExp(`/code$`));
    await enterCode(page, '000001');
    const view = page.getByRole('button', { name: 'View report' });
    if (await view.isVisible().catch(() => false)) await view.click();
    await expect(page.getByText(/That code is not right\./)).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.closest('[role="alert"]') != null || document.activeElement?.getAttribute('role') === 'alert')).toBe(true);
    for (const c of ['000002', '000003', '000004', '000005']) {
      await page.getByLabel('Digit 1 of 6').click();
      await page.keyboard.press('Control+A');
      await page.keyboard.type(c);
      if (await view.isVisible().catch(() => false)) await view.click();
      await page.waitForTimeout(150);
    }
    await expect(page.getByText('This code can no longer be used. Send a new code.')).toBeVisible();
    await page.getByLabel('Digit 1 of 6').click();
    await page.keyboard.type('123456');
    if (await view.isVisible().catch(() => false)) await view.click();
    await expect(page).not.toHaveURL(/\/report$/);
    expect((await apiLog()).some((r) => r.url === '/v1/reporting/portal/report')).toBe(false);
  });
});

test.describe('AC-11.4 rate limit', () => {
  test('429 on code request shows the rate-limited page copy, no session', async ({ page }) => {
    await page.goto(`/r/${T('rl')}`);
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByText(/Too many attempts\. Please try again in \d+ minutes?\./)).toBeVisible();
  });
});

test.describe('AC-11.5 invalid links', () => {
  const cases: Array<[string, string]> = [['expired', T('exp')], ['revoked', T('rev')], ['unknown', T('unk')], ['malformed', 'not-a-token!']];
  const seen: Record<string, string> = {};
  for (const [label, tok] of cases) {
    test(`${label}: invalid page + identical reissue confirmation`, async ({ page }) => {
      await page.goto(`/r/${tok}`);
      await page.getByRole('button', { name: 'Send me a code' }).click();
      await expect(page.getByText('This link is not valid. It may have expired or been replaced.')).toBeVisible();
      seen[label] = (await page.locator('main').innerText()).replace(tok, 'TOKEN');
      await page.getByRole('button', { name: 'Request a new link' }).click();
      await expect(page.getByText('If this link was sent to you, a new one will arrive by the same method shortly.')).toBeVisible();
      seen[`${label}-after`] = (await page.locator('main').innerText()).replace(tok, 'TOKEN');
    });
  }
  test('all four cases render the same text; confirmation is the same whatever the API answered (404 / 500 included)', async ({ page }) => {
    expect(new Set(cases.map(([l]) => seen[l])).size).toBe(1);
    expect(new Set(cases.map(([l]) => seen[`${l}-after`])).size).toBe(1);
    await page.goto(`/r/${T('boom')}`); // API answers 500 to P5
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await page.getByRole('button', { name: 'Request a new link' }).click();
    await expect(page.getByText('If this link was sent to you, a new one will arrive by the same method shortly.')).toBeVisible();
  });
});

test.describe('AC-11.6 download', () => {
  test('PDF served as attachment, nosniff, no-store; latest version id; credential in header', async ({ page, context }) => {
    await login(page, 'ok');
    const cookie = (await context.cookies(PORTAL)).map((c) => `${c.name}=${c.value}`).join('; ');
    const r = await fetch(`${PORTAL}/r/${T('ok')}/download`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect((await r.text()).startsWith('%PDF')).toBe(true);
    const pdf = (await apiLog()).find((x) => x.url.endsWith('/pdf'));
    expect(pdf.url).toBe(`/v1/reporting/portal/report-versions/ver-ok-1/pdf`);
    expect(pdf.cred).toBe('session.sess-ok');
  });

  test('the 21st download in an hour answers 429 and no PDF', async ({ page, context }) => {
    await login(page, 'dl');
    const cookie = (await context.cookies(PORTAL)).map((c) => `${c.name}=${c.value}`).join('; ');
    let last: Response | undefined;
    for (let i = 1; i <= 21; i++) {
      last = await fetch(`${PORTAL}/r/${T('dl')}/download`, { headers: { cookie } });
      if (i < 21) { expect(last.status).toBe(200); await last.arrayBuffer(); }
    }
    expect(last!.status).toBe(429);
    expect((await last!.text()).startsWith('%PDF')).toBe(false);
  });
});

test.describe('AC-11.7 superseded -> latest version', () => {
  test('notice shown; download targets the latest version only', async ({ page, context }) => {
    await login(page, 'upd');
    await expect(page.getByText(/This report was updated on .+\. You are seeing the latest version\./)).toBeVisible();
    const cookie = (await context.cookies(PORTAL)).map((c) => `${c.name}=${c.value}`).join('; ');
    await fetch(`${PORTAL}/r/${T('upd')}/download`, { headers: { cookie } });
    const urls = (await apiLog()).filter((x) => x.url.endsWith('/pdf')).map((x) => x.url);
    expect(urls).toEqual([`/v1/reporting/portal/report-versions/ver-upd-2/pdf`]);
    expect(await page.locator('body').innerText()).not.toMatch(/version 1|v1\b/i);
  });
});

test.describe('AC-11.8 session expiry', () => {
  test('idle/absolute expiry -> next request needs a new OTP, no report content', async ({ page }) => {
    await login(page, 'ok');
    await apiControl('expire_sessions');
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/r/${T('ok')}(/code)?$`));
    await expect(page.getByText('Complete Blood Count')).toHaveCount(0);
  });

  test('Sign out ends the session (P6) and clears the cookie', async ({ page, context }) => {
    await login(page, 'ok');
    const out = page.getByRole('button', { name: 'Sign out' });
    if (await out.count()) await out.click(); else await page.getByRole('link', { name: 'Sign out' }).click();
    await expect.poll(async () => (await apiLog()).some((r) => r.url === '/v1/reporting/portal/sessions/end' && r.method === 'POST')).toBe(true);
    expect((await context.cookies(PORTAL)).find((x) => x.name === COOKIE)).toBeUndefined();
  });
});

test.describe('AC-11.9 headers on /r/ and /v/ pages (REQ-SEC-089/090)', () => {
  for (const path of [`/r/${T('ok')}`, `/r/${T('ok')}/code`, `/r/${T('ok')}/report`, `/v/${T('qrok')}`, `/v/${T('qrunk')}`]) {
    test(`headers ${path.replace(/0{4,}/, '…')}`, async ({ request }) => {
      const h = (await request.get(path, { maxRedirects: 0 })).headers();
      expect(h['referrer-policy']).toBe('no-referrer');
      expect(h['cache-control']).toContain('no-store');
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['strict-transport-security']).toMatch(/max-age=63072000/);
      const csp = h['content-security-policy'] ?? h['content-security-policy-report-only'];
      expect(csp, 'CSP header').toBeTruthy();
      expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(/form-action 'self'/);
      expect(csp).toMatch(/default-src 'self'/);
    });
  }
  test('no third-party requests (all sub-requests stay on the portal origin)', async ({ page }) => {
    const origins = new Set<string>();
    page.on('request', (r) => { origins.add(new URL(r.url()).origin); });
    await page.goto(`/r/${T('ok')}`);
    await page.goto(`/v/${T('qrok')}`);
    expect([...origins]).toEqual([PORTAL]);
  });
  test('client IP: X-Forwarded-For is forwarded as received with the portal BFF key (D-32)', async ({ request }) => {
    await request.get(`/v/${T('qrok')}`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    const q = (await apiLog()).find((r) => r.url === '/v1/reporting/verifications');
    expect(q.xff).toBe('203.0.113.7');
    expect(q.bffKey).toBe(BFF_KEY);
    expect(JSON.stringify(q)).not.toMatch(/\?/); // token in body, not URL
    expect(q.body).toEqual({ qr_token: T('qrok') });
  });
  test('state changes are POST only with an Origin check (REQ-SEC-091/092)', async ({ request }) => {
    expect((await request.get(`/r/${T('exp')}/reissue`, { maxRedirects: 0 })).status()).toBe(405);
    const bad = await request.post(`/r/${T('exp')}/reissue`, { headers: { origin: 'https://evil.example' }, maxRedirects: 0 });
    expect(bad.status()).toBe(403);
    expect((await apiLog()).some((r) => r.url === '/v1/reporting/portal/link-reissues')).toBe(false);
  });
});

test.describe('AC-11.11 Health summary', () => {
  test('NULL snapshot: no heading, no placeholder', async ({ page }) => {
    await login(page, 'ok');
    await expect(page.getByText(/health summary/i)).toHaveCount(0);
  });
  test('set snapshot: read-only section with N1 + disclaimerText, no controls, no links', async ({ page }) => {
    await login(page, 'smart');
    const sec = page.locator('section', { has: page.getByRole('heading', { name: 'Health summary' }) });
    await expect(sec).toBeVisible();
    await expect(sec).toContainText("This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor.");
    await expect(sec).toContainText('SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS');
    await expect(sec).toContainText('Serum Ferritin');
    expect(await sec.locator('input, button, select, textarea, a').count()).toBe(0);
    const calls = (await apiLog()).map((r) => r.url);
    expect(calls.every((u) => u.startsWith('/v1/reporting/'))).toBe(true); // zero SmartReport calls on the request path
  });
  test('unrenderable snapshot: error copy; rest of the page and Download unaffected', async ({ page }) => {
    await login(page, 'badsmart');
    await expect(page.getByRole('heading', { name: 'Health summary' })).toBeVisible();
    await expect(page.getByText('Your health summary cannot be shown right now. Your full report is available to download above.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download PDF' }).or(page.getByRole('button', { name: 'Download PDF' }))).toBeVisible();
  });
});

test.describe('AC-10.1 / 10.2 / 10.3 QR verify', () => {
  test('valid: genuine banner + only the allowed fields', async ({ page }) => {
    await page.goto(`/v/${T('qrok')}`);
    await expect(page.getByText('This report is genuine.')).toBeVisible();
    const t = await page.locator('main').innerText();
    for (const k of ['Laboratory', 'Patient', 'Tests', 'Issued', 'Version']) expect(t).toContain(k);
    expect(t).toContain('Test Diagnostics');
    expect(t).toContain('A.B.');
    expect(t).toContain('Complete Blood Count');
    expect(t).not.toMatch(/phone|address|date of birth|result|\bDOB\b/i);
  });
  test('superseded status', async ({ page }) => {
    await page.goto(`/v/${T('qrsup')}`);
    await expect(page.getByText(/Superseded — a newer version of this report exists|This report was replaced by a newer version\./)).toBeVisible();
    await expect(page.getByText('This report is genuine.')).toHaveCount(0);
  });
  test('unknown / revoked / unreleased / malformed: status, headers and body identical', async ({ request }) => {
    const shots: string[] = [];
    for (const tok of [T('qrunk'), T('qrrev'), T('qrunrel'), 'x!']) {
      const r = await request.get(`/v/${tok}`, { maxRedirects: 0 });
      const h = { ...r.headers() }; delete h.date; delete h['content-length']; delete h.etag; delete h['x-request-id'];
      shots.push(norm(JSON.stringify({ s: r.status(), h, b: (await r.text()).split(tok).join('TOKEN') })));
    }
    expect(new Set(shots).size).toBe(1);
    expect(JSON.parse(shots[0]).s).toBe(404); // AC-10.3: 404 reporting.verify_not_found
  });
  test('not-found copy; rate limit copy; API 500 -> generic error with reference id', async ({ page }) => {
    await page.goto(`/v/${T('qrunk')}`);
    await expect(page.getByText("We couldn't verify this report.")).toBeVisible();
    await page.goto(`/v/${T('qrrl')}`);
    await expect(page.getByText(/Too many attempts\. Please try again in \d+ minutes?\./)).toBeVisible();
    await page.goto(`/v/${T('qrboom')}`);
    await expect(page.getByText('Something went wrong. Please try again later.')).toBeVisible();
  });
});

test.describe('works at 320 px; touch targets; axe (WCAG 2.2 AA)', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  const states: Array<[string, (p: Page) => Promise<void>]> = [
    ['landing', async (p) => { await p.goto(`/r/${T('ok')}`); }],
    ['code', async (p) => { await p.goto(`/r/${T('ok')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText('Code sent to the mobile number registered with the lab.')).toBeVisible(); }],
    ['code-error', async (p) => { await p.goto(`/r/${T('ok')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await enterCode(p, '000000'); const v = p.getByRole('button', { name: 'View report' }); if (await v.isVisible().catch(() => false)) await v.click(); await expect(p.getByText(/That code is not right\./)).toBeVisible(); }],
    ['report', async (p) => { await login(p, 'ok'); }],
    ['report-updated-smart', async (p) => { await login(p, 'smart'); await expect(p.getByRole('heading', { name: 'Health summary' })).toBeVisible(); }],
    ['invalid-link', async (p) => { await p.goto(`/r/${T('unk')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText('This link is not valid.', { exact: false })).toBeVisible(); }],
    ['reissue-confirmation', async (p) => { await p.goto(`/r/${T('exp')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await p.getByRole('button', { name: 'Request a new link' }).click(); await expect(p.getByText('If this link was sent to you', { exact: false })).toBeVisible(); }],
    ['rate-limited', async (p) => { await p.goto(`/r/${T('rl')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText(/Too many attempts/)).toBeVisible(); }],
    ['qr-valid', async (p) => { await p.goto(`/v/${T('qrok')}`); }],
    ['qr-superseded', async (p) => { await p.goto(`/v/${T('qrsup')}`); }],
    ['qr-not-found', async (p) => { await p.goto(`/v/${T('qrunk')}`); }],
    ['app-fallback-report', async (p) => { await p.goto(`/app/reports/01900000-0000-7000-8000-000000000001`); await expect(p.getByText('Open the link the lab sent you to view this report.')).toBeVisible(); }],
    ['app-fallback-other', async (p) => { await p.goto(`/app/anything/else`); await expect(p.getByText('Open the app to continue.')).toBeVisible(); }],
  ];
  for (const [name, go] of states) {
    test(`${name}: no horizontal scroll, lang, title, axe 0 violations`, async ({ page }) => {
      await go(page);
      await noOverflow(page);
      expect(await page.locator('html').getAttribute('lang')).toBeTruthy();
      expect((await page.title()).trim().length).toBeGreaterThan(0);
      await expect(page.locator('main')).toHaveCount(1);
      expect(await axeScan(page)).toEqual([]);
    });
  }
  test('44 px touch targets on primary actions', async ({ page }) => {
    await page.goto(`/r/${T('ok')}`);
    const box = await page.getByRole('button', { name: 'Send me a code' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });
  test('app fallbacks carry no data and no PHI', async ({ page }) => {
    await page.goto(`/app/reports/01900000-0000-7000-8000-000000000001`);
    expect((await apiLog()).length).toBe(0);
  });
});

test.describe('well-known files (D-38)', () => {
  test('Android assetlinks + iOS AASA served as JSON from /.well-known without cookies', async ({ request }) => {
    const a = await request.get('/.well-known/assetlinks.json');
    expect(a.status()).toBe(200);
    expect(Array.isArray(await a.json())).toBe(true);
    const i = await request.get('/.well-known/apple-app-site-association');
    expect(i.status()).toBe(200);
    expect(typeof (await i.json())).toBe('object');
  });
});
