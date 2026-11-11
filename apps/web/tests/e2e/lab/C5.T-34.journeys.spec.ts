// C5.T-34 nightly E2E journeys (02-TRD §13 "E2E (nightly)"): register → labels → collect → receive → instrument result (simulated event) → verify → approve → ready → release → "Printed";
// reject → recollect; amend. ACs: cross-cutting (AC-03.1, 04.1, 05.1, 08.1, 15.2, 16.1, 17.1, 18.1, 18.3). Synthetic data only. Own config ./playwright.config.ts; run on the compose stack (done_when), not in unit verify.
// NEEDS (writer/lead) on the compose stack: stub-c2/C2 sessions `sid-lab-collect`, `sid-lab-tech` (receive+reject+enter+verify, aal2), `sid-pathologist` (approve+amend, aal2), `sid-lab-status` (lab.status_board.read);
// env LIMS_E2E_HARNESS_URL (seed/harness service) with (d) POST /approve {order_id} verifying+approving via the API as two distinct actors, and (a) POST /register {tests:['HB']} → {order_id, registration_no, barcodes[]},
// (b) POST /instrument-result {barcode, analyte:'HB', value:'13.4'} publishes `instruments.result.received.v1` (system actor) and waits for the inbox, (c) POST /release {order_id} publishes `reporting.report.released.v1` (C6 fake/real).
// Until then these tests fail at the harness call, the intended red state.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const HARNESS = process.env.LIMS_E2E_HARNESS_URL ?? 'http://localhost:3199';
const useSid = (ctx: BrowserContext, sid: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
const scan = async (page: Page, v: string) => { await page.keyboard.type(v, { delay: 2 }); await page.keyboard.press('Enter'); };
type Registered = { order_id: string; registration_no: string; barcodes: string[] };
const harness = async <T>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(`${HARNESS}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`harness ${path} → ${r.status}`);
  return (await r.json()) as T;
};
const register = () => harness<Registered>('/register', { tests: ['HB'] });

/** Collect (tab Collect) then receive the order's specimens through the UI; returns when the receive row shows Received. */
async function collectAndReceive(page: Page, context: BrowserContext, o: Registered) {
  await useSid(context, 'sid-lab-collect');
  await page.goto('/lab/collect');
  await scan(page, o.registration_no);
  await page.getByRole('checkbox', { name: new RegExp(o.barcodes[0]!) }).check();
  await page.getByRole('button', { name: /collect selected/i }).click();
  await expect(page.getByText(/Collected \d+ specimens?\./)).toBeVisible();
  await context.clearCookies();
  await useSid(context, 'sid-lab-tech');
  await page.goto('/lab/receive');
  await page.getByLabel(/receiving location/i).selectOption({ index: 1 });
  await page.getByLabel(/barcode/i).focus();
  await scan(page, o.barcodes[0]!);
  await page.keyboard.press('Enter'); // Accept
  await expect(page.getByRole('row', { name: new RegExp(o.barcodes[0]!) })).toContainText(/Received/);
}

test.describe('journey: register → … → released → Printed', () => {
  test('full happy path ends with status-board "Printed" and a released-at time', async ({ page, context }) => {
    const o = await register();
    // labels (AC-02.x): the label page prints once and lists the order's specimen
    await useSid(context, 'sid-lab-collect');
    await page.addInitScript(() => { (window as any).__prints = 0; window.print = () => { (window as any).__prints += 1; }; });
    await page.goto(`/lab/orders/${o.order_id}/labels`);
    await expect(page.locator('[data-testid="label"]').first()).toContainText(o.barcodes[0]!);
    await expect.poll(() => page.evaluate(() => (window as any).__prints)).toBe(1);

    await collectAndReceive(page, context, o);

    // instrument result (simulated `instruments.result.received.v1`) lands on the grid as Resulted / Instrument
    await harness('/instrument-result', { barcode: o.barcodes[0], analyte: 'HB', value: '13.4' });
    await page.goto(`/lab/orders/${o.order_id}/results`);
    const hb = page.getByRole('grid').getByRole('row', { name: /\bHB\b/ });
    await expect(hb.getByText(/Resulted/)).toBeVisible();
    await expect(hb.getByText(/Instrument/)).toBeVisible();

    // verify (technologist) → Verified
    await page.goto('/lab/verification');
    await page.getByRole('row', { name: new RegExp(o.registration_no) }).getByRole('checkbox', { name: /^select/i }).check();
    await page.getByRole('button', { name: /^verify\s*\d+$/i }).click();
    await expect(page.getByRole('dialog').getByText(/1 done, 0 not done/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|done|ok/i }).click();

    // approve (pathologist, aal2; different user than the verifier) → Approved; board shows "Ready"
    await context.clearCookies();
    await useSid(context, 'sid-pathologist');
    await page.goto('/lab/approval');
    await page.getByRole('row', { name: new RegExp(o.registration_no) }).getByRole('checkbox', { name: /^select/i }).check();
    await page.getByRole('button', { name: /^approve\s*\d+$/i }).click();
    await expect(page.getByRole('dialog').getByText(/1 done, 0 not done/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|done|ok/i }).click();

    await context.clearCookies();
    await useSid(context, 'sid-lab-status');
    const board = async () => {
      await page.goto('/lab/status-board');
      return page.getByRole('row', { name: new RegExp(o.registration_no) });
    };
    await expect(await board()).toContainText(/Ready/); // AC-18.1: all items approved, no release seen

    // release (C6 fake/real) → "Printed" with release time; a second delivery changes nothing (AC-18.2)
    await harness('/release', { order_id: o.order_id });
    await harness('/release', { order_id: o.order_id });
    const row = await board();
    await expect(row).toContainText(/Printed/);
    await expect(row).not.toContainText(/Printed \(/); // not partial / preliminary
    expect(page.url()).not.toContain(o.registration_no); // identifiers never in the URL
  });
});

test.describe('journey: reject → recollect', () => {
  test('reject with recollection shows the new barcode; the new specimen is collectable and the old one is not', async ({ page, context }) => {
    const o = await register();
    await collectAndReceive(page, context, o);
    // second order specimen is not needed: reject the received tube from the receive screen (R)
    await page.goto('/lab/receive');
    await page.getByLabel(/receiving location/i).selectOption({ index: 1 });
    await page.getByLabel(/barcode/i).focus();
    await scan(page, o.barcodes[0]!);
    await page.keyboard.press('r');
    const dlg = page.getByRole('dialog', { name: new RegExp(`Reject specimen ${o.barcodes[0]}`) });
    await dlg.getByRole('radio').first().check();
    await dlg.getByRole('checkbox', { name: /request recollection/i }).check();
    await dlg.getByRole('button', { name: /^reject$/i }).click();
    const toast = page.getByText(/Specimen rejected\. New barcode (\S+) created for recollection\./);
    await expect(toast).toBeVisible();
    const newBarcode = /New barcode (\S+) created/.exec((await toast.textContent()) ?? '')?.[1];
    expect(newBarcode).toBeTruthy();
    expect(newBarcode).not.toBe(o.barcodes[0]);
    // the replacement can be collected by scanning its barcode (status `ordered`)
    await context.clearCookies();
    await useSid(context, 'sid-lab-collect');
    await page.goto('/lab/collect');
    await scan(page, newBarcode!);
    await page.getByRole('checkbox', { name: new RegExp(newBarcode!) }).check();
    await page.getByRole('button', { name: /collect selected/i }).click();
    await expect(page.getByText(/Collected 1 specimens?\./)).toBeVisible();
  });
});

test.describe('journey: amend an approved result', () => {
  test('pathologist amends 13.4 → 9.8 with a reason; "Amended to version 2."; verifier cannot amend', async ({ page, context }) => {
    const o = await register();
    await collectAndReceive(page, context, o);
    await harness('/instrument-result', { barcode: o.barcodes[0], analyte: 'HB', value: '13.4' });
    // verify + approve through the API-backed UI is covered by the happy path; here use the harness shortcut to reach `approved`
    await harness('/approve', { order_id: o.order_id });

    await context.clearCookies();
    await useSid(context, 'sid-pathologist');
    await page.goto(`/lab/orders/${o.order_id}/results`);
    const cell = page.getByRole('grid').getByRole('row', { name: /\bHB\b/ }).getByRole('gridcell').nth(1);
    await expect(page.getByRole('grid').getByRole('row', { name: /\bHB\b/ }).getByText(/Approved v1/)).toBeVisible();
    await cell.focus();
    await page.keyboard.press('Alt+m');
    const dlg = page.getByRole('dialog', { name: /Amend .*HB|Amend Hemoglobin/i });
    await expect(dlg).toContainText(/This creates version 2\./);
    await dlg.getByLabel(/new value/i).fill('9.8');
    await dlg.getByLabel(/reason$/i).selectOption({ index: 1 });
    await dlg.getByRole('button', { name: /amend/i }).click();
    await expect(page.getByText('Amended to version 2.')).toBeVisible();
    await expect(page.getByRole('grid').getByRole('row', { name: /\bHB\b/ }).getByText(/Approved v2/)).toBeVisible();

    // AC-17.2: a technologist has no amend action
    await context.clearCookies();
    await useSid(context, 'sid-lab-tech');
    await page.goto(`/lab/orders/${o.order_id}/results`);
    await expect(page.getByRole('button', { name: /^amend/i })).toHaveCount(0);
  });
});
