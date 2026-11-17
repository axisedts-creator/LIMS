// C3.T-34 nightly E2E — SCR-13…17 through the real BFF + stub C2 (own config: ./playwright.config.ts; not part of the per-task verify).
// Synthetic data only. NEEDS (writer/lead): stub sessions `sid-catalog-read` (catalog.price_list.read) and `sid-catalog-finance`
// (read + manage + identity.centre.read) and a stubbed /v1/catalog origin serving one default list with a published v1 and a draft v2 (ids below);
// until then these tests fail at the missing sessions/routes, which is the intended red state.
import { test, expect, type BrowserContext } from '@playwright/test';

const PL = '01a1a98a-ac40-7000-8000-0000000f0061';
const DRAFT = '01a1a98a-ac40-7000-8000-0000000f0073';
const PUBLISHED = '01a1a98a-ac40-7000-8000-0000000f0071';
const DISCLAIMER = 'Tax treatment of lab services is pending confirmation by your auditor';
const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const navLink = (page: import('@playwright/test').Page, href: string) => page.getByRole('navigation').locator(`a[href="${href}"]`);

test.describe('nav + route gating (SCR-13…17)', () => {
  test('catalog.price_list.read: the four Pricing entries are visible and each page renders', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-read');
    await page.goto('/catalog/price-lists');
    for (const href of ['/catalog/price-lists', '/catalog/price-simulator', '/catalog/surcharges', '/catalog/tax']) await expect(navLink(page, href)).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('without catalog.price_list.read: entries hidden and direct visits show permission-denied', async ({ page, context }) => {
    await useSid(context, 'sid-limited');
    for (const p of ['/catalog/price-lists', '/catalog/price-simulator', '/catalog/surcharges', '/catalog/tax']) {
      await page.goto(p);
      await expect(navLink(page, p)).toHaveCount(0);
      await expect(page.getByTestId('permission-denied')).toBeVisible();
    }
  });
});

test.describe('tax disclaimer everywhere (AC-15.4)', () => {
  for (const p of ['/catalog/tax', '/catalog/price-simulator']) {
    test(`${p} shows the auditor disclaimer`, async ({ page, context }) => {
      await useSid(context, 'sid-catalog-read');
      await page.goto(p);
      await expect(page.getByText(DISCLAIMER, { exact: false }).first()).toBeVisible();
    });
  }
});

test.describe('SCR-14 editor: unsaved guard + publish', () => {
  test('editing a price arms the beforeunload prompt; leaving without saving is blocked', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-finance');
    await page.goto(`/catalog/price-lists/${PL}/versions/${DRAFT}`);
    const cell = page.getByRole('grid').getByRole('gridcell').nth(4);
    await cell.dblclick();
    await page.getByRole('grid').getByRole('textbox').fill('1234.50');
    await page.keyboard.press('Enter');
    let prompted = false;
    page.once('dialog', async (d) => { prompted = d.type() === 'beforeunload'; await d.dismiss(); });
    await page.close({ runBeforeUnload: true });
    expect(prompted).toBe(true);
  });

  test('Publish… shows the lock + "Requires two-step verification"; the bearer token never reaches the page (REQ-SEC-068)', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-finance');
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.headers()['authorization'] ?? ''));
    await page.goto(`/catalog/price-lists/${PL}/versions/${DRAFT}`);
    await page.getByRole('button', { name: /^publish/i }).click();
    await expect(page.getByText(/Requires two-step verification/i)).toBeVisible();
    expect(seen.filter(Boolean)).toEqual([]);
  });

  test('read-only user: published version has a read-only grid and no Save / Publish; draft shows none either', async ({ page, context }) => {
    await useSid(context, 'sid-catalog-read');
    for (const v of [PUBLISHED, DRAFT]) {
      await page.goto(`/catalog/price-lists/${PL}/versions/${v}`);
      await expect(page.getByRole('grid')).toHaveAttribute('aria-readonly', 'true');
      await expect(page.getByRole('button', { name: /^(save|publish)/i })).toHaveCount(0);
    }
  });
});
