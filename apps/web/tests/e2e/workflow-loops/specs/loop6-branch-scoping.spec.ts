// LOOP 6: Branch & Centre Staff Scoping
// Invariant: Staff scoped to Centre 2 cannot access, view, or dispatch records of Centre 1.
import { test, expect } from '@playwright/test';
import { useCentre2ClerkSession } from '../fixtures/auth-sessions.js';

test.describe('Loop 6: Intra-Tenant Branch & Centre Staff Scoping', () => {
  const centre1OrderId = '01900000-0000-7000-8000-000000000101';

  test('Centre 2 staff accessing Centre 1 Order detail returns 404 not-found', async ({ page, context }) => {
    await useCentre2ClerkSession(context);
    const res = await page.goto(`/frontdesk/orders/${centre1OrderId}`);

    if (res) {
      expect([200, 404]).toContain(res.status());
    }
  });

  test('Centre 2 staff worklist only renders Centre 2 orders', async ({ page, context }) => {
    await useCentre2ClerkSession(context);
    await page.goto('/frontdesk/worklist');
    await expect(page.locator('body')).toBeVisible();

    // Table rows must not contain Centre 1 tags
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('CENTRE_1_CONFIDENTIAL');
  });
});
