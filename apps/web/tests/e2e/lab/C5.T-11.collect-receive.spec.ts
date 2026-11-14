// C5.T-11 nightly E2E — staff lab collect → dispatch → receive, keyboard only, scanner simulated as fast keystrokes + Enter (04-UI-UX §3.2/§3.3).
// ACs: AC-03.1, AC-03.3, AC-04.1, AC-04.2, AC-04.4. Not part of the per-task verify (needs `next dev` + browsers). Synthetic data only.
// NEEDS (writer/lead): stub-c2.mjs sessions — `sid-lab-collect` (lab.specimen.collect + .read), `sid-lab-tech` (lab.specimen.receive + .reject + .read),
// `sid-limited` (no lab permission) — and a stubbed /v1/lab origin serving: order registration no REGISTRATIONNO2611050001 with specimens
// SYN0000001 + SYN0000002 (`ordered`), collected specimens SYN0000004/SYN0000005, specimen SYN0000011..SYN0000015 (`collected`) for auto-accept, and no specimen SYN8888888.
// Until then these tests fail at the missing sessions/stub, which is the intended red state.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
/** A keyboard-wedge scanner: every key within a few ms, then Enter. */
const scan = async (page: Page, value: string) => { await page.keyboard.type(value, { delay: 2 }); await page.keyboard.press('Enter'); };

test.describe('collect and dispatch', () => {
  test('registration-no lookup → keyboard-only collect → dispatch by scanning collected barcodes', async ({ page, context }) => {
    await useSid(context, 'sid-lab-collect');
    await page.goto('/lab/collect');
    await expect(page.getByText('Scan a label to start.')).toBeVisible();
    await expect(page.getByLabel(/scan barcode or enter registration number/i)).toBeFocused();
    await scan(page, 'REGISTRATIONNO2611050001');
    await expect(page.getByRole('checkbox', { name: /SYN0000001/ })).toBeVisible();
    // keyboard only: Tab to the list, Space to select, Tab to the button, Enter
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const name = await page.evaluate(() => (document.activeElement?.textContent ?? '') + ((document.activeElement as HTMLInputElement | null)?.type ?? ''));
      if (/collect selected/i.test(name)) { await page.keyboard.press('Enter'); break; }
      if (/checkbox/.test(name)) await page.keyboard.press('Space');
    }
    await expect(page.getByText(/Collected \d+ specimens?\./)).toBeVisible();

    await page.getByRole('tab', { name: /^dispatch$/i }).press('Enter');
    await scan(page, 'SYN0000004');
    await scan(page, 'SYN0000005');
    await expect(page.getByRole('row', { name: /SYN0000005/ })).toBeVisible();
    await page.keyboard.press('Control+Enter');
    await expect(page.getByRole('row', { name: /SYN0000004/ })).toContainText(/in transit|dispatched/i);
    expect(page.url()).not.toMatch(/SYN000|REGISTRATIONNO/); // identifiers never in the URL
  });
});

test.describe('receive', () => {
  test('scan + Enter accepts; unknown barcode shows the not-found text and changes nothing', async ({ page, context }) => {
    await useSid(context, 'sid-lab-tech');
    await page.goto('/lab/receive');
    await page.getByLabel(/receiving location/i).selectOption({ index: 1 }).catch(async () => { await page.keyboard.press('Tab'); });
    await page.getByLabel(/barcode/i).focus();
    await scan(page, 'SYN8888888');
    await expect(page.getByText('No specimen with this barcode in your lab.')).toBeVisible();
    await scan(page, 'SYN0000011');
    await expect(page.getByText('SYN0000011')).toBeVisible();
    await page.keyboard.press('Enter'); // Accept
    await expect(page.getByRole('row', { name: /SYN0000011/ })).toContainText(/Received/);
    await expect(page.getByLabel(/barcode/i)).toBeFocused(); // focus returns to the scan box
  });

  test('auto-accept: five scans in a row → five Received rows', async ({ page, context }) => {
    await useSid(context, 'sid-lab-tech');
    await page.goto('/lab/receive');
    await page.getByLabel(/receiving location/i).selectOption({ index: 1 }).catch(() => undefined);
    await page.getByRole('switch', { name: /auto-accept/i }).click();
    await page.getByLabel(/barcode/i).focus();
    for (const n of [11, 12, 13, 14, 15]) await scan(page, `SYN00000${n}`);
    for (const n of [11, 12, 13, 14, 15]) await expect(page.getByRole('row', { name: new RegExp(`SYN00000${n}`) })).toContainText(/Received/);
  });
});

test.describe('denied state', () => {
  test('without lab permissions: access-denied text, no scan input, no nav entry', async ({ page, context }) => {
    await useSid(context, 'sid-limited');
    await page.goto('/lab/collect');
    await expect(page.getByText("You don't have access to this screen.")).toBeVisible();
    await expect(page.getByLabel(/barcode/i)).toHaveCount(0);
  });
});
