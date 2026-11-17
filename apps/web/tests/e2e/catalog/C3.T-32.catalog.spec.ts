// C3.T-32 nightly E2E — SCR-06…08 permission gating through the real BFF + stub C2.
// C3-owned location + own config (./playwright.config.ts) so the C0 T0D-14 suite (tests/web-e2e) never matches it.
// Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions carrying catalog permissions — `sid-catalog-read` (catalog.test.read),
// `sid-catalog-manage` (read+manage), `sid-catalog-publish` (read+manage+reference_range.publish) — and a stubbed
// /v1/catalog/* origin (LIMS_ORIGIN_API currently points at C2 only). Full publish-with-step-up flow (F-03) is exercised
// once that stub exists; until then these tests fail at the missing sessions, which is the intended red state.
import { test, expect, type BrowserContext } from '@playwright/test';

const TEST_ID = '01a1a98a-ac40-7000-8000-0000000c3101';
const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const navLink = (page: import('@playwright/test').Page, href: string) => page.getByRole('navigation').locator(`a[href="${href}"]`);

test.describe('SCR-06 nav + route gating (04-UI-UX §1)', () => {
  test('catalog.test.read: Catalog › Tests nav entry visible and /catalog/tests renders', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-read');
    await page.goto('/catalog/tests');
    await expect(navLink(page, '/catalog/tests')).toBeVisible();
    await expect(page.getByRole('heading', { name: /tests/i })).toBeVisible();
  });

  test('without catalog.test.read: nav entry hidden, direct visit shows permission-denied (no catalog data)', async ({ page, context }) => {
    await useSid(context, 'sid-limited');
    await page.goto('/catalog/tests');
    await expect(navLink(page, '/catalog/tests')).toHaveCount(0);
    await expect(page.getByTestId('permission-denied')).toBeVisible();
  });
});

test.describe('SCR-07 publish is gated by BOTH permissions (AC-03.6)', () => {
  test('manage only: Publish disabled, tooltip names catalog.reference_range.publish', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-manage');
    await page.goto(`/catalog/tests/${TEST_ID}?analyte=01a1a98a-ac40-7000-8000-0000000c3201`);
    await page.getByRole('button', { name: /edit draft/i }).click();
    const publish = page.getByRole('button', { name: /^publish$/i });
    await expect(publish).toBeDisabled();
    await expect(page.getByText('catalog.reference_range.publish')).toBeVisible();
  });

  test('manage + publish: dialog shows lock + "Requires two-step verification"; the BFF never exposes the bearer token to the page', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-publish');
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.headers()['authorization'] ?? ''));
    await page.goto(`/catalog/tests/${TEST_ID}?analyte=01a1a98a-ac40-7000-8000-0000000c3201`);
    await page.getByRole('button', { name: /edit draft/i }).click();
    await page.getByRole('button', { name: /^publish…?$|^publish$/i }).click();
    await expect(page.getByText(/Requires two-step verification/i)).toBeVisible();
    expect(seen.filter(Boolean)).toEqual([]); // REQ-SEC-068
  });
});

test.describe('SCR-08 ranges tab (AC-05.9)', () => {
  test('?tab=ranges renders the band grid with the boundary help text; read-only user sees no Save/Publish', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-read');
    await page.goto(`/catalog/tests/${TEST_ID}?analyte=01a1a98a-ac40-7000-8000-0000000c3201&tab=ranges`);
    await expect(page.getByText('Lower age is included, upper age is not.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /^save/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^publish/i })).toHaveCount(0);
  });
});
