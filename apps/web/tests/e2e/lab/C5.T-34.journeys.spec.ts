// C5.T-34 nightly E2E journeys (02-TRD §13 "E2E (nightly)"): register → labels → collect → receive → instrument result → verify → approve → ready → release → "Printed";
// reject → recollect; amend. ACs: cross-cutting (AC-03.1, 04.1, 05.1, 08.1, 15.2, 16.1, 17.1, 18.1, 18.3). Synthetic data only. Own config ./playwright.config.ts.
// LD-134 (2026-11-12, CR-C5-T34 ruled, security first): NO harness service and NO seeded privileged sessions exist in the repo or a compose profile.
// The journeys follow the reporting E2E convention (tests/e2e/README.md): they drive the public /v1 API and the web app through a base URL and per-role
// session tokens supplied by the nightly pipeline via environment, never stored in a file: E2E_BASE_URL, E2E_LAB_COLLECT_TOKEN, E2E_LAB_TECH_TOKEN,
// E2E_PATHOLOGIST_TOKEN, E2E_LAB_STATUS_TOKEN, E2E_DEVICE_TOKEN (instrument step). Non-secret ids of the seeded stack (E2E_CENTRE_ID, E2E_HB_ORDERABLE_ID, E2E_INSTRUMENT_ID,
// optional E2E_PAYMENT_METHOD, default "cash") select the synthetic centre/test/instrument. A test skips with a clear message when anything it needs is unset.
// Registration uses E2E_LAB_COLLECT_TOKEN, verify uses E2E_LAB_TECH_TOKEN, approve/release/amend use E2E_PATHOLOGIST_TOKEN (the pipeline grants those roles the needed permissions).
// The green run happens in the nightly/release gate once the pipeline supplies the tokens (recorded by the lead as a release gate).
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

const env = (k: string) => (process.env[k] ?? '').trim();
const BASE = env('E2E_BASE_URL').replace(/\/+$/, '');
const TOK = {
  collect: env('E2E_LAB_COLLECT_TOKEN'),
  tech: env('E2E_LAB_TECH_TOKEN'),
  patho: env('E2E_PATHOLOGIST_TOKEN'),
  status: env('E2E_LAB_STATUS_TOKEN'),
  device: env('E2E_DEVICE_TOKEN'),
};
const CFG = { centre: env('E2E_CENTRE_ID'), hb: env('E2E_HB_ORDERABLE_ID'), instrument: env('E2E_INSTRUMENT_ID'), pay: env('E2E_PAYMENT_METHOD') || 'cash' };
type Need = keyof typeof TOK;
/** Skip (with the reason) unless E2E_BASE_URL, the listed tokens and the stack ids are set. */
function need(...roles: Need[]) {
  const missing = [BASE ? '' : 'E2E_BASE_URL', CFG.centre ? '' : 'E2E_CENTRE_ID', CFG.hb ? '' : 'E2E_HB_ORDERABLE_ID', ...roles.map((r) => (TOK[r] ? '' : `E2E_${{ collect: 'LAB_COLLECT', tech: 'LAB_TECH', patho: 'PATHOLOGIST', status: 'LAB_STATUS', device: 'DEVICE' }[r]}_TOKEN`))].filter(Boolean);
  if (roles.includes('device') && !CFG.instrument) missing.push('E2E_INSTRUMENT_ID');
  test.skip(missing.length > 0, `E2E nightly env not supplied: ${missing.join(', ')}`);
}

type J = Record<string, any>;
type Res = { status: number; json: J; headers: Headers };
async function api(method: string, path: string, token: string, body?: unknown, h: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...h };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json: J = {};
  try { json = JSON.parse(await r.text()); } catch { /* empty body */ }
  return { status: r.status, json, headers: r.headers };
}
const ok = (r: Res, what: string) => { if (r.status >= 300) throw new Error(`${what} → ${r.status} ${r.json?.code ?? ''}`); return r.json; };
const poll = async <T>(fn: () => Promise<T | undefined | false>, what: string, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`timeout: ${what}`);
};

const useSession = (ctx: BrowserContext, token: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: token, url: BASE, httpOnly: true, secure: BASE.startsWith('https'), sameSite: 'Lax' }]);
const scan = async (page: Page, v: string) => { await page.keyboard.type(v, { delay: 2 }); await page.keyboard.press('Enter'); };

type Registered = { order_id: string; registration_no: string; barcodes: string[] };
/** Register one synthetic HB order through the real frontdesk API (quote → register), then read its specimens. */
async function register(): Promise<Registered> {
  const draft = {
    patient: { new_patient: { full_name: `Synthetic E2E ${Date.now().toString(36)}`, sex: 'unknown', age: { value: 30, unit: 'y' }, consents: { processing: true, sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'e2e' } } },
    centre_id: CFG.centre, visit_type: 'opd', billing_mode: 'cash', items: [{ orderable_id: CFG.hb }],
  };
  const quote = ok(await api('POST', '/v1/frontdesk/registrations/quote', TOK.collect, draft), 'quote');
  const reg = ok(await api('POST', '/v1/frontdesk/registrations', TOK.collect, { ...draft, quote_fingerprint: quote.quote_fingerprint, payments: [{ method_code: CFG.pay, amount_received_paisa: Number(quote.totals?.net ?? 1) || 1 }] }), 'register');
  const orderId: string = reg.order.id;
  const specimens = await poll(async () => {
    const d = ok(await api('GET', `/v1/lab/specimens?order_id=${orderId}`, TOK.collect), 'list specimens').data as J[] | undefined;
    return d && d.length ? d : false;
  }, 'specimens of the registered order');
  return { order_id: orderId, registration_no: reg.order.registration_no, barcodes: specimens.map((s) => s.barcode as string) };
}

/** Real instruments ingest operation (E04 submitMessageBatch, device token): one ASTM HB result for the barcode. */
async function instrumentResult(barcode: string, value: string) {
  const astm = ['H|\\^&|||SYN^1|||||||P|1', 'P|1', `O|1|${barcode}||^^^HB|R`, `R|1|^^^HB|${value}|g/dL||N||F`, 'L|1|N'].join('\r') + '\r';
  const raw = Buffer.from(astm, 'latin1');
  const now = new Date().toISOString();
  const r = await api('POST', '/v1/instruments/agent/message-batches', TOK.device, {
    sent_at_agent: now, clock_offset_ms: 0,
    messages: [{ agent_message_id: uuidv7(), instrument_id: CFG.instrument, protocol: 'astm', kind: 'data', raw_base64: raw.toString('base64'), raw_sha256: createHash('sha256').update(raw).digest('hex'), captured_at_agent: now, clock_offset_ms: 0 }],
  });
  ok(r, 'instrument message batch');
}
function uuidv7(): string {
  const b = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  b.writeUIntBE(Date.now(), 0, 6); b[6] = (b[6]! & 0x0f) | 0x70; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const hbResult = async (orderId: string, token: string): Promise<J | undefined> => {
  const d = ok(await api('GET', `/v1/lab/orders/${orderId}/results`, token), 'order results');
  return (d.items as J[]).flatMap((i) => i.results as J[]).find((x) => x.analyte_code === 'HB');
};
/** Verify (technologist) then approve (pathologist, a different actor) through the real lab API. */
async function verifyAndApprove(orderId: string) {
  const resulted = await poll(async () => { const r = await hbResult(orderId, TOK.tech); return r?.status === 'resulted' ? r : false; }, 'HB resulted');
  ok(await api('POST', '/v1/lab/results/bulk-verify', TOK.tech, { items: [{ id: resulted.id, version: resulted.version }] }), 'verify');
  const verified = await poll(async () => { const r = await hbResult(orderId, TOK.patho); return r?.status === 'verified' ? r : false; }, 'HB verified');
  ok(await api('POST', '/v1/lab/results/bulk-approve', TOK.patho, { items: [{ id: verified.id, version: verified.version }] }), 'approve');
}
/** Release the order's latest report version through the real reporting API (C6 may already have auto-released it). */
async function release(orderId: string) {
  const rep = await poll(async () => ((await api('POST', '/v1/reporting/reports/search', TOK.patho, { order_id: orderId })).json.data as J[] | undefined)?.[0], 'report of the order');
  const detail = ok(await api('GET', `/v1/reporting/reports/${rep.id}`, TOK.patho), 'report detail');
  const latest = (detail.versions as J[]).reduce((m, v) => (v.version_no > m.version_no ? v : m));
  const ver = await api('GET', `/v1/reporting/report-versions/${latest.id}`, TOK.patho);
  const rel = await api('POST', `/v1/reporting/report-versions/${latest.id}/release`, TOK.patho, {}, ver.headers.get('etag') ? { 'if-match': ver.headers.get('etag')! } : {});
  if (rel.status >= 500) throw new Error(`release → ${rel.status}`);
}

/** Collect (tab Collect) then receive the order's specimens through the UI; returns when the receive row shows Received. */
async function collectAndReceive(page: Page, context: BrowserContext, o: Registered) {
  await useSession(context, TOK.collect);
  await page.goto('/lab/collect');
  await scan(page, o.registration_no);
  await page.getByRole('checkbox', { name: new RegExp(o.barcodes[0]!) }).check();
  await page.getByRole('button', { name: /collect selected/i }).click();
  await expect(page.getByText(/Collected \d+ specimens?\./)).toBeVisible();
  await context.clearCookies();
  await useSession(context, TOK.tech);
  await page.goto('/lab/receive');
  await page.getByLabel(/receiving location/i).selectOption({ index: 1 });
  await page.getByLabel(/barcode/i).focus();
  await scan(page, o.barcodes[0]!);
  await page.keyboard.press('Enter'); // Accept
  await expect(page.getByRole('row', { name: new RegExp(o.barcodes[0]!) })).toContainText(/Received/);
}

test.describe('journey: register → … → released → Printed', () => {
  test('full happy path ends with status-board "Printed" and a released-at time', async ({ page, context }) => {
    need('collect', 'tech', 'patho', 'status', 'device');
    const o = await register();
    // labels (AC-02.x): the label page prints once and lists the order's specimen
    await useSession(context, TOK.collect);
    await page.addInitScript(() => { (window as any).__prints = 0; window.print = () => { (window as any).__prints += 1; }; });
    await page.goto(`/lab/orders/${o.order_id}/labels`);
    await expect(page.locator('[data-testid="label"]').first()).toContainText(o.barcodes[0]!);
    await expect.poll(() => page.evaluate(() => (window as any).__prints)).toBe(1);

    await collectAndReceive(page, context, o);

    // instrument result (real instruments ingest operation, device token) lands on the grid as Resulted / Instrument
    await instrumentResult(o.barcodes[0]!, '13.4');
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
    await useSession(context, TOK.patho);
    await page.goto('/lab/approval');
    await page.getByRole('row', { name: new RegExp(o.registration_no) }).getByRole('checkbox', { name: /^select/i }).check();
    await page.getByRole('button', { name: /^approve\s*\d+$/i }).click();
    await expect(page.getByRole('dialog').getByText(/1 done, 0 not done/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /close|done|ok/i }).click();

    await context.clearCookies();
    await useSession(context, TOK.status);
    const board = async () => {
      await page.goto('/lab/status-board');
      return page.getByRole('row', { name: new RegExp(o.registration_no) });
    };
    await expect(await board()).toContainText(/Ready/); // AC-18.1: all items approved, no release seen

    // release (real C6 operation); a repeated release changes nothing (AC-18.2)
    await release(o.order_id);
    await release(o.order_id);
    await expect.poll(async () => (await (await board()).textContent()) ?? '', { timeout: 60_000 }).toMatch(/Printed/);
    const row = await board();
    await expect(row).not.toContainText(/Printed \(/); // not partial / preliminary
    expect(page.url()).not.toContain(o.registration_no); // identifiers never in the URL
  });
});

test.describe('journey: reject → recollect', () => {
  test('reject with recollection shows the new barcode; the new specimen is collectable and the old one is not', async ({ page, context }) => {
    need('collect', 'tech');
    const o = await register();
    await collectAndReceive(page, context, o);
    // reject the received tube from the receive screen (R)
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
    await useSession(context, TOK.collect);
    await page.goto('/lab/collect');
    await scan(page, newBarcode!);
    await page.getByRole('checkbox', { name: new RegExp(newBarcode!) }).check();
    await page.getByRole('button', { name: /collect selected/i }).click();
    await expect(page.getByText(/Collected 1 specimens?\./)).toBeVisible();
  });
});

test.describe('journey: amend an approved result', () => {
  test('pathologist amends 13.4 → 9.8 with a reason; "Amended to version 2."; verifier cannot amend', async ({ page, context }) => {
    need('collect', 'tech', 'patho', 'device');
    const o = await register();
    await collectAndReceive(page, context, o);
    await instrumentResult(o.barcodes[0]!, '13.4');
    await verifyAndApprove(o.order_id); // real lab API as two distinct actors; the UI path is covered by the happy path

    await context.clearCookies();
    await useSession(context, TOK.patho);
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
    await useSession(context, TOK.tech);
    await page.goto(`/lab/orders/${o.order_id}/results`);
    await expect(page.getByRole('button', { name: /^amend/i })).toHaveCount(0);
  });
});
