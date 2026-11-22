// @vitest-environment jsdom
// T0D-UILIST-1 (LD-353 template 1 LIST, rules 5 / 6 / 8; done_when 1, 2, 4, 6, 7) — lab list screens.
// Per screen the default export of the route is rendered against MSW with fake data, twice (no rows, one row), plus a 500 case (client-read screens: ErrorState keeps the
// title, filters, Retry and a Reference) and a 501 operation_pending case (NotAvailable keeps the title and the table header row, no red alert).
// Pinned per screen: h1 = ElabAssist menu label inside ONE PageHeader; primary action once, in the header; exactly one kit FilterBar (`.lims-filter-bar[role=search]`) where the
// screen filters, and no loose input/select outside it; table header row always drawn, inside `.lims-table-scroll`; an empty list is ONE EmptyState in the table body (no loose
// "No x." text); a numeric column is right aligned (`lims-align-end` on header and cell).
// Left alone here (other tasks own them): lab verification and approval queues (T0D-VERLEVEL-1); scan screens collect / receive (T0D-UISCAN-1); lab settings (T0D-UISETTINGS-1); detail pages.
// Not pinned: pending "Over target only" (the brief names no filter row for it); status board 500/501 (its page swallows a failed first read by design and polls).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectFilterBars, expectHeader, expectNoLooseEmptyText, expectNotAvailable, expectTable, menuLabel } from '@/__tests__/uilist1.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const PERMS = ['lab.worklist.read', 'lab.worksheet.manage', 'lab.qc.capture', 'lab.critical_value.read', 'lab.result.read', 'lab.status_board.read'];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/lab/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: PERMS, displayName: 'Synthetic Lab', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/x',
}));

const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const DEPT = '0d1d1d1d-ac40-7000-8000-0000000000d1';
const AT = '2026-11-05T04:15:00.000Z';
const patient = { full_name: 'Synthetic Patient 1', age_sex: '34Y/F', patient_code: 'PC1' };

type Mode = 'empty' | 'one' | 500 | 501;
let mode: Mode = 'empty';
let served = 0;
const problem = (status: number) => HttpResponse.json({ type: 'urn:lims:error:x', title: 'x', status, code: status === 501 ? 'operation_pending' : 'common.internal', request_id: '01950c12-0000-7000-8000-000000000001' }, { status });
const list = (rows: unknown[]) => HttpResponse.json({ data: rows, page: { limit: 50 } });

interface Screen {
  name: string; path: string; api: string; row: unknown; marker: string;
  load: () => Promise<unknown>;
  filters: number | null;             // exactly this many kit FilterBars; null = not pinned
  action?: string;                    // the one primary action, in the header
  min: number;                        // least header cells
  numeric?: string;                   // a numeric column header: header and cell right aligned
  link?: string;                      // href of a link that must be in the one-row table
  loose: RegExp;                      // the old "No x." wording that must live in the EmptyState only
  err: boolean;                       // 500 case: the screen reads on the client and must show ErrorState
  na: boolean;                        // 501 case: NotAvailable
  forbid?: RegExp;                    // development copy that must not appear
}
const sp = { searchParams: Promise.resolve({}) };
const SCREENS: Screen[] = [
  { name: 'worksheets', path: '/lab/worksheets', api: '/v1/lab/worksheets', marker: 'Morning haematology', filters: 0, min: 3, numeric: 'Rows', loose: /no worksheets/i, err: true, na: true,
    row: { id: U(0xb1), title: 'Morning haematology', centre_id: U(0xa1), department_id: DEPT, created_at: AT, row_count: 30 },
    load: async () => (await import('@/app/(staff)/lab/worksheets/page')).default() },
  { name: 'worklists (departments)', path: '/lab/worklists', api: '/v1/catalog/departments', marker: 'Haematology', filters: 0, min: 2, link: `/lab/worklists/${DEPT}`, loose: /no active departments/i, err: false, na: true,
    row: { id: DEPT, code: 'HAEM', name: 'Haematology', is_active: true },
    load: async () => (await import('@/app/(staff)/lab/worklists/page')).default() },
  { name: 'worklist of one department', path: '/lab/worklists', api: '/v1/lab/worklist-items', marker: 'R2611050001', filters: 1, action: 'Create worksheet', min: 8, loose: /no pending tests/i, err: true, na: true,
    row: { order_test_id: U(0x101), order_id: U(0x201), specimen_id: U(0x301), barcode: 'E260000101', registration_no: 'R2611050001', patient_display: patient, test_id: U(0x401), test_code: 'CBC', priority: 'routine', status: 'in_process', received_at: AT, result_counts: { total: 3, resulted: 1, verified: 0 } },
    load: async () => (await import('@/app/(staff)/lab/worklists/[department_id]/page')).default({ params: Promise.resolve({ department_id: DEPT }) }) },
  { name: 'pending', path: '/lab/pending', api: '/v1/lab/pending-items', marker: 'R2611050002', filters: null, min: 6, loose: /nothing pending/i, err: true, na: true,
    row: { order_test_id: U(0x501), order_id: U(0x601), registration_no: 'R2611050002', patient_display: patient, test_code: 'CBC', item_status: 'in_process', priority: 'routine', centre_id: U(0xa1), age_seconds: 1800, age_anchor: 'received', over_target: false },
    load: async () => (await import('@/app/(staff)/lab/pending/page')).default() },
  { name: 'qc', path: '/lab/qc', api: '/v1/lab/qc-results', marker: 'CTRL-SYN-1', filters: 0, action: 'Add QC result', min: 8, numeric: 'Value', loose: /no qc results/i, err: true, na: true,
    forbid: /rules arrive|QC module/i,
    row: { id: U(0xc1), centre_id: U(0xa1), instrument_id: U(0x1a), analyte_id: U(0xd1), control_id_raw: 'CTRL-SYN-1', control_lot_raw: 'LOT1', control_level: 'L1', value_numeric: '5.40', unit_code: 'mmol_L', instrument_result_time: AT, source: 'manual', received_at: AT },
    load: async () => (await import('@/app/(staff)/lab/qc/page')).default() },
  { name: 'critical values', path: '/lab/critical-values', api: '/v1/lab/critical-values', marker: 'POTASSIUM_SYN', filters: 1, min: 5, loose: /no critical values/i, err: false, na: true,
    row: { id: U(0xe1), analyte_code: 'POTASSIUM_SYN', direction: 'high', status: 'open', detected_at: AT },
    load: async () => (await import('@/app/(staff)/lab/critical-values/page')).default(sp) },
  { name: 'ingest exceptions', path: '/lab/ingest-exceptions', api: '/v1/lab/ingest-exceptions', marker: 'E260000999', filters: 1, min: 6, loose: /no open instrument exceptions/i, err: false, na: true,
    row: { id: U(0xf1), status: 'open', reason: 'unmapped_code', result_key: 'k1', created_at: AT, sample_barcode: 'E260000999', instrument_analyte_code: 'SYN_K' },
    load: async () => (await import('@/app/(staff)/lab/ingest-exceptions/page')).default(sp) },
  { name: 'status board', path: '/lab/status-board', api: '/v1/lab/status-board', marker: 'R2611050003', filters: 1, min: 5, loose: /no registrations in this period/i, err: false, na: false,
    row: { order_id: U(0x701), registration_no: 'R2611050003', patient_display: patient, centre_id: U(0xa1), board_status: 'in_lab', rejected_specimens: 0, priority: 'routine' },
    load: async () => (await import('@/app/(staff)/lab/status-board/page')).default(sp) },
];

const api = setupServer(
  ...SCREENS.map((s) => http.get(`${ORIGIN}${s.api}`, () => { served += 1; return mode === 'empty' ? list([]) : mode === 'one' ? list([s.row]) : problem(mode); })),
  http.get(`${ORIGIN}/v1/identity/centres`, () => list([{ centre_id: U(0xa1), name: 'Synthetic Centre A1', is_active: true }])),
  http.get(`${ORIGIN}/v1/instruments/instruments`, () => list([{ id: U(0x1a), display_name: 'Synthetic Analyser 1', instrument_code: 'SYN-A1', centre_id: U(0xa1), state: 'live' }])),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); mode = 'empty'; served = 0; });
afterAll(() => api.close());

/** Render the route's default export, wait for its first read and the state update after it. */
async function show(s: Screen, m: Mode) {
  mode = m; served = 0;
  const tree = (await s.load()) as never;
  const view = render(<ToastProvider>{tree}</ToastProvider>);
  await waitFor(() => expect(served).toBeGreaterThan(0));
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  return view.container;
}

/** LD-353 rule 2 / done_when 2: ONE kit FilterBar (role=search); the screen has no second filter row and no loose control outside it. */
function expectOneFilterRow(root: HTMLElement, s: Screen) {
  if (s.filters === null) return;
  expectFilterBars(root, s.name, s.filters);
  expect(root.querySelectorAll('.lims-filter-bar[role="search"]').length, `${s.name}: the filter row is the kit FilterBar (role=search), not a hand-made toolbar`).toBe(s.filters);
  const loose = [...root.querySelectorAll('input, select, textarea')].filter((el) => !el.closest('.lims-filter-bar, table, [role="dialog"], dialog'));
  expect(loose.length, `${s.name}: ${loose.length} control(s) outside the FilterBar`).toBe(0);
}

function expectNumericRight(root: HTMLElement, s: Screen) {
  if (!s.numeric) return;
  const ths = [...root.querySelectorAll('table thead th')];
  const i = ths.findIndex((th) => (th.textContent ?? '').trim().toLowerCase() === s.numeric!.toLowerCase());
  expect(i, `${s.name}: column ${s.numeric}`).toBeGreaterThanOrEqual(0);
  expect(ths[i]!.className, `${s.name}: header "${s.numeric}" right aligned`).toMatch(/lims-align-end/);
  const row = [...root.querySelectorAll('table tbody tr')].find((r) => (r.textContent ?? '').includes(s.marker));
  expect(row, `${s.name}: the data row`).toBeTruthy();
  expect(row!.children[i]!.className, `${s.name}: numeric cell right aligned`).toMatch(/lims-align-end/);
}

describe.each(SCREENS)('$name', (s) => {
  it('no rows: PageHeader with the menu title, one filter row, header row kept, ONE EmptyState in the table body', async () => {
    const root = await show(s, 'empty');
    expectHeader(root, s.path, s.action ? { action: s.action } : {});
    expectOneFilterRow(root, s);
    expectTable(root, s.name, { min: s.min });
    expectEmptyState(root, s.name);
    expectNoLooseEmptyText(root, s.name, s.loose);
    if (s.forbid) expect(root.textContent ?? '').not.toMatch(s.forbid);
  });

  it('one row: same header and filter row, header row + the row, no EmptyState, numbers right', async () => {
    const root = await show(s, 'one');
    expectHeader(root, s.path, s.action ? { action: s.action } : {});
    expectOneFilterRow(root, s);
    expectTable(root, s.name, { min: s.min });
    expect(root.textContent ?? '', `${s.name}: the row is shown`).toContain(s.marker);
    expect(root.querySelectorAll('.lims-state').length, `${s.name}: no EmptyState next to data`).toBe(0);
    if (s.link) expect(root.querySelector(`a[href="${s.link}"]`), `${s.name}: link ${s.link}`).not.toBeNull();
    expectNumericRight(root, s);
    if (s.forbid) expect(root.textContent ?? '').not.toMatch(s.forbid);
  });

  if (s.err) {
    it('API 500: ErrorState (message, Reference, Retry) under the same title, filters kept', async () => {
      const root = await show(s, 500);
      // not the shared expectErrorState: it forbids the words "Something went wrong", which are the ErrorState's own title here (only the error PAGE is forbidden)
      expect([...root.querySelectorAll('h1')].map((h) => h.textContent), `${s.name}: the title stays on error`).toEqual([menuLabel(s.path)]);
      const err = root.querySelectorAll('.lims-state.lims-tone-danger');
      expect(err.length, `${s.name}: one ErrorState`).toBe(1);
      expect(err[0]!.querySelector('.lims-state-ref')?.textContent ?? '', `${s.name}: Reference line`).toMatch(/reference/i);
      expect([...err[0]!.querySelectorAll('button')].map((b) => b.textContent), `${s.name}: Retry`).toContain('Retry');
      expect(root.querySelectorAll('[role="alert"]').length, `${s.name}: no extra alert box next to the ErrorState`).toBe(0);
      expectOneFilterRow(root, s);
    });
  }

  if (s.na) {
    it('API 501 operation_pending: NotAvailable keeps the title and the header row, no red box', async () => {
      const root = await show(s, 501);
      expectNotAvailable(root, s.path, { table: true });
    });
  }
});

describe('menu titles', () => {
  it('the nine pinned routes all have a sidebar label (a missing entry would make every title test meaningless)', () => {
    for (const p of new Set(SCREENS.map((s) => s.path))) expect(menuLabel(p).length, p).toBeGreaterThan(0);
  });
});
