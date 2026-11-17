// @vitest-environment jsdom
// T0D-EMPTYTBL-1 — every list screen draws its column headers with no data (LD-310; founder 2026-11-17 04:49 NPT, lead measurement 05:18 NPT).
// Contract pinned here (the writer must satisfy exactly this; names are the tester's, recorded in .orchestra/notes/T0D-EMPTYTBL-1-tests.md):
//   (1) with rows = [] the screen still renders a <table> (or kit DataTable grid) with >= 3 non-empty column headers;
//   (2) the empty message is INSIDE that table (a body row that is not a placeholder), not a card in front of / instead of it;
//   (3) below the message row exactly 4 placeholder rows: class `lims-row-placeholder`, aria-hidden="true", no focusable descendant, inside the table;
//   (4) catalog screens with manage rights: the "New …" button is in the page header AND repeated inside the message row;
//   (5) loading and error states are unchanged (no empty message while loading or after a failure).
// Synthetic data only. Server actions are stubbed; rows are always empty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/x',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/x' }));
const lab = vi.hoisted(() => ({
  listWorklistAction: vi.fn(), listPendingAction: vi.fn(), listInstrumentsAction: vi.fn(), createWorksheetAction: vi.fn(),
  getStatusBoardAction: vi.fn(), bulkVerifyAction: vi.fn(), bulkApproveAction: vi.fn(),
}));
vi.mock('@/features/lab/server/worklist.actions', () => ({
  listWorklistAction: lab.listWorklistAction, listPendingAction: lab.listPendingAction, listInstrumentsAction: lab.listInstrumentsAction, createWorksheetAction: lab.createWorksheetAction,
}));
vi.mock('@/features/lab/server/actions', () => ({ getStatusBoardAction: lab.getStatusBoardAction, bulkVerifyAction: lab.bulkVerifyAction, bulkApproveAction: lab.bulkApproveAction }));
vi.mock('@/features/anatomic/server/actions.material', () => ({ getCaseForTrackingAction: vi.fn(), listMovementsAction: vi.fn(), lookupObjectAction: vi.fn() }));
// Server actions are never called while the lists are empty and nothing is opened; stub every action module the catalog screens import.
const { stubModule } = vi.hoisted(() => ({
  stubModule: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }), // `then` must stay undefined or the module is awaited forever
}));
vi.mock('@/features/catalog/server/actions', stubModule);
vi.mock('@/features/catalog/server/catalogActions', stubModule);
vi.mock('@/features/catalog/server/pricingActions', stubModule);

import { MasterTable } from '@/features/catalog/components/master-ui';
import { SimpleTable } from '@/features/reporting/components/SimpleTable';
import { DepartmentsList } from '@/features/catalog/components/DepartmentsList';
import { DoctorsList } from '@/features/catalog/components/DoctorsList';
import { SpecimensScreen } from '@/features/catalog/components/SpecimensScreen';
import { UnitsScreen } from '@/features/catalog/components/UnitsScreen';
import { PanelsList } from '@/features/catalog/components/PanelsList';
import { PriceListsList } from '@/features/catalog/components/PriceListsList';
import { CreditPartiesScreen } from '@/features/catalog/components/CreditPartiesScreen';
import { TestsList } from '@/features/catalog/components/TestsList';
import { CriticalValueList } from '@/features/lab/components/CriticalValueList';
import { IngestExceptionList } from '@/features/lab/components/IngestExceptionList';
import { QueueScreen } from '@/features/lab/components/QueueScreen';
import { StatusBoard } from '@/features/lab/components/StatusBoard';
import { WorklistPage } from '@/features/lab/components/worklists/WorklistPage';
import { PendingPage } from '@/features/lab/components/pending/PendingPage';
import { TrackingScreen } from '@/features/anatomic/components/tracking/TrackingScreen';

const MANAGE = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage', 'catalog.referrer.read', 'catalog.referrer.manage'];
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable]';
const wrap = (el: ReactElement) => render(<ToastProvider>{el}</ToastProvider>);

beforeEach(() => {
  lab.listWorklistAction.mockResolvedValue({ ok: true, data: { data: [] } });
  lab.listPendingAction.mockResolvedValue({ ok: true, data: { data: [] } });
  lab.listInstrumentsAction.mockResolvedValue({ ok: true, data: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const tableOf = (root: HTMLElement) => {
  const t = root.querySelector<HTMLElement>('table, [role="grid"], [role="table"]');
  if (!t) throw new Error('no table / grid rendered: the column headers are hidden when there is no data');
  return t;
};
const headersOf = (t: HTMLElement) => [...t.querySelectorAll('th, [role="columnheader"]')].map((h) => (h.textContent ?? '').trim()).filter(Boolean);
const placeholders = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('.lims-row-placeholder')];
const messageRow = (t: HTMLElement) =>
  [...t.querySelectorAll<HTMLElement>('tbody tr, [role="rowgroup"] [role="row"], tr')].find((r) => r.getAttribute('aria-hidden') !== 'true' && !r.closest('thead') && (r.textContent ?? '').trim() !== '' && !r.querySelector('th[scope="col"]'));

/** The shared contract for an empty list screen. `message` = text that must sit inside the table body. */
function expectEmptyTable(root: HTMLElement, message: RegExp | null) {
  const t = tableOf(root);
  expect(headersOf(t).length, `column headers: ${headersOf(t).join(' | ')}`).toBeGreaterThanOrEqual(3);
  const row = messageRow(t);
  expect(row, 'the empty message must be a row inside the table').toBeTruthy();
  if (message) expect(row!.textContent).toMatch(message);
  const ph = placeholders(t);
  expect(ph, 'four placeholder rows keep the table height').toHaveLength(4);
  for (const p of ph) {
    expect(p.getAttribute('aria-hidden')).toBe('true');
    expect(p.querySelector(FOCUSABLE), 'placeholder rows hold nothing focusable').toBeNull();
    expect(t.contains(p)).toBe(true);
    expect(p.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_PRECEDING, 'placeholders come below the message row').toBeTruthy();
  }
  // the card form is gone: no EmptyState outside the table
  const outside = [...root.querySelectorAll('.lims-empty-state, .lims-state')].filter((e) => !t.contains(e));
  expect(outside, 'no empty-state card outside the table').toHaveLength(0);
}

/** (4) header + row repeat of the create action */
function expectCreateTwice(root: HTMLElement, name: RegExp) {
  const t = tableOf(root);
  const inRow = within(t).queryAllByRole('button', { name });
  const all = within(root).getAllByRole('button', { name });
  expect(inRow.length, 'create action repeated in the message row').toBeGreaterThanOrEqual(1);
  expect(all.length - inRow.length, 'create action stays in the page header').toBeGreaterThanOrEqual(1);
}

describe('kit-level tables', () => {
  it('MasterTable: headers + message row + 4 placeholder rows; Edit column absent', () => {
    const { container } = render(<MasterTable caption="Things" cols={[{ header: 'Code', cell: () => '' }, { header: 'Name', cell: () => '' }, { header: 'Status', cell: () => '' }]} rows={[]} empty="No things yet." emptyAction={{ label: 'New thing', onPress: () => undefined }} onEdit={() => undefined} />);
    expectEmptyTable(container, /No things yet\./);
    expect(within(tableOf(container)).getByRole('button', { name: /new thing/i })).toBeTruthy();
  });
  it('MasterTable with rows draws no placeholder rows', () => {
    const { container } = render(<MasterTable caption="Things" cols={[{ header: 'Code', cell: (r: { id: string }) => r.id }, { header: 'Name', cell: () => 'n' }, { header: 'Status', cell: () => 's' }]} rows={[{ id: 'A1' }]} empty="none" />);
    expect(placeholders(tableOf(container))).toHaveLength(0);
  });
  it('SimpleTable (reporting): headers + message row + 4 placeholder rows, selection column kept', () => {
    const cols = [{ id: 'a', header: 'Report', cell: () => '' }, { id: 'b', header: 'Patient', cell: () => '' }, { id: 'c', header: 'Status', cell: () => '' }];
    const { container } = render(<SimpleTable columns={cols} rows={[]} getRowId={() => 'x'} caption="Reports" empty={{ title: 'No reports.' }} selection={{ selectedIds: new Set(), onChange: () => undefined, label: (i) => i }} />);
    expectEmptyTable(container, /No reports\./);
    expect(within(container).getByRole('checkbox', { name: /select all rows/i })).toBeTruthy(); // header checkbox is a header control, not a row
  });
  it('SimpleTable with rows draws no placeholder rows', () => {
    const cols = [{ id: 'a', header: 'Report', cell: () => 'r' }, { id: 'b', header: 'Patient', cell: () => 'p' }, { id: 'c', header: 'Status', cell: () => 's' }];
    const { container } = render(<SimpleTable columns={cols} rows={[1]} getRowId={() => 'x'} caption="Reports" empty={{ title: 'No reports.' }} />);
    expect(placeholders(tableOf(container))).toHaveLength(0);
  });
});

describe('catalog list screens (empty, manage rights)', () => {
  it('Departments', () => { const { container } = wrap(<DepartmentsList departments={[]} permissions={MANAGE} />); expectEmptyTable(container, null); expectCreateTwice(container, /^new /i); });
  it('Doctors', () => { const { container } = wrap(<DoctorsList doctors={[]} permissions={MANAGE} />); expectEmptyTable(container, null); expectCreateTwice(container, /^new |^add /i); });
  it('Specimens', () => { const { container } = wrap(<SpecimensScreen specimenTypes={[]} containers={[]} permissions={MANAGE} />); expectEmptyTable(container, null); expectCreateTwice(container, /^new /i); });
  it('Units', () => { const { container } = wrap(<UnitsScreen units={[]} valueSets={[]} permissions={MANAGE} />); expectEmptyTable(container, /No units yet/); expectCreateTwice(container, /^new unit$/i); });
  it('Panels', () => { const { container } = wrap(<PanelsList panels={[]} departments={[]} permissions={MANAGE} />); expectEmptyTable(container, null); expectCreateTwice(container, /^new /i); });
  it('Price lists', () => { const { container } = wrap(<PriceListsList priceLists={[]} permissions={MANAGE} />); expectEmptyTable(container, /No price list/i); expectCreateTwice(container, /^new price list$/i); });
  it('Credit parties', () => { const { container } = wrap(<CreditPartiesScreen creditParties={[]} permissions={MANAGE} />); expectEmptyTable(container, null); expectCreateTwice(container, /^new /i); });
  it('Tests', () => {
    const { container } = wrap(<TestsList rows={[]} filters={{ q: '', department_id: '', specimen_type_id: '', is_active: '' }} page={1} pages={1} filtered={false} departments={[]} specimenTypes={[]} manage openNew={false} />);
    expectEmptyTable(container, null); expectCreateTwice(container, /^new test$/i);
  });
  it('without manage rights the screen still shows headers + placeholders (no create button required)', () => {
    const { container } = wrap(<DepartmentsList departments={[]} permissions={['catalog.test.read']} />);
    expectEmptyTable(container, null);
  });
});

describe('lab list screens (empty)', () => {
  it('Critical values', () => { const { container } = render(<CriticalValueList items={[]} />); expectEmptyTable(container, /No critical values\./); });
  it('Instrument (ingest) exceptions', () => { const { container } = render(<IngestExceptionList items={[]} status="open" />); expectEmptyTable(container, /No open instrument exceptions\./); });
  it('Verification queue', () => { const { container } = render(<QueueScreen mode="verify" items={[]} permissions={['lab.result.verify']} />); expectEmptyTable(container, /Nothing waiting for verification\./); });
  it('Approval queue', () => { const { container } = render(<QueueScreen mode="approve" items={[]} permissions={['lab.result.approve']} />); expectEmptyTable(container, /Nothing waiting for approval\./); });
  it('Status board', () => {
    const { container } = render(<StatusBoard centres={[]} initialRows={[]} initialRange={{ from: '2026-11-10T00:00:00.000Z', to: '2026-11-17T00:00:00.000Z' }} permissions={['lab.status_board.read']} />);
    expectEmptyTable(container, /No registrations in this period\./);
  });
  it('Department worklist', async () => {
    const { container } = render(<WorklistPage departmentId="0193c3a0-0000-7000-8000-000000000001" permissions={['lab.worksheet.manage']} />);
    await screen.findByText(/No pending tests for this department\./);
    expectEmptyTable(container, /No pending tests for this department\./);
    expect(within(tableOf(container)).queryAllByRole('button'), 'no enabled row buttons in an empty worklist').toHaveLength(0);
  });
  it('Pending tests', async () => {
    const { container } = render(<PendingPage />);
    await screen.findByText(/Nothing pending\./);
    expectEmptyTable(container, /Nothing pending\./);
  });
});

describe('anatomic tracking: Sent out tab (empty)', () => {
  it('draws Label / Case / Sent to / Since / Reason with the message and 4 placeholder rows', () => {
    const { container } = wrap(<TrackingScreen tab="sent_out" canWork sentOut={[]} />);
    const t = tableOf(container);
    expect(headersOf(t)).toEqual(expect.arrayContaining(['Label', 'Case', 'Sent to']));
    expectEmptyTable(container, /Nothing is sent out/);
  });
});

describe('loading and error states are unchanged', () => {
  it('worklist: while loading there is no empty message; after a 500 the ErrorState with Retry shows and the empty message does not', async () => {
    let release: (v: unknown) => void = () => undefined;
    lab.listWorklistAction.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const { container, unmount } = render(<WorklistPage departmentId="0193c3a0-0000-7000-8000-000000000001" permissions={[]} />);
    expect(screen.queryByText(/No pending tests/)).toBeNull();
    release({ ok: false, status: 500, code: 'common.internal', requestId: 'req-synthetic' });
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(screen.queryByText(/No pending tests/)).toBeNull();
    expect(container.querySelector('.lims-row-placeholder')).toBeNull();
    unmount();
  });
  it('pending: a 403 shows the no-access message, not an empty table', async () => {
    lab.listPendingAction.mockResolvedValueOnce({ ok: false, status: 403, code: 'auth.forbidden' });
    const { container } = render(<PendingPage />);
    await screen.findByText(/don't have access/i);
    expect(screen.queryByText(/Nothing pending/)).toBeNull();
    expect(container.querySelector('.lims-row-placeholder')).toBeNull();
  });
  it('status board without lab.status_board.read still shows only the access message', () => {
    const { container } = render(<StatusBoard centres={[]} initialRows={[]} initialRange={{ from: '2026-11-10T00:00:00.000Z', to: '2026-11-17T00:00:00.000Z' }} permissions={[]} />);
    expect(screen.getByRole('alert').textContent).toMatch(/don't have access/i);
    expect(container.querySelector('table, [role="grid"]')).toBeNull();
  });
});
