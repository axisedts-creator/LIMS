// @vitest-environment jsdom
// C10.T-23 — "Assign to culture" dialog (04-UI-UX §4; AC-08.4: pending_match -> user assigns -> applied; AC-08.10 barcode never in URL; 07-SECURITY S-17 / REQ-SEC-121; M20 assignMicroInstrumentRecord).
// Dialog = BarcodeInput (scan specimen) -> BFF lookup (C5 lookup, then C10 cultures of the specimen) -> Select culture (test + status) -> IntegerField "Isolate no." (1..99, default = record's isolate_seq) -> "Assign".
// Opened from the row menu of the list page. Real server actions + MSW. LD-140: kit only. Seams: t23.harness.tsx header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ASSIGN, BARCODE, ID, LOOKUP, ORIGIN, PERM_WORK, api, cultureRow, dialog, hit, instrumentList, pick, problem, rec, recordList, resetHits, router, rowAction, scanChain, state, writeFail, writeOk } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const RECORD = rec(1, { isolate_seq: 2, version: 3 });
const open = async (record = RECORD, chain = scanChain(), ...custom: Parameters<typeof api.use>) => {
  api.use(recordList([record]), instrumentList(), writeOk('assign'), ...chain);
  if (custom.length) api.use(...custom); // msw use() prepends: per-test handlers go AFTER the defaults so they win (T-23 ruling)
  const mod = await import('../../../app/(staff)/micro/instrument-records/page');
  const el = await mod.default({ searchParams: Promise.resolve({}) } as never);
  render(<ToastProvider>{el}</ToastProvider>);
  await rowAction(BARCODE, /^assign to culture$/i);
  return dialog(/assign/i);
};
const scanField = (d: HTMLElement) => within(d).getByRole('textbox', { name: /scan specimen barcode|barcode/i }) as HTMLInputElement;
const scan = async (d: HTMLElement, v = BARCODE, key = '{Enter}') => { await userEvent.type(scanField(d), `${v}${key}`); };
const assignBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /^assign$/i }) as HTMLButtonElement;
const isolateField = (d: HTMLElement) => within(d).getByRole('textbox', { name: /isolate no/i }) as HTMLInputElement;
const posts = () => hit('POST', ASSIGN);
const lastPost = async () => { await waitFor(() => expect(posts().length).toBeGreaterThan(0)); return posts().at(-1)!; };
const chosen = async (d: HTMLElement) => { await scan(d); await pick(d, /culture/i, /synthetic culture 1/i); };

describe('the dialog (04-UI-UX §4)', () => {
  it('opens as "Assign to culture" with a barcode scan field, an Isolate no. field defaulting to the record isolate and a primary "Assign" + "Cancel"', async () => {
    const d = await open();
    expect(d.getAttribute('aria-label') ?? d.textContent).toMatch(/assign to culture/i);
    expect(scanField(d)).toBeTruthy();
    expect(isolateField(d).value).toBe('2');
    expect(assignBtn(d).className).toContain('lims-btn-primary');
    expect(within(d).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
  });
  it('Assign stays disabled until a culture is chosen', async () => {
    const d = await open();
    expect(assignBtn(d).disabled).toBe(true);
  });
  it('Cancel closes without any request to the write endpoint or the lookup', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /assign/i })).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(hit('POST', LOOKUP)).toHaveLength(0);
  });
  it('the record barcode is not pre-filled into the scan field (the user scans the specimen: that is the check)', async () => {
    const d = await open();
    expect(scanField(d).value).toBe('');
  });
  it('is accessible (axe)', async () => {
    const d = await open();
    const v = (await axe.run(d, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(v).toEqual([]);
  });
});

describe('scan -> culture list (BFF lookup; AC-08.10, S-02)', () => {
  it('a scan POSTs {barcode} to the C5 lookup (body only), then lists that specimen\'s cultures as "test name — status"', async () => {
    const d = await open(RECORD, scanChain([cultureRow(1), cultureRow(7, { test_name: 'Synthetic blood culture', status: 'growth_detected' })]));
    await scan(d);
    await waitFor(() => expect(hit('POST', LOOKUP)).toHaveLength(1));
    const l = hit('POST', LOOKUP)[0]!;
    expect(l.json).toEqual({ barcode: BARCODE });
    expect(l.search).toBe('');
    expect(hit('GET', /\/v1\/micro\/cultures$/).some((h) => new URLSearchParams(h.search).get('specimen_id') === ID(401))).toBe(true);
    await userEvent.click(within(d).getByRole('button', { name: /culture/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts.some((o) => /Synthetic culture 1/.test(o) && /Incubating/.test(o))).toBe(true);
    expect(opts.some((o) => /Synthetic blood culture/.test(o) && /Growth — work-up/.test(o))).toBe(true);
  });
  it('a cancelled culture is not offered', async () => {
    const d = await open(RECORD, scanChain([cultureRow(1, { status: 'cancelled' }), cultureRow(7, { test_name: 'Synthetic live culture' })]));
    await scan(d);
    await userEvent.click(await within(d).findByRole('button', { name: /culture/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts.join('|')).not.toContain('Synthetic culture 1');
    expect(opts.join('|')).toContain('Synthetic live culture');
  });
  it('S-02: unknown barcode (404), no cultures and a refused lookup (403) all show the same "no culture" text; no culture offered, Assign disabled', async () => {
    const texts: string[] = [];
    for (const chain of [[http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => problem('common.not_found', 404))], [http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => problem('auth.forbidden', 403))], scanChain([])]) {
      const d = await open(RECORD, chain as never);
      await scan(d);
      await waitFor(() => expect(d.textContent).toMatch(/no (microbiology )?culture/i));
      texts.push((d.textContent ?? '').replace(/\s+/g, ' '));
      expect(assignBtn(d).disabled).toBe(true);
      expect(d.textContent).not.toMatch(/forbidden|permission|barcode not found|unknown barcode/i);
      cleanup(); api.resetHandlers(); resetHits();
    }
    expect(new Set(texts).size).toBe(1);
  });
  it('invalid pattern: the kit error and NO lookup request', async () => {
    const d = await open();
    await scan(d, 'e26 *!');
    expect(hit('POST', LOOKUP)).toHaveLength(0);
    expect(d.textContent).toContain("This doesn't look like a sample barcode");
  });
  it('the barcode never appears in the URL of any request or navigation (AC-08.10)', async () => {
    const d = await open();
    await chosen(d);
    await userEvent.click(assignBtn(d));
    await lastPost();
    const { hits } = await import('./t23.harness');
    for (const h of hits) { expect(h.path).not.toContain(BARCODE); expect(h.search).not.toContain(BARCODE); }
    for (const c of router.refresh.mock.calls) expect(String(c)).not.toContain(BARCODE);
  });
});

describe('submitting (M20; S-05 strict body)', () => {
  it('POST /assign with Idempotency-Key + If-Match "<record.version>" and exactly { culture_id, isolate_seq }', async () => {
    const d = await open();
    await chosen(d);
    await userEvent.click(assignBtn(d));
    const h = await lastPost();
    expect(h.path).toBe(`/v1/micro/instrument-records/${RECORD.id}/assign`);
    expect(h.headers.get('if-match')).toBe('"3"');
    expect((h.headers.get('idempotency-key') ?? '').length).toBeGreaterThan(8);
    expect(h.json).toEqual({ culture_id: ID(1), isolate_seq: 2 });
  });
  it('an edited Isolate no. is sent as an integer; the dialog closes and the page is refreshed', async () => {
    const d = await open();
    await chosen(d);
    await userEvent.clear(isolateField(d));
    await userEvent.type(isolateField(d), '5');
    await userEvent.click(assignBtn(d));
    expect((await lastPost()).json.isolate_seq).toBe(5);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: /assign/i })).toBeNull();
  });
  it.each([['0'], ['100'], ['-1'], ['2.5'], ['']])('Isolate no. %j (AC-08.11 range 1..99): no request, dialog stays open, field invalid', async (v) => {
    const d = await open();
    await chosen(d);
    await userEvent.clear(isolateField(d));
    if (v) await userEvent.type(isolateField(d), v);
    await userEvent.click(assignBtn(d));
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: /assign/i })).toBeTruthy();
    expect(d.querySelector('[data-invalid],[aria-invalid="true"]')).not.toBeNull();
  });
  it('a record without isolate_seq (or above 99 -> isolate_seq_out_of_range) starts with an empty Isolate no. and the user must choose one', async () => {
    const d = await open(rec(1, { isolate_seq: undefined, match_reason: 'isolate_seq_out_of_range' }));
    expect(isolateField(d).value).toBe('');
    await chosen(d);
    await userEvent.click(assignBtn(d));
    expect(posts()).toHaveLength(0);
  });
  it('a double click sends one request; a retry after a failure reuses the Idempotency-Key', async () => {
    let n = 0;
    const d = await open(RECORD, undefined, http.post(`${ORIGIN}/v1/micro/instrument-records/:id/assign`, async () => { n += 1; await new Promise((r) => setTimeout(r, 120)); return n === 1 ? problem('common.internal', 500) : HttpResponse.json(rec(1, { match_status: 'applied', culture_id: ID(1) })); }));
    await chosen(d);
    await userEvent.dblClick(assignBtn(d));
    await waitFor(() => expect(posts().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(posts()).toHaveLength(1);
    await userEvent.click(assignBtn(d));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.headers.get('idempotency-key')).toBe(posts()[0]!.headers.get('idempotency-key'));
  });
});

describe('outcomes and errors (04-UI-UX §10): dialog stays open, choice kept, no raw code', () => {
  it('the record comes back as conflict (manual data exists): the dialog switches to the conflict choice instead of closing silently', async () => {
    const d = await open(RECORD, undefined, http.post(`${ORIGIN}/v1/micro/instrument-records/:id/assign`, () => HttpResponse.json(rec(1, { match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: ID(1) }))));
    await chosen(d);
    await userEvent.click(assignBtn(d));
    await waitFor(() => expect(document.body.textContent).toMatch(/use instrument value/i));
    expect(document.body.textContent).toMatch(/keep current value/i);
  });
  it.each([
    ['micro.instrument_record_conflict', 409, /this record conflicts with existing data\. choose which value to keep\./i],
    ['micro.report_final_locked', 409, /the final report has been sent\. reopen the culture to make changes\./i],
    ['common.version_conflict', 409, /someone else changed this\. reload and try again\./i],
    ['common.internal', 500, /something went wrong/i],
  ])('%s (%i)', async (c, status, copy) => {
    const d = await open(RECORD, undefined, writeFail('assign', c, status));
    await chosen(d);
    await userEvent.click(assignBtn(d));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /assign/i })).getByText(copy)).toBeTruthy());
    expect(document.body.textContent).not.toContain(c);
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('S-17: 404 for a culture of another centre/tenant reads as a plain "not found" message and discloses nothing', async () => {
    const d = await open(RECORD, undefined, writeFail('assign', 'common.not_found', 404));
    await chosen(d);
    await userEvent.click(assignBtn(d));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /assign/i })).getByText(/not found|no longer|reload/i)).toBeTruthy());
    expect(document.body.textContent).not.toContain('common.not_found');
  });
});
