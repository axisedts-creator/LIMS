// C10.T-19 e2e smoke (plan row: "component (MSW), e2e smoke"; AC-02.1, AC-02.2). Keyboard-first: worklist loads with five tabs -> Alt+B focuses the scan field ->
// scan opens the culture -> an unknown barcode and a specimen without a culture show the identical message. Skips when LIMS_E2E_* is unset. Synthetic data only.
import { expect, test } from '@playwright/test';

const BARCODE = process.env.LIMS_E2E_MICRO_BARCODE ?? '';
const CULTURE = process.env.LIMS_E2E_MICRO_CULTURE_ID ?? '';
const NO_CULTURE = process.env.LIMS_E2E_NO_CULTURE_BARCODE ?? '';
const UNKNOWN = process.env.LIMS_E2E_UNKNOWN_BARCODE ?? '';
test.skip(!process.env.LIMS_E2E_WEB_URL || !process.env.LIMS_E2E_STAFF_TOKEN || !BARCODE || !CULTURE || !NO_CULTURE || !UNKNOWN, 'compose env not set');

test.describe.configure({ mode: 'serial' });
const NONE = 'No microbiology culture for this specimen.';

test('AC-02.1: /micro/worklist shows the five tabs and the culture table', async ({ page }) => {
  await page.goto('/micro/worklist');
  await expect(page.getByRole('heading', { level: 1, name: 'Microbiology' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(5);
  await expect(page.getByRole('tab', { name: /^awaiting setup/i })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: /^incubating/i }).click();
  await expect(page).toHaveURL(/tab=incubating/);
});

test('Alt+B focuses the scan field', async ({ page }) => {
  await page.goto('/micro/worklist');
  await page.keyboard.press('Alt+b');
  await expect(page.getByRole('textbox', { name: /scan specimen barcode/i })).toBeFocused();
});

test('AC-02.2: scanning a specimen with one culture opens it; the barcode is not in the URL', async ({ page }) => {
  await page.goto('/micro/worklist');
  await page.getByRole('textbox', { name: /scan specimen barcode/i }).fill(BARCODE);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/micro/cultures/${CULTURE}$`));
  expect(page.url()).not.toContain(BARCODE);
});

test('AC-02.2 / S-02: no culture and unknown barcode give the identical message', async ({ page }) => {
  await page.goto('/micro/worklist');
  const field = page.getByRole('textbox', { name: /scan specimen barcode/i });
  await field.fill(NO_CULTURE);
  await page.keyboard.press('Enter');
  await expect(page.getByText(NONE)).toBeVisible();
  const a = await page.getByText(NONE).textContent();
  await page.reload();
  await field.fill(UNKNOWN);
  await page.keyboard.press('Enter');
  await expect(page.getByText(NONE)).toBeVisible();
  expect(await page.getByText(NONE).textContent()).toBe(a);
  await expect(page).toHaveURL(/\/micro\/worklist/);
});
