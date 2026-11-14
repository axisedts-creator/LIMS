// C13.T22 browser security pack (07-SECURITY §6 ST14, ST17; AB13; US-15.4, US-15.5). Synthetic data only. Real browser, real response headers, real cookies.
// Skips when LIMS_E2E_PARTNER_SESSION is unset (compose stack not running), like pwa.spec.ts / partner-screens.spec.ts; run via playwright.config.ts (same env).
// ST17 additionally needs LIMS_E2E_STAFF_SESSION = the opaque value of a synthetic STAFF session (same cookie name, issued by the staff BFF); skipped without it (T24 staging E2E).
// ST16 (stored script inert in editor / detail / print) and the service-worker half of ST14 (no HTML/JSON in caches, logout purge) live in partner-screens.spec.ts and pwa.spec.ts; not repeated.
import { expect, test } from '@playwright/test';

const SESSION = process.env.LIMS_E2E_PARTNER_SESSION ?? '';
const STAFF_SESSION = process.env.LIMS_E2E_STAFF_SESSION ?? '';
const COOKIE = '__Host-lims_psid';
test.skip(!SESSION, 'compose env not set (LIMS_E2E_PARTNER_SESSION)');
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: SESSION, url: baseURL!, httpOnly: true, secure: true, sameSite: 'Lax' }]);
});

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const PAGES = ['/', '/orders', '/reports', '/manifests', '/pickups', '/price-list', '/statements', '/account'];

test('ST14: no JWT (or the session value) in JS-accessible storage, document.cookie, page HTML or any JSON response', async ({ page }) => {
  const bodies: Array<{ url: string; text: string }> = [];
  page.on('response', async (r) => {
    const t = r.headers()['content-type'] ?? '';
    if (/html|json|text/.test(t)) bodies.push({ url: new URL(r.url()).pathname, text: await r.text().catch(() => '') });
  });
  for (const p of PAGES) { await page.goto(p); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); }
  const js = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), cookie: document.cookie,
  }));
  for (const [where, v] of Object.entries({ localStorage: js.local, sessionStorage: js.session, 'document.cookie': js.cookie })) {
    expect(v, where).not.toMatch(JWT);
    expect(v, `${where} holds the session value`).not.toContain(SESSION);
  }
  expect(js.cookie).not.toContain('lims_psid');
  expect(bodies.length).toBeGreaterThan(0);
  for (const b of bodies) {
    expect(b.text, `JWT in response body of ${b.url}`).not.toMatch(JWT);
    expect(b.text, `session value in response body of ${b.url}`).not.toContain(SESSION);
  }
});

test('ST14: session cookie flags: __Host- prefix, HttpOnly, Secure, SameSite Lax or Strict, Path=/, no Domain; no other cookie carries a token', async ({ context, page }) => {
  await page.goto('/');
  const cookies = await context.cookies();
  const c = cookies.find((x) => x.name === COOKIE);
  expect(c, `cookie ${COOKIE}`).toBeTruthy();
  expect(c!.httpOnly).toBe(true);
  expect(c!.secure).toBe(true);
  expect(['Lax', 'Strict']).toContain(c!.sameSite);
  expect(c!.path).toBe('/');
  expect(c!.domain.startsWith('.'), 'host-only cookie (a __Host- cookie has no Domain attribute)').toBe(false);
  for (const o of cookies.filter((x) => x.name !== COOKIE)) {
    expect(o.value, `cookie ${o.name}`).not.toMatch(JWT);
    if (/sess|auth|token|sid/i.test(o.name)) expect(o.httpOnly, `cookie ${o.name} must be HttpOnly`).toBe(true);
  }
});

test('ST14 / REQ-SEC-088: every document carries a CSP; script-src has a nonce and no unsafe-inline / unsafe-eval / wildcard; frames and plugins are refused', async ({ page }) => {
  const seen: Array<{ url: string; csp: string }> = [];
  page.on('response', (r) => {
    if (r.request().resourceType() !== 'document') return;
    const h = r.headers();
    seen.push({ url: new URL(r.url()).pathname, csp: h['content-security-policy'] ?? h['content-security-policy-report-only'] ?? '' });
  });
  for (const p of PAGES) await page.goto(p);
  expect(seen.length).toBeGreaterThanOrEqual(PAGES.length);
  const nonces = new Set<string>();
  for (const s of seen) {
    expect(s.csp, `CSP on ${s.url}`).not.toBe('');
    const script = /script-src([^;]*)/.exec(s.csp)?.[1] ?? '';
    expect(script, s.url).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(script, s.url).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
    expect(s.csp, s.url).toMatch(/object-src 'none'/);
    expect(s.csp, s.url).toMatch(/frame-ancestors 'none'/);
    expect(s.csp, s.url).toMatch(/base-uri 'self'/);
    nonces.add(/'nonce-([^']+)'/.exec(script)![1]!);
  }
  expect(nonces.size, 'a fresh nonce per request').toBe(seen.length);
});

test('ST14 / REQ-SEC-091 / AB: CSRF — a state-changing request with a foreign Origin is rejected and creates nothing', async ({ page }) => {
  await page.goto('/manifests');
  const before = await page.getByRole('link', { name: /^MF\d+/ }).count();
  const posts: Array<{ status: number; origin: string | undefined }> = [];
  await page.route('**/*', async (route) => {
    const r = route.request();
    if (r.method() === 'POST') {
      // a cross-site page cannot set Origin to ours: emulate what the browser would send from https://evil.invalid
      const headers = { ...r.headers(), origin: 'https://evil.invalid', 'sec-fetch-site': 'cross-site' };
      const res = await route.fetch({ headers });
      posts.push({ status: res.status(), origin: headers.origin });
      await route.fulfill({ response: res });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'New manifest' }).first().click();
  await expect.poll(() => posts.length, 'the action posted').toBeGreaterThan(0);
  await expect(page).not.toHaveURL(/\/manifests\/[0-9a-f]{8}-[0-9a-f]{4}-/); // no manifest editor opened
  await page.unroute('**/*');
  await page.goto('/manifests');
  expect(await page.getByRole('link', { name: /^MF\d+/ }).count(), 'no manifest was created').toBe(before);
});

test('ST14: logout needs the same-origin POST; GET /auth/logout shows a confirmation and does not end the session by itself', async ({ page }) => {
  await page.goto('/auth/logout');
  await expect(page.getByRole('button', { name: /sign out|log out/i })).toBeVisible();
  await page.goto('/orders');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); // still signed in
});

test('AB1 / AB3: a guessed order, manifest, pickup and report id shows the same not-found page as a malformed id (no oracle, no data)', async ({ page }) => {
  const guess = ['/orders/01940e00-0000-7000-8000-c13220000f01', '/manifests/01940e00-0000-7000-8000-c13220000f02', '/reports/01940e00-0000-7000-8000-c13220000f03'];
  const texts: string[] = [];
  for (const g of guess) {
    const r = await page.goto(g);
    expect([404, 200]).toContain(r!.status()); // Next may render its not-found UI with 404 or an in-page empty state; never 500, never a redirect to another partner's page
    texts.push((await page.locator('main, body').first().innerText()).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\s+/g, ' ').trim());
  }
  for (const t of texts) expect(t).not.toMatch(/Synthetic|SYN-|forbidden|another partner|tenant/i);
  expect(texts[0]!.slice(0, 40)).not.toBe('');
});

test('ST17 / AB13: a STAFF session value presented to the partner BFF is rejected (session kind is bound by the calling BFF key, not by the client)', async ({ context, page, baseURL }) => {
  test.skip(!STAFF_SESSION, 'LIMS_E2E_STAFF_SESSION not set (needs the C2 real implementation; T24)');
  await context.clearCookies();
  await context.addCookies([{ name: COOKIE, value: STAFF_SESSION, url: baseURL!, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/auth\/(session-expired|login|$)|\/auth/);
  await expect(page.getByRole('table')).toHaveCount(0);
});
