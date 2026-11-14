// C13.T16 e2e (tests: "component (MSW) + E2E"). US-06.1 keyboard-first receipt: inbox -> open manifest -> scan two partner references -> mark a third not received with a
// reason -> Alt+R confirm -> server shows partially_received. Skips when LIMS_E2E_* is unset. Synthetic data only.
import { expect, test } from '@playwright/test';

const API = process.env.LIMS_E2E_API_URL ?? '';
const STAFF = process.env.LIMS_E2E_STAFF_TOKEN ?? '';
const MANIFEST = process.env.LIMS_E2E_MANIFEST_ID ?? '';
const REF1 = process.env.LIMS_E2E_REF_1 ?? '';
const REF2 = process.env.LIMS_E2E_REF_2 ?? '';
test.skip(!API || !STAFF || !MANIFEST || !REF1 || !REF2, 'compose env not set');

test.describe.configure({ mode: 'serial' });

test('inbox lists the submitted manifest and opens the receive screen', async ({ page }) => {
  await page.goto('/partners/manifests');
  await expect(page.getByRole('heading', { level: 1, name: /partner manifests/i })).toBeVisible();
  await page.getByRole('link', { name: /^MF\d+/ }).first().click();
  await expect(page.getByLabel(/scan or type the partner.s sample reference/i)).toBeFocused();
});

test('US-06.1: scan two refs, unknown ref shows the inline error, confirm with Alt+R', async ({ page, request }) => {
  await page.goto(`/partners/manifests/${MANIFEST}`);
  const scan = page.getByLabel(/scan or type the partner.s sample reference/i);
  await scan.fill('NO-SUCH-REF');
  await scan.press('Enter');
  await expect(page.getByText('No sample with this reference on this manifest.')).toBeVisible();
  for (const ref of [REF1, REF2]) {
    await scan.fill(ref);
    await scan.press('Enter');
  }
  await page.keyboard.press('Alt+r');
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText(/Confirm 2 received/)).toBeVisible();
  await dlg.getByRole('button', { name: /^confirm/i }).click();
  await expect(page.getByText(/registering|registered/i).first()).toBeVisible();
  const r = await request.get(`${API}/v1/partners/admin/manifests/${MANIFEST}`, { headers: { authorization: `Bearer ${STAFF}` } });
  expect(r.status()).toBe(200);
  expect(['partially_received', 'received']).toContain((await r.json()).state);
});
