// T0D-14 Web core + shell — Playwright. AC-0D-7.1..7.4, 7.6; REQ-SEC-068/089/091; 08 R10, A18.1, A25 D-206.
// Needs apps/web (T0D-14) + stub-c2.mjs (started by playwright.config.ts). Synthetic data only.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LWFjdG9yIn0.c3R1Yi1zaWduYXR1cmU'; // same as stub-c2.mjs
const WEB = 'http://localhost:3100';
const C2 = 'http://127.0.0.1:4100';
const BFF_KEY = 'test-bff-key-0123456789abcdef';
const LAB = '/lab/status-board'; // routes.yaml staff.lab.status_board  (lab.status_board.read)
const CASH = '/billing/daily-cash'; // routes.yaml staff.billing.daily_cash (billing.cash_report.read)

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, url: WEB, httpOnly: true, secure: true, sameSite: 'Lax' }]);
const c2Log = async (): Promise<any[]> => (await fetch(`${C2}/__requests`)).json();
const c2Reset = () => fetch(`${C2}/__requests`, { method: 'DELETE' });
const c2Control = (sid: string, mode: 'expired' | 'ok') =>
  fetch(`${C2}/__control`, { method: 'POST', body: JSON.stringify({ sid, mode }) });
const navLink = (page: Page, href: string) => page.getByRole('navigation').locator(`a[href="${href}"]`);

test.beforeEach(async () => { await c2Reset(); await c2Control('sid-flip', 'ok'); });

test.describe('AC-0D-7.1 nav filtered by permission; direct visit denied', () => {
  test('full permissions: sample nav renders both entries', async ({ page, context }) => {
    await useSid(context, 'sid-full');
    await page.goto(LAB);
    await expect(navLink(page, LAB)).toBeVisible();
    await expect(navLink(page, CASH)).toBeVisible();
  });

  test('without billing.cash_report.read: entry hidden, direct visit renders permission-denied', async ({ page, context }) => {
    await useSid(context, 'sid-limited');
    await page.goto(LAB);
    await expect(navLink(page, LAB)).toBeVisible();
    await expect(navLink(page, CASH)).toHaveCount(0);
    await page.goto(CASH);
    await expect(page.getByTestId('permission-denied')).toBeVisible();
  });
});

test.describe('AC-0D-7.2 session timeouts; BFF delegates to C2 resolveSession', () => {
  test('BFF calls resolveSession with the BFF key and the opaque cookie, touch:true for user requests', async ({ page, context }) => {
    await useSid(context, 'sid-full');
    await page.goto(LAB);
    const calls = await c2Log();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.sid).toBe('sid-full');
      expect(c.bffKey).toBe(BFF_KEY);
      expect(c.body).toEqual({ touch: true });
    }
  });

  test('X-Lims-Background: 1 maps to touch:false (D-206)', async ({ context }) => {
    await useSid(context, 'sid-full');
    const cookies = await context.cookies(WEB);
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const r = await fetch(`${WEB}${LAB}`, { headers: { cookie, 'x-lims-background': '1' } });
    expect(r.status).toBe(200);
    const calls = await c2Log();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.body?.touch === false)).toBe(true);
  });

  test('C2 401 auth.session_expired is relayed and the shell shows sign-in', async ({ page, context }) => {
    await useSid(context, 'sid-expired');
    const res = await page.goto(LAB);
    expect(res!.status()).toBe(401);
    await expect(page.getByText(/sign in|session expired/i).first()).toBeVisible();
    const json = await context.request.get(LAB, { headers: { accept: 'application/json' } });
    expect(json.status()).toBe(401);
    expect((await json.json()).code).toBe('auth.session_expired');
  });

  test('no cookie / wrong cookie name / unknown sid → sign-in, never the shell', async ({ page, context }) => {
    await page.goto(LAB);
    await expect(navLink(page, LAB)).toHaveCount(0);
    await expect(page.getByText(/sign in/i).first()).toBeVisible();
    await context.addCookies([{ name: 'lims_sid', value: 'sid-full', url: WEB }]); // no __Host- prefix: must be ignored
    await page.goto(LAB);
    await expect(navLink(page, LAB)).toHaveCount(0);
    await useSid(context, 'sid-bogus');
    await page.goto(LAB);
    await expect(navLink(page, LAB)).toHaveCount(0);
  });

  test('warning dialog 2 min before expiry; "Stay signed in" keeps alive (touch:true); expiry then shows sign-in', async ({ page, context }) => {
    await useSid(context, 'sid-expiring'); // stub: idle_expires_at = now + 90 s
    await page.goto(LAB);
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText("You'll be signed out in 2 minutes because of inactivity.");
    await expect(dlg.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await c2Reset();
    await dlg.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(dlg).toBeHidden();
    await expect.poll(async () => (await c2Log()).some((c) => c.body?.touch === true)).toBe(true);

    await useSid(context, 'sid-flip');
    await page.goto(LAB);
    await expect(navLink(page, LAB)).toBeVisible();
    await c2Control('sid-flip', 'expired');
    const res = await page.goto(LAB);
    expect(res!.status()).toBe(401);
    await expect(page.getByText(/sign in|session expired/i).first()).toBeVisible();
  });
});

test.describe('AC-0D-7.3 no tokens or Supabase client in the browser; cookie flags (REQ-SEC-068)', () => {
  test('session cookie is __Host-lims_sid: HttpOnly, Secure, SameSite=Lax, path=/, no Domain', async ({ page, context }) => {
    await useSid(context, 'sid-full');
    await page.goto(LAB);
    const c = (await context.cookies(WEB)).find((x) => x.name === '__Host-lims_sid')!;
    expect(c).toBeTruthy();
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.path).toBe('/');
    expect(await page.evaluate(() => document.cookie)).not.toContain('lims_sid');
    // any cookie the server sets itself must also carry the flags
    const res = await page.request.get(LAB);
    for (const h of res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')) {
      expect(h.value).toMatch(/HttpOnly/i);
      expect(h.value).toMatch(/Secure/i);
      expect(h.value).toMatch(/SameSite=Lax/i);
      expect(h.value).not.toMatch(/Domain=/i);
    }
  });

  test('no JWT, access/refresh token, BFF key or @supabase/* in any response the browser receives', async ({ page, context }) => {
    await useSid(context, 'sid-full');
    const bodies: string[] = [];
    page.on('response', async (r) => {
      const t = r.headers()['content-type'] ?? '';
      if (/json|javascript|html|text|event-stream/.test(t)) bodies.push(await r.text().catch(() => ''));
      const h = JSON.stringify(r.headers());
      bodies.push(h);
    });
    await page.goto(LAB);
    await page.waitForLoadState('networkidle');
    const all = bodies.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(FAKE_JWT);
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/);
    expect(all).not.toContain(BFF_KEY);
    expect(all).not.toMatch(/@supabase\/|supabase-js|GoTrueClient/);
    expect(all).not.toMatch(/refresh_token|access_token/);
    const storage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(storage).not.toMatch(/eyJ|token|supabase/i);
  });
});

test.describe('AC-0D-7.4 CSRF: Origin / Sec-Fetch-Site check (REQ-SEC-091)', () => {
  const csrf = async (res: any) => {
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('auth.csrf_failed');
  };
  test.beforeEach(async ({ context }) => { await useSid(context, 'sid-full'); });

  test('cross-origin POST is rejected 403 auth.csrf_failed', async ({ context }) => {
    await csrf(await context.request.post(LAB, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, data: {} }));
  });
  test('Origin mismatch alone, and Sec-Fetch-Site: cross-site alone, are each rejected', async ({ context }) => {
    await csrf(await context.request.post(LAB, { headers: { origin: 'https://evil.example' }, data: {} }));
    await csrf(await context.request.post(LAB, { headers: { origin: WEB, 'sec-fetch-site': 'cross-site' }, data: {} }));
  });
  test('same for PUT / PATCH / DELETE and for form-encoded bodies', async ({ context }) => {
    for (const m of ['put', 'patch', 'delete'] as const)
      await csrf(await context.request[m](LAB, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }));
    await csrf(await context.request.post(LAB, { headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' }, data: 'a=1' }));
  });
  test('same-origin POST is not rejected by the CSRF check', async ({ context }) => {
    const r = await context.request.post(LAB, { headers: { origin: WEB, 'sec-fetch-site': 'same-origin' }, data: {} });
    const body = await r.text();
    expect(body).not.toContain('auth.csrf_failed');
  });
  test('safe methods are not blocked by it', async ({ context }) => {
    const r = await context.request.get(LAB, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    expect(r.status()).not.toBe(403);
  });
});

test.describe('AC-0D-7.6 CSP header test (REQ-SEC-089, 08 A18.1)', () => {
  const cspOf = (h: Record<string, string>) => h['content-security-policy'] ?? h['content-security-policy-report-only'] ?? '';
  const directive = (csp: string, name: string) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) ?? '';

  test('per-request nonce, img-src \'self\' data:, no remote image origin, nonce on inline scripts', async ({ context }) => {
    await useSid(context, 'sid-full');
    const r1 = await context.request.get(LAB);
    const r2 = await context.request.get(LAB);
    const csp1 = cspOf(r1.headers()), csp2 = cspOf(r2.headers());
    expect(csp1).not.toBe('');
    expect(directive(csp1, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp1, 'img-src')).toBe("img-src 'self' data:");
    expect(directive(csp1, 'script-src')).toMatch(/^script-src 'self' 'nonce-[A-Za-z0-9+/=_-]{16,}'/);
    expect(directive(csp1, 'script-src')).not.toContain('unsafe-inline');
    expect(csp1).not.toMatch(/img-src[^;]*https?:/);
    const n = (c: string) => /'nonce-([^']+)'/.exec(c)![1];
    expect(n(csp1)).not.toBe(n(csp2));
    const html = await r1.text();
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      if (!/\bsrc=/.test(m[1]!)) expect(m[1]).toContain(`nonce="${n(csp1)}"`);
    }
  });

  test('the sign-in (401) response and other staff pages carry the CSP too', async ({ context }) => {
    await useSid(context, 'sid-expired');
    expect(cspOf((await context.request.get(LAB)).headers())).toContain("img-src 'self' data:");
    await useSid(context, 'sid-full');
    expect(cspOf((await context.request.get(CASH)).headers())).toContain("img-src 'self' data:");
  });

  test('no remote image is requested while rendering the shell', async ({ page, context }) => {
    await useSid(context, 'sid-full');
    const remote: string[] = [];
    page.on('request', (rq) => { if (rq.resourceType() === 'image' && !rq.url().startsWith(WEB) && !rq.url().startsWith('data:')) remote.push(rq.url()); });
    await page.goto(LAB);
    await page.waitForLoadState('networkidle');
    expect(remote).toEqual([]);
  });
});
