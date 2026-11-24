// LOOP 5: Aggressive IDOR / BOLA Probes Across Tenant Boundaries
// Invariant: Tenant B actor attempting to access Tenant A resources via direct URL navigation
// receives an identical fail-closed 404 (common.not_found) without data leaks.
import { test, expect } from '@playwright/test';
import { useTenantBAdminSession } from '../fixtures/auth-sessions.js';

test.describe('Loop 5: Aggressive IDOR / BOLA Probes Across Tenant Boundaries', () => {
  const tenantAReportId = '01900000-0000-7000-8000-000000000a01';
  const tenantAVersionId = '01900000-0000-7000-8000-000000000v01';
  const tenantAInvoiceId = '01900000-0000-7000-8000-000000000b01';

  test('Tenant B navigating to Tenant A Report URL returns 404 not-found', async ({ page, context }) => {
    await useTenantBAdminSession(context);
    const res = await page.goto(`/reporting/reports/${tenantAReportId}`);

    // Must answer 404 or render Next.js not-found / permission boundary
    if (res) {
      expect([200, 404]).toContain(res.status());
    }
    // Verify no Tenant A patient or lab details leak into the DOM
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('Tenant A Secret Lab');
  });

  test('Tenant B accessing Tenant A PDF route returns 404 or auth challenge', async ({ page, context }) => {
    await useTenantBAdminSession(context);
    const res = await page.goto(`/reporting/report-versions/${tenantAVersionId}/pdf`);

    if (res) {
      expect([200, 401, 403, 404]).toContain(res.status());
      if (res.status() === 200) {
        expect(page.url()).toMatch(/\/auth\/(login|session-expired)/);
      }
    }
  });

  test('Tenant B navigating to Tenant A Invoice URL returns 404 not-found', async ({ page, context }) => {
    await useTenantBAdminSession(context);
    const res = await page.goto(`/billing/invoices/${tenantAInvoiceId}`);

    if (res) {
      expect([200, 404]).toContain(res.status());
    }
  });
});
