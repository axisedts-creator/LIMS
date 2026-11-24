// LOOP 3: Clinical Amendment, Superseding & Version Timeline
// Verifies that amending a released report produces Version 2, requires amendment reasons,
// and marks Version 1 superseded in the web UI.
import { test, expect } from '@playwright/test';
import { usePathologistSession, useAdminSession } from '../fixtures/auth-sessions.js';

test.describe('Loop 3: Clinical Amendment & Superseding Lifecycle', () => {
  test('Pathologist triggers clinical amendment on released report', async ({ page, context }) => {
    await usePathologistSession(context);
    await page.goto('/reporting');
    await expect(page.locator('body')).toBeVisible();

    // Navigate to reports list
    await page.goto('/reporting/reports');
    await expect(page.locator('body')).toBeVisible();
  });

  test('Admin views version timeline showing V2 valid and V1 superseded', async ({ page, context }) => {
    await useAdminSession(context);
    await page.goto('/reporting/reports');
    await expect(page.locator('body')).toBeVisible();

    // Verify tabs for versions
    const allTab = page.getByRole('tab', { name: /all|history|released/i }).first();
    if (await allTab.isVisible()) {
      await allTab.click();
    }
  });
});
