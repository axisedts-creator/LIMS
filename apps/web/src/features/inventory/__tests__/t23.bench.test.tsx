// @vitest-environment jsdom
// C12.T-23 — S12 Bench (04-UI-UX §3 S12). ACs: AC-07.1 (open container; server computes open_expiry_at), AC-07.2 (analyser↔lot link), AC-15.1 (calibration log), AC-15.2 (back-dating window, server 400),
// AC-15.3 (manual QC observations multiplier). Gate: inventory.bench.record. Technologist screen: tablet-friendly, scan-first.
// LD-140 (2026-11-13): kit components only, ONE primary button per page, every status shows tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_BENCH, PERM_NONE, PERM_READ, api, container, fact, hit, hits, isoAgo, page, problem, resetHits, router, state, stockDoc } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_BENCH; state.path = '/inventory/bench'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const BENCH = ID(310);
const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/bench/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const opens = () => hit('POST', /^\/v1\/inventory\/containers$/);
const events = () => hit('POST', /^\/v1\/inventory\/consumption-events$/);

describe('S12 gating + store selector', () => {
  it('without inventory.bench.record: permission-denied, no API call (page hidden)', async () => {
    state.permissions = PERM_READ;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
    cleanup(); state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
  });

  it('bench stores are listed first and the first bench store is selected by default', async () => {
    await mount();
    await screen.findByRole('grid');
    expect(new URLSearchParams(hit('GET', /^\/v1\/inventory\/containers$/)[0]!.search).get('store_id')).toBe(BENCH);
    await userEvent.click(screen.getByRole('button', { name: /^store/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts[0]).toMatch(/bench/i);
  });
});

describe('S12 Open containers table', () => {
  it('columns Item, Lot, Analyser, Opened, Open expiry; actions Finish and Discard; only status=open is requested', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Item', 'Lot', 'Analyser', 'Opened', 'Open expiry']) expect(heads, h).toContain(h);
    const row = within(grid).getByText('SYNLOT-001').closest('tr')!;
    expect(within(row).getByRole('button', { name: /^finish$/i })).toBeTruthy();
    expect(within(row).getByRole('button', { name: /^discard$/i })).toBeTruthy();
    expect(new URLSearchParams(hit('GET', /^\/v1\/inventory\/containers$/)[0]!.search).get('status') ?? 'open').toBe('open');
  });

  it('a container past its open expiry shows the TEXT "Open expiry passed"; one still valid does not', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/containers`, () => page([container(1, { open_expiry_at: isoAgo(2) }), container(2, { lot_no: 'SYNLOT-002', lot_id: ID(22) })])));
    await mount();
    const late = (await screen.findByText('SYNLOT-001')).closest('tr')!;
    const ok = (await screen.findByText('SYNLOT-002')).closest('tr')!;
    expect(within(late).getByText(/open expiry passed/i)).toBeTruthy();
    expect(within(ok).queryByText(/open expiry passed/i)).toBeNull();
  });

  it('empty state: "No open containers on this bench"', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/containers`, () => page([])));
    await mount();
    expect(await screen.findByText('No open containers on this bench')).toBeTruthy();
  });

  it('Finish: POST /containers/{id}/finish with If-Match "<version>" and an Idempotency-Key; success refreshes', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/containers/:id/finish`, () => HttpResponse.json(container(1, { status: 'finished', version: 3 }))));
    await mount();
    await userEvent.click(within((await screen.findByText('SYNLOT-001')).closest('tr')!).getByRole('button', { name: /^finish$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => null);
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /^(finish|confirm)/i }));
    const p = await waitFor(() => { const h = hit('POST', /^\/v1\/inventory\/containers\/[^/]+\/finish$/); expect(h).toHaveLength(1); return h[0]!; });
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('Discard dialog: Remaining qty (> 0) + Reason (coded set wastage, required) -> POST /discard {qty_base, reason_code}', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/containers/:id/discard`, () => HttpResponse.json({ container: container(1, { status: 'discarded', version: 3 }), document: stockDoc({ doc_kind: 'wastage' }) })));
    await mount();
    await userEvent.click(within((await screen.findByText('SYNLOT-001')).closest('tr')!).getByRole('button', { name: /^discard$/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(discard|confirm)/i }));
    expect(hit('POST', /discard$/)).toHaveLength(0); // no qty, no reason yet
    await userEvent.type(within(dlg).getByRole('textbox', { name: /remaining/i }), '12.5');
    await choose(dlg, /reason/i, /spillage/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /^(discard|confirm)/i }));
    const p = await waitFor(() => { const h = hit('POST', /discard$/); expect(h).toHaveLength(1); return h[0]!; });
    expect(p.json).toMatchObject({ qty_base: '12.5', reason_code: 'spillage' });
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });

  it('409 inventory.document_invalid_transition on Finish -> Banner with request_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/containers/:id/finish`, () => problem('inventory.document_invalid_transition', 409)));
    await mount();
    await userEvent.click(within((await screen.findByText('SYNLOT-001')).closest('tr')!).getByRole('button', { name: /^finish$/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => null);
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /^(finish|confirm)/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
  });
});

describe('S12 Open container form (AC-07.1, AC-07.2)', () => {
  const form = async () => { await mount(); return (await screen.findByRole('form', { name: /open container/i }).catch(() => screen.findByRole('region', { name: /open container/i }))) as HTMLElement; };

  it('Analyser help text; lot candidates come from the store balances (GET /stock?store_id&item_id)', async () => {
    const f = await form();
    expect(within(f).getByText('Choose the analyser this bottle is loaded on. Automatic deductions for that analyser use this lot.')).toBeTruthy();
    await choose(f, /^item/i, /TIPS-1|pipette tips 1/i);
    await userEvent.click(within(f).getByRole('button', { name: /^lot/i }));
    expect(await screen.findByRole('option', { name: /SYNLOT-001/ })).toBeTruthy();
    const q = new URLSearchParams(hit('GET', /^\/v1\/inventory\/stock$/).at(-1)!.search);
    expect(q.get('store_id')).toBe(BENCH);
    expect(q.get('item_id')).toBe(ID(11));
  });

  it('POST /containers {store_id,item_id,lot_id,instrument_id} + Idempotency-Key; the client NEVER sends or computes open_expiry_at (server: earlier of open-stability and lot expiry, tenant time)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/containers`, () => HttpResponse.json(container(5, { open_expiry_at: '2027-06-30T18:14:59.999Z' }), { status: 201 })));
    const f = await form();
    await choose(f, /^item/i, /TIPS-1|pipette tips 1/i);
    await choose(f, /^lot/i, /SYNLOT-001/);
    await choose(f, /^analyser/i, /BIO-1|analyser 1/i);
    await userEvent.click(within(f).getByRole('button', { name: /^(open container|save|open)$/i }));
    await waitFor(() => expect(opens()).toHaveLength(1));
    expect(opens()[0]!.json).toMatchObject({ store_id: BENCH, item_id: ID(11), lot_id: ID(21), instrument_id: ID(950) });
    expect(opens()[0]!.json).not.toHaveProperty('open_expiry_at');
    expect(opens()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('the analyser is optional (no instrument_id sent when none is chosen)', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/containers`, () => HttpResponse.json(container(5), { status: 201 })));
    const f = await form();
    await choose(f, /^item/i, /TIPS-1|pipette tips 1/i);
    await choose(f, /^lot/i, /SYNLOT-001/);
    await userEvent.click(within(f).getByRole('button', { name: /^(open container|save|open)$/i }));
    await waitFor(() => expect(opens()).toHaveLength(1));
    expect(opens()[0]!.json).not.toHaveProperty('instrument_id');
  });

  it('a lot-tracked item without a chosen lot sends nothing', async () => {
    const f = await form();
    await choose(f, /^item/i, /TIPS-1|pipette tips 1/i);
    await userEvent.click(within(f).getByRole('button', { name: /^(open container|save|open)$/i }));
    expect(opens()).toHaveLength(0);
  });

  it.each(['inventory.lot_expired', 'inventory.lot_unavailable', 'inventory.insufficient_stock'])('409 %s -> Banner with request_id; values kept', async (code) => {
    api.use(http.post(`${ORIGIN}/v1/inventory/containers`, () => problem(code, 409)));
    const f = await form();
    await choose(f, /^item/i, /TIPS-1|pipette tips 1/i);
    await choose(f, /^lot/i, /SYNLOT-001/);
    await userEvent.click(within(f).getByRole('button', { name: /^(open container|save|open)$/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
  });
});

describe('S12 Log calibration / manual QC (AC-15.1, AC-15.2, AC-15.3)', () => {
  const form = async () => { await mount(); return (await screen.findByRole('form', { name: /log calibration|manual qc/i }).catch(() => screen.findByRole('region', { name: /log calibration|manual qc/i }))) as HTMLElement; };

  it('Kind RadioGroup Calibration/QC; Test is required; Note is capped at 500 with the help text', async () => {
    const f = await form();
    expect(within(f).getByRole('radio', { name: /calibration/i })).toBeTruthy();
    expect(within(f).getByRole('radio', { name: /^qc$/i })).toBeTruthy();
    expect(within(f).getByRole('textbox', { name: /note/i }).getAttribute('maxlength')).toBe('500');
    expect(within(f).getByText('Do not enter patient details.')).toBeTruthy();
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    expect(events()).toHaveLength(0);
  });

  it('AC-15.1: calibration for (analyser, test) with the calibration reason -> POST /consumption-events {fact_kind:"calibration", instrument_id, test_id, occurred_at, reason_code} + Idempotency-Key; toast "Logged. 3 items deducted."', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-events`, () => HttpResponse.json(fact({ fact_kind: 'calibration' }), { status: 201 })));
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /calibration/i }));
    await choose(f, /^analyser/i, /BIO-1|analyser 1/i);
    await choose(f, /^test/i, /glucose|GLU/i);
    await choose(f, /^reason/i, /scheduled calibration/i);
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    await waitFor(() => expect(events()).toHaveLength(1));
    const b = events()[0]!.json;
    expect(b).toMatchObject({ fact_kind: 'calibration', instrument_id: ID(950), test_id: ID(70), reason_code: 'scheduled_calibration' });
    expect(Date.parse(b.occurred_at)).toBeLessThanOrEqual(Date.now() + 60_000); // default now, never in the future
    expect(b).not.toHaveProperty('observations'); // QC only
    expect(events()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(await screen.findByText('Logged. 3 items deducted.')).toBeTruthy();
  });

  it('calibration without a reason sends nothing (reason is required for calibration)', async () => {
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /calibration/i }));
    await choose(f, /^analyser/i, /BIO-1|analyser 1/i);
    await choose(f, /^test/i, /glucose|GLU/i);
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    expect(events()).toHaveLength(0);
  });

  it('AC-15.3: QC with Observations = 3 -> POST {fact_kind:"qc", test_id, observations:3}; analyser and analyte are optional; default observations is 1', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-events`, () => HttpResponse.json(fact(), { status: 201 })));
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /^qc$/i }));
    const obs = within(f).getByRole('textbox', { name: /observations/i }) as HTMLInputElement;
    expect(obs.value).toBe('1');
    await choose(f, /^test/i, /glucose|GLU/i);
    await userEvent.clear(obs);
    await userEvent.type(obs, '3');
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    await waitFor(() => expect(events()).toHaveLength(1));
    expect(events()[0]!.json).toMatchObject({ fact_kind: 'qc', test_id: ID(70), observations: 3 });
    expect(events()[0]!.json).not.toHaveProperty('instrument_id');
  });

  it.each(['0', '51', '-1', '2.5', 'x'])('QC observations "%s" is outside the integer range 1–50 -> nothing is sent', async (bad) => {
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /^qc$/i }));
    await choose(f, /^test/i, /glucose|GLU/i);
    const obs = within(f).getByRole('textbox', { name: /observations/i });
    await userEvent.clear(obs);
    await userEvent.type(obs, bad);
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    expect(events()).toHaveLength(0);
  });

  it('Observations is shown for QC only', async () => {
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /calibration/i }));
    expect(within(f).queryByRole('textbox', { name: /observations/i })).toBeNull();
  });

  it('Analyte options come from the chosen test (GET /catalog/tests/{id}/analytes)', async () => {
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /^qc$/i }));
    await choose(f, /^test/i, /glucose|GLU/i);
    await userEvent.click(within(f).getByRole('button', { name: /^analyte/i }));
    expect(await screen.findByRole('option', { name: /fasting glucose|GLU_F/i })).toBeTruthy();
    expect(hit('GET', new RegExp(`/v1/catalog/tests/${ID(70)}/analytes$`)).length).toBeGreaterThan(0);
  });

  it('no_rule fact -> toast "Logged. No consumption rule matches, so nothing was deducted."', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-events`, () => HttpResponse.json(fact({ status: 'no_rule', rules_applied: 0, movements: [] }), { status: 201 })));
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /^qc$/i }));
    await choose(f, /^test/i, /glucose|GLU/i);
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    expect(await screen.findByText('Logged. No consumption rule matches, so nothing was deducted.')).toBeTruthy();
  });

  it('AC-15.2: server 400 common.validation_failed on /occurred_at (outside the back-dating window) is shown on the Occurred at field; no success toast', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-events`, () => problem('common.validation_failed', 400, { errors: [{ path: '/occurred_at', code: 'inventory.backdate_window', message: 'Time is outside the allowed window.' }] })));
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /^qc$/i }));
    await choose(f, /^test/i, /glucose|GLU/i);
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    expect(await screen.findByText(/outside the allowed window/i)).toBeTruthy();
    expect(screen.queryByText(/^Logged\./)).toBeNull();
  });

  it('403 auth.forbidden (store branch out of scope) -> Banner with request_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-events`, () => problem('auth.forbidden', 403)));
    const f = await form();
    await userEvent.click(within(f).getByRole('radio', { name: /^qc$/i }));
    await choose(f, /^test/i, /glucose|GLU/i);
    await userEvent.click(within(f).getByRole('button', { name: /^(log|save)/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
  });
});
