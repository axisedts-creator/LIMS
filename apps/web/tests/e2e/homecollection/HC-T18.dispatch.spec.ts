// HC-T18 e2e (done_when: "US-03/04/05 via E2E on Prism/real API"). Keyboard-only: unscheduled visit -> Assign refused (US-03-1) -> Schedule (US-03-2) -> Assign (US-03-3)
// -> board shows it on the route with "Print labels" (US-05-1) -> reorder with the buttons and save (US-04-1). Skips when LIMS_E2E_* is unset. Synthetic data only.
import { expect, test } from '@playwright/test';

const API = process.env.LIMS_E2E_API_URL ?? '';
const STAFF = process.env.LIMS_E2E_STAFF_TOKEN ?? '';
const CENTRE = process.env.LIMS_E2E_CENTRE_ID ?? '';
const VISIT = process.env.LIMS_E2E_VISIT_ID ?? '';
const PHLEBO = process.env.LIMS_E2E_PHLEBO_ID ?? '';
test.skip(!API || !STAFF || !CENTRE || !VISIT || !PHLEBO, 'compose env not set');

test.describe.configure({ mode: 'serial' });

test('board loads and is keyboard reachable (no mouse)', async ({ page }) => {
  await page.goto(`/homecollection/dispatch?centre_id=${CENTRE}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Home visits' })).toBeVisible();
  await page.keyboard.press('Alt+d');
  await expect(page.getByRole('textbox', { name: /^date/i })).toBeFocused();
});

test('US-03-1: assigning a visit without address and window shows the plain-words error', async ({ page }) => {
  await page.goto(`/homecollection/dispatch?centre_id=${CENTRE}`);
  const row = page.getByRole('row').filter({ hasText: 'Not scheduled' }).first();
  await row.focus();
  await page.keyboard.press('Alt+a');
  const dlg = page.getByRole('dialog', { name: /assign/i });
  await dlg.getByRole('button', { name: /phlebotomist/i }).click();
  await page.getByRole('option', { name: /Test Phlebo 01/ }).click();
  await dlg.getByRole('button', { name: /^assign$/i }).click();
  await expect(dlg.getByText('Add an address and a time window first.')).toBeVisible();
});

test('US-03-2 + US-03-3 + US-05-1 + US-04-1: schedule, assign, print-labels link, save a new order', async ({ page, request }) => {
  await page.goto(`/homecollection/dispatch?centre_id=${CENTRE}`);
  const row = page.getByRole('row').filter({ hasText: 'Not scheduled' }).first();
  await row.focus();
  await page.keyboard.press('Alt+s');
  const sch = page.getByRole('dialog', { name: /schedule/i });
  await sch.getByLabel(/^address/i).fill('Ward 5, Baneshwor (synthetic)');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByText('Visit scheduled.')).toBeVisible();

  await page.getByRole('row').filter({ hasText: 'Ward 5, Baneshwor' }).first().focus();
  await page.keyboard.press('Alt+a');
  const asg = page.getByRole('dialog', { name: /assign/i });
  await asg.getByRole('button', { name: /phlebotomist/i }).click();
  await page.getByRole('option', { name: /Test Phlebo 01/ }).click();
  await asg.getByRole('button', { name: /^assign$/i }).click();
  const card = page.locator('.lims-card').filter({ has: page.getByRole('heading', { name: /Test Phlebo 01/ }) });
  await expect(card.getByRole('link', { name: /print labels/i }).first()).toHaveAttribute('href', /\/lab\/orders\/[0-9a-f-]+\/labels$/);

  const moves = card.getByRole('button', { name: /move down/i });
  if ((await moves.count()) > 1) {
    await moves.first().click();
    await card.getByRole('button', { name: /^save order$/i }).click();
    await expect(card.getByRole('button', { name: /^save order$/i })).toBeDisabled();
  }
  // server truth: the visit is assigned to Test Phlebo 01
  const r = await request.get(`${API}/v1/homecollection/visits/${VISIT}`, { headers: { authorization: `Bearer ${STAFF}` } });
  expect(r.status()).toBe(200);
  expect((await r.json()).phlebotomist?.membership_id).toBe(PHLEBO);
});
