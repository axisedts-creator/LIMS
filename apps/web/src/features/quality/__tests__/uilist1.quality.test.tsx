// @vitest-environment jsdom
// T0D-UILIST-1 (LD-353 template 1 LIST) — quality list screens that already sit on the kit: QC runs and Unassigned QC (the other quality screens are
// set-up forms, charts and the status board = other templates / other tasks; listed in notes/T0D-UILIST-1-tests-lab.md).
// Same shape as uilist1.lab.test.tsx: route default export against MSW, no rows / one row / 501 operation_pending.
// Pinned: h1 = menu label in ONE PageHeader; exactly one kit FilterBar and NO loose control outside it (QC runs still has a stray "Needs action" checkbox);
// header row always drawn inside `.lims-table-scroll`; empty = ONE EmptyState in the table body; numeric column right aligned; 501 -> NotAvailable with title + header row.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectFilterBars, expectHeader, expectNoLooseEmptyText, expectNotAvailable, expectTable } from '@/__tests__/uilist1.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/quality/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['quality.qc_run.read', 'quality.qc.manage'], displayName: 'Synthetic QC', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/quality/x',
}));

const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-11-05T04:15:00.000Z';
type Mode = 'empty' | 'one' | 501;
let mode: Mode = 'empty';
let served = 0;
const list = (rows: unknown[]) => HttpResponse.json({ data: rows, page: { limit: 50 } });
const problem = () => HttpResponse.json({ type: 'urn:lims:error:operation_pending', title: 'operation_pending', status: 501, code: 'operation_pending', request_id: '01950c12-0000-7000-8000-000000000001' }, { status: 501 });

interface Screen { name: string; path: string; api: string; row: unknown; marker: string; link?: string; load: () => Promise<unknown>; min: number; numeric?: string; loose: RegExp }
const sp = Promise.resolve({});
const SCREENS: Screen[] = [
  { name: 'qc runs', path: '/quality/runs', api: '/v1/quality/qc-runs', marker: '', link: `/quality/qc-runs/${U(0x11)}`, min: 8, loose: /no qc runs/i,
    row: { id: U(0x11), version: 1, plan_id: U(0x21), instrument_id: U(0x1a), analyte_id: U(0xd1), run_at: AT, status: 'evaluated', outcome: 'accepted', is_complete: true, observation_count: 2, controls_per_run: 2, rule_mode: 'classic', warning_rules: [], rules_violated: [], needs_action: false },
    load: async () => (await import('@/app/(staff)/quality/runs/page')).default({ searchParams: sp }) },
  { name: 'unassigned qc', path: '/quality/observations', api: '/v1/quality/qc-observations', marker: 'CTRL-SYN-9', min: 7, numeric: 'Value', loose: /all qc values are assigned/i,
    row: { id: U(0x12), instrument_id: U(0x1a), control_id_raw: 'CTRL-SYN-9', control_lot_raw: 'LOT9', control_level_raw: 'L1', value: '5.40', unit_code: 'mmol_L', observed_at: AT, status: 'no_control_map' },
    load: async () => (await import('@/app/(staff)/quality/observations/page')).default({ searchParams: sp }) },
];

const api = setupServer(
  ...SCREENS.map((s) => http.get(`${ORIGIN}${s.api}`, () => { served += 1; return mode === 'empty' ? list([]) : mode === 'one' ? list([s.row]) : problem(); })),
  http.get(`${ORIGIN}/v1/quality/qc-status`, () => list([])), // plan options: best effort
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); mode = 'empty'; served = 0; });
afterAll(() => api.close());

async function show(s: Screen, m: Mode) {
  mode = m; served = 0;
  const tree = (await s.load()) as never;
  const view = render(<ToastProvider>{tree}</ToastProvider>);
  await waitFor(() => expect(served).toBeGreaterThan(0));
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  return view.container;
}

function expectOneFilterRow(root: HTMLElement, s: Screen) {
  expectFilterBars(root, s.name, 1);
  expect(root.querySelectorAll('.lims-filter-bar[role="search"]').length, `${s.name}: the kit FilterBar`).toBe(1);
  const loose = [...root.querySelectorAll('input, select, textarea')].filter((el) => !el.closest('.lims-filter-bar, table, [role="dialog"], dialog'));
  expect(loose.length, `${s.name}: ${loose.length} control(s) outside the FilterBar (filters are ONE row)`).toBe(0);
}

describe.each(SCREENS)('$name', (s) => {
  it('no rows: PageHeader with the menu title, ONE FilterBar, header row kept, ONE EmptyState in the table body', async () => {
    const root = await show(s, 'empty');
    expectHeader(root, s.path, { noAction: true });
    expectOneFilterRow(root, s);
    expectTable(root, s.name, { min: s.min });
    expectEmptyState(root, s.name);
    expectNoLooseEmptyText(root, s.name, s.loose);
  });

  it('one row: header + FilterBar unchanged, the row shown, no EmptyState, numbers right', async () => {
    const root = await show(s, 'one');
    expectHeader(root, s.path, { noAction: true });
    expectOneFilterRow(root, s);
    const { heads } = expectTable(root, s.name, { min: s.min });
    if (s.marker) expect(root.textContent ?? '', `${s.name}: the row is shown`).toContain(s.marker);
    if (s.link) expect(root.querySelector(`a[href="${s.link}"]`), `${s.name}: row link`).not.toBeNull();
    expect(root.querySelectorAll('.lims-state').length, `${s.name}: no EmptyState next to data`).toBe(0);
    if (s.numeric) {
      const i = heads.findIndex((h) => h.toLowerCase() === s.numeric!.toLowerCase());
      const ths = [...root.querySelectorAll('table thead th')];
      expect(ths[i]?.className ?? '', `${s.name}: header ${s.numeric} right aligned`).toMatch(/lims-align-end/);
      const row = [...root.querySelectorAll('table tbody tr')].find((r) => (r.textContent ?? '').includes(s.marker));
      expect(row?.children[i]?.className ?? '', `${s.name}: cell right aligned`).toMatch(/lims-align-end/);
    }
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row, no red box', async () => {
    const root = await show(s, 501);
    expectNotAvailable(root, s.path, { table: true });
  });
});
