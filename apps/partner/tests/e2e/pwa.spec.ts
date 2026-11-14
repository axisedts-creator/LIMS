// C13.T20 e2e (tests: "E2E (browser automation)", US-16.2, ST14). Synthetic data only. Skips when LIMS_E2E_PARTNER_SESSION is unset (compose stack not running), like partner-screens.spec.ts.
// Real browser Cache Storage, real response headers, real offline navigation and real logout purge. Run: see playwright.config.ts (same env).
// Optional: LIMS_E2E_PARTNER_ORDER_ID / LIMS_E2E_PARTNER_REPORT_ID = ids of a synthetic order / released report (default: first row of each list).
import { expect, test, type Page } from '@playwright/test';

const SESSION = process.env.LIMS_E2E_PARTNER_SESSION ?? '';
test.skip(!SESSION, 'compose env not set (LIMS_E2E_PARTNER_SESSION)');
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: '__Host-lims_psid', value: SESSION, url: baseURL!, httpOnly: true, secure: true, sameSite: 'Lax' }]);
});

type Entry = { cache: string; path: string; type: string };
const ALLOWED = /^\/(_next\/static|fonts|icons)\//;

async function readyWorker(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // the first page load is not controlled; reload so the worker sees subsequent requests
  await page.reload();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}

async function cacheEntries(page: Page): Promise<Entry[]> {
  return page.evaluate(async () => {
    const out: { cache: string; path: string; type: string }[] = [];
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) {
        const res = await c.match(req);
        out.push({ cache: name, path: new URL(req.url).pathname + new URL(req.url).search, type: res?.headers.get('content-type') ?? '' });
      }
    }
    return out;
  });
}

async function browsePhi(page: Page) {
  await page.goto('/orders');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const order = process.env.LIMS_E2E_PARTNER_ORDER_ID ?? (await page.locator('a[href^="/orders/"]').first().getAttribute('href'))?.split('/').pop();
  expect(order, 'a synthetic order to open').toBeTruthy();
  await page.goto(`/orders/${order}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/reports');
  const report = process.env.LIMS_E2E_PARTNER_REPORT_ID ?? (await page.locator('a[href^="/reports/"]').first().getAttribute('href'))?.split('/').pop();
  expect(report, 'a synthetic released report to open').toBeTruthy();
  await page.goto(`/reports/${report}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

test('US-16.2: Cache Storage after browsing PHI pages holds only hashed static assets + /offline (no HTML/JSON)', async ({ page }) => {
  await readyWorker(page);
  await browsePhi(page);
  const entries = await cacheEntries(page);
  expect(entries.length, 'static assets + /offline are cached').toBeGreaterThan(0);
  for (const e of entries) {
    expect(e.path === '/offline' || ALLOWED.test(e.path), `unexpected cached URL ${e.path}`).toBe(true);
    expect(e.path, 'no query strings (no PHI in cached URLs)').not.toContain('?');
    if (e.path !== '/offline') {
      expect(e.type, e.path).not.toMatch(/text\/html|application\/json|application\/pdf/);
    }
  }
  expect(entries.some((e) => e.path === '/offline')).toBe(true);
  expect(entries.some((e) => /^\/orders|^\/reports|^\/api\//.test(e.path)), 'no PHI route cached').toBe(false);
});

test('Cache-Control: no-store and a CSP on authenticated responses (real headers)', async ({ page }) => {
  const seen: { url: string; cc: string | undefined; pragma: string | undefined; csp: boolean }[] = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.request().resourceType() === 'document' || u.pathname.startsWith('/api/')) {
      const h = r.headers();
      seen.push({ url: u.pathname, cc: h['cache-control'], pragma: h['pragma'], csp: Boolean(h['content-security-policy'] || h['content-security-policy-report-only']) });
    }
  });
  await browsePhi(page);
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) {
    expect(s.cc ?? '', s.url).toMatch(/no-store/i);
    expect(s.pragma ?? '', s.url).toMatch(/no-cache/i);
    if (!s.url.startsWith('/api/')) expect(s.csp, `CSP on ${s.url}`).toBe(true);
  }
});

test('offline: navigating to a PHI page while offline shows the offline page, never cached PHI', async ({ page, context }) => {
  await readyWorker(page);
  await browsePhi(page);
  await context.setOffline(true);
  await page.goto('/orders').catch(() => undefined);
  await expect(page.getByText(/offline/i).first()).toBeVisible();
  await expect(page.locator('table, [data-view="cards"]')).toHaveCount(0); // no cached order list
  await context.setOffline(false);
});

test('sign out purges Cache Storage down to partner-static-v1 and clears sessionStorage', async ({ page }) => {
  await readyWorker(page);
  await browsePhi(page);
  await page.evaluate(() => sessionStorage.setItem('probe', 'synthetic'));
  await page.goto('/auth/logout');
  await page.getByRole('button', { name: /sign out|log out/i }).click();
  await expect(page).toHaveURL(/\/auth\//);
  const names = await page.evaluate(() => caches.keys());
  expect(names.filter((n) => n !== 'partner-static-v1'), 'only the static cache may remain').toEqual([]);
  expect((await cacheEntries(page)).every((e) => e.path === '/offline' || ALLOWED.test(e.path))).toBe(true);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});
