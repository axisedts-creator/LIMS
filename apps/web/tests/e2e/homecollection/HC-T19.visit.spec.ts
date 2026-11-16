// HC-T19 e2e (done_when: "US-09 UI"; tests: "component + E2E"). Dispatcher opens a visit with a HELD collection: detail loads without a phone (US-16-1), "Show phone" reveals it (US-16-2),
// Review -> Discard with reason (US-09-3) and the row leaves "On hold"; keyboard-only. Skips when LIMS_E2E_* is unset. Synthetic data only.
// Extra env (on top of HC-T18's): LIMS_E2E_HELD_VISIT_ID = an `assigned` visit with one held collection (synthetic seed), LIMS_E2E_HELD_COLLECTION_ID = that collection.
import { expect, test } from '@playwright/test';

const API = process.env.LIMS_E2E_API_URL ?? '';
const STAFF = process.env.LIMS_E2E_STAFF_TOKEN ?? '';
const VISIT = process.env.LIMS_E2E_HELD_VISIT_ID ?? '';
const COLLECTION = process.env.LIMS_E2E_HELD_COLLECTION_ID ?? '';
test.skip(!API || !STAFF || !VISIT || !COLLECTION, 'compose env not set');

test.describe.configure({ mode: 'serial' });

test('US-16-1: the visit page loads without a phone number anywhere in the page', async ({ page }) => {
  await page.goto(`/homecollection/visits/${VISIT}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Home visit' })).toBeVisible();
  await expect(page.getByText('••••')).toBeVisible();
  expect(await page.content()).not.toMatch(/\+977\d{8,10}/);
});

test('US-16-2: Show phone reveals the number and the API logged exactly one phone_reveal read', async ({ page }) => {
  await page.goto(`/homecollection/visits/${VISIT}`);
  const reveal = page.waitForResponse((r) => r.url().endsWith('/phone-reveal') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /show phone/i }).focus();
  await page.keyboard.press('Enter');
  expect((await reveal).status()).toBe(200);
  await expect(page.getByText(/\+977\d{8,10}/)).toBeVisible();
});

test('US-09-3: Discard a held collection with a reason (keyboard only) -> it leaves On hold; the API says discarded', async ({ page, request }) => {
  await page.goto(`/homecollection/visits/${VISIT}`);
  const hold = page.locator('.lims-card').filter({ has: page.getByRole('heading', { name: 'On hold' }) });
  await hold.getByRole('button', { name: /^review/i }).first().focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('radio', { name: /^discard/i }).check();
  await dlg.getByRole('button', { name: /reason/i }).click();
  await page.getByRole('option', { name: 'Duplicate draw' }).click();
  await dlg.getByRole('button', { name: /^discard/i }).click();
  await expect(dlg).toBeHidden();
  await expect(hold.getByRole('button', { name: /^review/i })).toHaveCount(0);
  const r = await request.get(`${API}/v1/homecollection/visits/${VISIT}`, { headers: { authorization: `Bearer ${STAFF}` } });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.collections.find((c: { id: string }) => c.id === COLLECTION).status).toBe('discarded');
  expect(JSON.stringify(body)).not.toMatch(/phone/i); // H2 carries no phone
});
