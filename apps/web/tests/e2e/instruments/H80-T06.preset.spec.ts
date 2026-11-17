// H80-T06 — nightly Playwright: create-instrument preset "Truth H80E" against the real stack (LD-139, addendum §1/§9). Not part of the per-task verify.
// Covers: host-query toggle disabled with a reason while the driver is generic; lab-PC wording; nine checklist steps; axe. Synthetic data only.
// ENV: LIMS_E2E_WEB_URL (via config baseURL), LIMS_E2E_STAFF_SID. A test skips naming the missing variable when it is unset.
import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';

const AXE_SRC = createRequire(__filename).resolve('axe-core/axe.min.js');
const SID = (process.env.LIMS_E2E_STAFF_SID ?? '').trim();
const LIST = '/instruments/instruments'; // staff.instruments.instruments (SCR-05)

async function openCreate(page: Page, baseURL: string | undefined) {
  await page.context().addCookies([{ name: '__Host-lims_sid', value: SID, url: baseURL ?? 'https://localhost:3100', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await page.goto(LIST);
  await page.getByRole('button', { name: /new instrument/i }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: /preset/i }).click();
  await page.getByRole('option', { name: /truth h80e/i }).click();
  return dlg;
}
const axe = async (page: Page) => {
  await page.addScriptTag({ path: AXE_SRC });
  const v = await page.evaluate(async () => (await (window as any).axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map((x: any) => x.id));
  expect(v).toEqual([]);
};

test.describe('create instrument — preset Truth H80E', () => {
  test.skip(!SID, 'E2E env not supplied: LIMS_E2E_STAFF_SID');

  test('host query toggle is disabled with a reason while the driver status is generic', async ({ page, baseURL }) => {
    const dlg = await openCreate(page, baseURL);
    const sw = dlg.getByRole('switch', { name: /host query/i });
    await expect(sw).toBeDisabled();
    await expect(sw).not.toBeChecked();
    const reason = await sw.evaluate((el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
    expect(reason).toMatch(/generic/i);
    expect(reason).toMatch(/commissioning|verified/i);
  });

  test('the form says the typed address is the lab PC (not the cloud server), never offers 0.0.0.0, and lists nine checklist steps', async ({ page, baseURL }) => {
    const dlg = await openCreate(page, baseURL);
    await expect(dlg).toContainText(/typed into the analy[sz]er/i);
    await expect(dlg).toContainText(/not the cloud server/i);
    const bind = dlg.locator('input[name="transport.bind_address"]');
    await expect(bind).toHaveValue('');
    expect(await bind.getAttribute('placeholder')).not.toMatch(/0\.0\.0\.0/);
    await expect(dlg.getByRole('region', { name: /commissioning checklist/i }).getByRole('listitem')).toHaveCount(9);
  });

  test('a bind address of 0.0.0.0 is refused and nothing is written', async ({ page, baseURL }) => {
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET' && /\/v1\/instruments\//.test(r.url())) writes.push(`${r.method()} ${r.url()}`); });
    const dlg = await openCreate(page, baseURL);
    await dlg.locator('input[name="transport.bind_address"]').fill('0.0.0.0');
    await dlg.getByRole('button', { name: /create instrument/i }).click();
    await expect(dlg.getByText(/lab network|not 0\.0\.0\.0/i).first()).toBeVisible();
    expect(writes).toEqual([]);
  });

  test('axe: no violations with the preset selected', async ({ page, baseURL }) => {
    await openCreate(page, baseURL);
    await axe(page);
  });
});
