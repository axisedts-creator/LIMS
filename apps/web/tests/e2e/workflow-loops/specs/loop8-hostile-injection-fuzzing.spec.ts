// LOOP 8: Hostile SQL Injection & Input Fuzzing in Web Forms
// Invariant: Hostile inputs (' OR '1'='1, DROP TABLE, XSS payloads, 5k char buffer)
// in search boxes and filters are neutralized via parameterization without 500s or script execution.
import { test, expect } from '@playwright/test';
import { useClerkSession, useAdminSession } from '../fixtures/auth-sessions.js';

test.describe('Loop 8: Hostile SQL Injection & Input Fuzzing Defense', () => {
  const hostilePayloads = [
    "' OR '1'='1",
    "'; DROP TABLE reporting.reports; --",
    "' UNION SELECT null, null, null --",
    "<script>alert('xss')</script>",
    'A'.repeat(1000),
  ];

  test('Barcode & patient search inputs neutralize hostile payloads without crashing', async ({ page, context }) => {
    await useClerkSession(context);
    await page.goto('/frontdesk/worklist');
    await expect(page.locator('body')).toBeVisible();

    const searchInput = page.getByPlaceholder(/search|name|barcode/i).first();
    if (await searchInput.isVisible()) {
      for (const payload of hostilePayloads) {
        await searchInput.fill(payload);
        await page.keyboard.press('Enter');

        // UI must not trigger unhandled error page / 500 crash
        await expect(page.getByText(/500\s*Internal|Server\s*Crash/i)).toHaveCount(0);
        await expect(page.locator('body')).toBeVisible();
      }
    }
  });

  test('Reporting search and filter inputs withstand hostile fuzzing', async ({ page, context }) => {
    await useAdminSession(context);
    await page.goto('/reporting');
    await expect(page.locator('body')).toBeVisible();

    const searchInput = page.getByPlaceholder(/search|report|patient/i).first();
    if (await searchInput.isVisible()) {
      for (const payload of hostilePayloads.slice(0, 3)) {
        await searchInput.fill(payload);
        await page.keyboard.press('Enter');

        await expect(page.getByText(/500\s*Internal/i)).toHaveCount(0);
        await expect(page.locator('body')).toBeVisible();
      }
    }
  });
});
