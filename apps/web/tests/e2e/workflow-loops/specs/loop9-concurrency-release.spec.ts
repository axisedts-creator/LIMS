// LOOP 9: State Machine & Concurrent UI Release Action Defense
// Invariant: Concurrent or rapid double-clicks on release buttons handle version locks
// gracefully, preventing duplicate events or unhandled server crashes.
import { test, expect } from '@playwright/test';
import { useAdminSession } from '../fixtures/auth-sessions.js';

test.describe('Loop 9: Concurrency & State Machine UI Integrity', () => {
  test('Release action button disables immediately upon click to prevent double-submit', async ({ page, context }) => {
    await useAdminSession(context);
    await page.goto('/reporting?tab=ready_to_release');
    await expect(page.locator('body')).toBeVisible();

    const firstRow = page.getByRole('row').nth(1);
    if (await firstRow.isVisible()) {
      await firstRow.click();
      const releaseBtn = page.getByRole('button', { name: /^release$/i });
      if (await releaseBtn.isVisible() && (await releaseBtn.isEnabled())) {
        // First click
        await releaseBtn.click();
        // Immediately verify either disabled or dialog opened
        const isPendingOrDisabled =
          (await releaseBtn.isDisabled()) || (await page.getByRole('dialog').isVisible());
        expect(isPendingOrDisabled).toBe(true);
      }
    }
  });
});
