// @vitest-environment jsdom
// C10.T-23 — culture page tab "Instrument data" (04-UI-UX §3.5: records of this culture via listMicroInstrumentRecords?culture_id=, same columns as §4 minus Barcode, actions Apply / Resolve / Ignore;
// AC-08.9 banner on a final_submitted culture: "Instrument data arrived after the final report"). CultureScreen is the T-20 seam. LD-140: kit only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { BARCODE, ID, LIST, ORIGIN, PERM_READ, PERM_WORK, api, clean, conflictCulture, hit, instrumentList, rec, recordList, resetHits, router, rowAction, state, writeOk } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const RECS = [
  rec(2, { match_status: 'needs_mapping', match_reason: undefined, culture_id: ID(1) }),
  rec(3, { match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: ID(1) }),
  rec(9, { match_status: 'pending_match', match_reason: 'lookup_unavailable', culture_id: ID(99) }), // another culture's record must never show here
];
const mount = async (c: Record<string, unknown> = conflictCulture(), permissions = PERM_WORK) => {
  api.use(recordList(RECS), instrumentList(), writeOk('apply'), writeOk('ignore'));
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={permissions} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^instrument data/i }));
};

describe('tab "Instrument data" (§3.5)', () => {
  it('loads GET /instrument-records?culture_id=<this culture> (all statuses, so applied / ignored history shows) when the tab opens, not before', async () => {
    api.use(recordList(RECS), instrumentList());
    const { CultureScreen } = await import('../components/culture/CultureScreen');
    render(<ToastProvider><CultureScreen culture={conflictCulture() as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={PERM_WORK} /></ToastProvider>);
    expect(hit('GET', LIST)).toHaveLength(0);
    await userEvent.click(screen.getByRole('tab', { name: /^instrument data/i }));
    await waitFor(() => expect(hit('GET', LIST).length).toBeGreaterThan(0));
    const q = new URLSearchParams(hit('GET', LIST)[0]!.search);
    expect(q.get('culture_id')).toBe(ID(1));
    for (const s of ['applied', 'ignored', 'conflict', 'needs_mapping']) expect((q.get('match_status') ?? '').split(','), s).toContain(s);
  });
  it('lists only this culture\'s records, with the §4 columns minus Barcode; the barcode is not shown', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBeGreaterThan(1));
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Received', 'Instrument', 'Kind', 'Isolate no.', 'Code', 'Value', 'Status', 'Reason']) expect(heads, h).toContain(h);
    expect(heads).not.toContain('Barcode');
    expect(grid.textContent).not.toContain(BARCODE); // barcode stays on the page identity card (04-UI-UX:61); only the tab columns drop it (:160)
    expect(within(grid).getByText('Needs code mapping')).toBeTruthy();
    expect(within(grid).getByText('Conflict')).toBeTruthy();
    expect(within(grid).queryByText('Waiting for match')).toBeNull();
  });
  it('row actions are Apply / Resolve conflict / Ignore — no "Assign to culture" (the culture is known)', async () => {
    await mount();
    await within(await screen.findByRole('grid')).findByText('Needs code mapping');
    await rowAction(/Needs code mapping/, /^apply$/i);
    await waitFor(() => expect(hit('POST', /\/apply$/).length).toBe(1));
    cleanup(); resetHits();
    await mount();
    const row = within(await screen.findByRole('grid')).getAllByRole('row').find((r) => /Conflict/.test(r.textContent ?? ''))!;
    const buttons = within(row).getAllByRole('button');
    await userEvent.click(buttons[buttons.length - 1]!);
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent?.trim());
    expect(items).toEqual(expect.arrayContaining(['Resolve conflict', 'Ignore']));
    expect(items).not.toContain('Assign to culture');
  });
  it('without micro.culture.work: records are listed, no row actions', async () => {
    await mount(conflictCulture(), PERM_READ);
    const grid = await screen.findByRole('grid');
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBeGreaterThan(1));
    expect(within(grid).queryAllByRole('button', { name: /apply|resolve|ignore|assign/i })).toHaveLength(0);
  });
  it('empty: a short empty state, no table', async () => {
    api.use(recordList([]), instrumentList());
    const { CultureScreen } = await import('../components/culture/CultureScreen');
    render(<ToastProvider><CultureScreen culture={conflictCulture() as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={PERM_WORK} /></ToastProvider>);
    await userEvent.click(screen.getByRole('tab', { name: /^instrument data/i }));
    expect(await screen.findByText(/no instrument data/i)).toBeTruthy();
  });
  it('a failing list shows a retryable error, not an empty state, and no raw message', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/instrument-records`, () => HttpResponse.json({ code: 'common.internal', status: 500, title: 'common.internal', type: 'x' }, { status: 500 })), instrumentList());
    const { CultureScreen } = await import('../components/culture/CultureScreen');
    render(<ToastProvider><CultureScreen culture={conflictCulture() as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={PERM_WORK} /></ToastProvider>);
    await userEvent.click(screen.getByRole('tab', { name: /^instrument data/i }));
    expect(await screen.findByRole('button', { name: /retry|try again/i })).toBeTruthy();
    expect(document.body.textContent).not.toContain('common.internal');
  });
});

describe('late data after the final report (AC-08.9)', () => {
  it('a final_submitted culture with open instrument records shows a banner "Instrument data arrived after the final report"', async () => {
    const c = conflictCulture({ status: 'final_submitted', open_instrument_record_count: 1, current_report_version_no: 2, last_report_phase: 'final' });
    api.use(recordList([clean(rec(4, { match_status: 'late_after_final', match_reason: undefined, culture_id: ID(1) }))]), instrumentList());
    const { CultureScreen } = await import('../components/culture/CultureScreen');
    render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={PERM_WORK} /></ToastProvider>);
    expect(document.body.textContent).toContain('Instrument data arrived after the final report');
  });
  it('no banner when nothing is waiting', async () => {
    const c = conflictCulture({ status: 'final_submitted', open_instrument_record_count: 0, current_report_version_no: 2, last_report_phase: 'final' });
    const { CultureScreen } = await import('../components/culture/CultureScreen');
    render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={PERM_WORK} /></ToastProvider>);
    expect(document.body.textContent).not.toContain('Instrument data arrived after the final report');
  });
});
