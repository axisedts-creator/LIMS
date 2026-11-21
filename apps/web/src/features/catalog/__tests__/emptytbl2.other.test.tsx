// @vitest-environment jsdom
// T0D-EMPTYTBL-2 — engagement AppAccess, instruments InstrumentMappings, lab WorksheetListPage, quality LjView, smartreport LibraryList draw their column
// headers with no data (LD-310, LD-336). Contract = emptytbl2.helpers.ts. Loading and error states of WorksheetListPage stay as they are.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectCreateTwice, expectEmptyTable, expectNoCardOutsideTables, headersOf, placeholders, tableOf, tablesOf } from './emptytbl2.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/x',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ listWorksheetsAction: vi.fn(), createVersionAction: vi.fn() }));
vi.mock('@/features/lab/server/worklist.actions', () => ({ listWorksheetsAction: m.listWorksheetsAction }));
vi.mock('@/features/instruments/server/actions', async () => (await import('./emptytbl2.helpers')).stubModuleFactory());
vi.mock('@/features/quality/server/actions', async () => (await import('./emptytbl2.helpers')).stubModuleFactory());
vi.mock('@/features/smartreport/server/actions', async () => ({ ...(await import('./emptytbl2.helpers')).stubModuleFactory(), createVersionAction: m.createVersionAction }));

import { AppAccess, type AppAccessProps, type AppLink } from '@/features/engagement/components/AppAccess';
import { InstrumentMappings } from '@/features/instruments/components/InstrumentMappings';
import { CODE_MAP_MANAGE } from '@/features/instruments/server/codeMaps';
import { WorksheetListPage } from '@/features/lab/components/worksheets/WorksheetListPage';
import { LjView } from '@/features/quality/components/LjView';
import { LibraryList } from '@/features/smartreport/components/LibraryList';
import type { LjChart } from '@/features/quality/types';

beforeEach(() => { m.listWorksheetsAction.mockResolvedValue({ ok: true, data: { data: [], page: {} } }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const wrap = (el: ReactElement) => render(<ToastProvider>{el}</ToastProvider>);

describe('engagement AppAccess (empty)', () => {
  const props: AppAccessProps = {
    patient: { id: 'p1', display_name: 'Synthetic Patient' }, links: [], codes: [], recordPhoneMasked: null, consent: { version: '1', text: 'Synthetic consent.' }, labName: 'Synthetic Lab',
    actions: { issue: vi.fn(), revokeLink: vi.fn(), revokeCode: vi.fn(), refresh: vi.fn() },
  };
  it('no links and no codes: BOTH tables keep their headers, each with a message row and 4 placeholder rows', () => {
    const { container } = wrap(<AppAccess {...props} />);
    const tables = tablesOf(container);
    expect(tables, 'App accounts linked + Codes').toHaveLength(2);
    expectEmptyTable(tables[0]!, null, ['Phone', 'Relationship', 'Method', 'Status', 'Since']);
    expectEmptyTable(tables[1]!, null, ['Issued', 'Expires', 'Status']);
    expect(placeholders(container)).toHaveLength(8);
    expectNoCardOutsideTables(container);
  });
  it('the existing wording stays on the page: "This patient has no app access"', () => {
    const { container } = wrap(<AppAccess {...props} />);
    expect(container.textContent).toMatch(/This patient has no app access/);
  });
  it('"Issue app code" stays above the tables and is repeated inside the empty table', () => {
    const { container } = wrap(<AppAccess {...props} />);
    const tables = tablesOf(container);
    const inTables = tables.flatMap((t) => within(t).queryAllByRole('button', { name: /^issue app code$/i }));
    const all = within(container).getAllByRole('button', { name: /^issue app code$/i });
    expect(inTables.length, 'repeated in a message row').toBeGreaterThanOrEqual(1);
    expect(all.length - inTables.length, 'page-level button stays').toBeGreaterThanOrEqual(1);
  });
  it('a link but no codes: the links table has its row and no placeholders; the codes table is the empty one', () => {
    const link: AppLink = { profile_id: 'pr1', link_id: 'l1', patient_id: 'p1', display_name: 'Synthetic Patient', relationship: 'self', method: 'link_code', status: 'active', account_phone_masked: '+977•••••12' };
    const { container } = wrap(<AppAccess {...props} links={[link]} />);
    const [links, codes] = tablesOf(container);
    expect(placeholders(links!)).toHaveLength(0);
    expect(links!.textContent).toMatch(/\+977/);
    expectEmptyTable(codes!, null, ['Issued', 'Expires', 'Status']);
  });
});

describe('instruments InstrumentMappings (empty)', () => {
  const props = { instrument: { id: 'i1', instrument_code: 'INS-1', display_name: 'Synthetic analyser' }, observed: [], maps: [], tests: {}, instruments: [] } as const;
  it('manager: Observed codes and Mappings both keep their headers, message rows and 4 placeholder rows each', () => {
    const { container } = wrap(<InstrumentMappings {...props} permissions={[CODE_MAP_MANAGE]} />);
    const tables = tablesOf(container);
    expect(tables).toHaveLength(2);
    expectEmptyTable(tables[0]!, /No codes seen yet/, ['Code', 'Class', 'Seen count', 'Last seen', 'Mapping status']);
    expectEmptyTable(tables[1]!, /No mappings yet\./, ['Direction', 'Instrument code', 'Test', 'Analyte', 'Unit conversion', 'Flag map count', 'Active']);
    expect(placeholders(container)).toHaveLength(8);
    expectNoCardOutsideTables(container);
  });
  it('manager: "Add mapping" stays in the page header and is repeated in the Mappings message row', () => {
    const { container } = wrap(<InstrumentMappings {...props} permissions={[CODE_MAP_MANAGE]} />);
    expectCreateTwice(container, tableOf(container, 1), /^add mapping$/i);
  });
  it('without the manage right: only Observed codes is a table (headers, message, placeholders); the Mappings notice and no Add mapping stay', () => {
    const { container } = wrap(<InstrumentMappings {...props} permissions={[]} />);
    const tables = tablesOf(container);
    expect(tables).toHaveLength(1);
    expectEmptyTable(tables[0]!, /No codes seen yet/, ['Code', 'Class', 'Seen count']);
    expect(container.textContent).toMatch(/Mappings are visible to users who can manage them/);
    expect(within(container).queryAllByRole('button', { name: /add mapping|copy from instrument/i })).toHaveLength(0);
  });
  it('observed codes with a mapped one only ("Unmapped only" on by default) still show the table headers', () => {
    const observed = [{ record_class: 'patient', instrument_analyte_code: 'GLU', seen_count: 4, last_seen_at: '2026-11-17T01:00:00.000Z', last_mapping_status: 'mapped' }];
    const { container } = wrap(<InstrumentMappings {...props} observed={observed as never} permissions={[CODE_MAP_MANAGE]} />);
    expect(headersOf(tablesOf(container)[0]!)).toEqual(expect.arrayContaining(['Code', 'Class', 'Seen count']));
  });
});

describe('lab WorksheetListPage (empty)', () => {
  it('no worksheets: Title / Created / Rows headers, "No worksheets." row, 4 placeholder rows, no card', async () => {
    const { container } = render(<WorksheetListPage />);
    await screen.findByText(/No worksheets\./);
    expectEmptyTable(tableOf(container), /No worksheets\./, ['Title', 'Created', 'Rows']);
    expectNoCardOutsideTables(container);
    expect(within(tableOf(container)).queryAllByRole('link'), 'no links in an empty list').toHaveLength(0);
  });
  it('while loading: the status line only, no table, no message, no placeholders', () => {
    m.listWorksheetsAction.mockReturnValue(new Promise(() => undefined));
    const { container } = render(<WorksheetListPage />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading/);
    expect(container.querySelector('.lims-row-placeholder')).toBeNull();
    expect(screen.queryByText(/No worksheets/)).toBeNull();
  });
  it('after a failure: the error with Retry inside the table, no empty message', async () => {
    m.listWorksheetsAction.mockResolvedValue({ ok: false, status: 500, code: 'common.internal', requestId: 'req-synthetic' });
    render(<WorksheetListPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(screen.queryByText(/No worksheets/)).toBeNull();
  });
  it('with a worksheet: the row links to the print view and there are no placeholder rows', async () => {
    m.listWorksheetsAction.mockResolvedValue({ ok: true, data: { data: [{ id: 'w1', title: 'Morning run', created_at: '2026-11-17T01:00:00.000Z', row_count: 12 }], page: {} } });
    const { container } = render(<WorksheetListPage />);
    await screen.findByRole('link', { name: 'Morning run' });
    expect(placeholders(tableOf(container))).toHaveLength(0);
    expect(screen.queryByText(/No worksheets/)).toBeNull();
  });
});

describe('quality LjView (chart with no values)', () => {
  const chart = (series: LjChart['series']): LjChart => ({ plan: { id: 'pl1', instrument_id: 'i1', analyte_id: 'a1', analyte_code: 'GLU', decimals: 2 }, view: 'level', truncated: false, series });
  const view = (series: LjChart['series']) => wrap(<LjView sp={{ plan_id: 'pl1' }} plans={[]} chart={chart(series)} generatedAt="2026-11-17T00:00:00.000Z" canManage={false} exclusionOptions={[]} />);
  it('no series in the period: the points table keeps Time / Value / z / Status / Rule hits, with the message row and 4 placeholder rows', () => {
    const { container } = view([]);
    expectEmptyTable(tableOf(container), /No QC values in this period\./, ['Time', 'Value', 'z', 'Status', 'Rule hits']);
    expectNoCardOutsideTables(container);
  });
  it('the heading and the legend stay', () => {
    view([]);
    expect(screen.getByRole('heading', { name: /Levey-Jennings chart · GLU/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: /legend/i })).toBeTruthy();
    expect(screen.queryByText(/Chart component pending/)).toBeNull(); // LD-353 rule 8, T0D-UIDASH-1
  });
  it('a series with points: its table has the points and no placeholder rows, and the message is gone', () => {
    const point = { observation_id: 'o1', observed_at: '2026-11-16T05:00:00.000Z', value: '5.10', z: '0.5', status: 'accepted', rule_hits: [] };
    const { container } = view([{ level_id: 'l1', level_code: 'L1', lot_id: 'lot1', lot_no: 'LOT-9', points: [point as never], targets: [] }]);
    expect(placeholders(container)).toHaveLength(0);
    expect(container.textContent).not.toMatch(/No QC values in this period/);
  });
});

describe('smartreport LibraryList (empty)', () => {
  it('no library: Version / Status / Language / Approved by / Approved on / Updated / Actions headers, message row, 4 placeholder rows', () => {
    const { container } = wrap(<LibraryList rows={[]} />);
    expectEmptyTable(tableOf(container), /No library yet\. Start from the starter draft\./, ['Version', 'Status', 'Language', 'Approved by', 'Approved on', 'Updated', 'Actions']);
    expectNoCardOutsideTables(container);
  });
  it('"New draft" stays in the page header; "Start from the starter draft" moves into the message row', () => {
    const { container } = wrap(<LibraryList rows={[]} />);
    const t = tableOf(container);
    expect(within(t).getByRole('button', { name: /^start from the starter draft$/i })).toBeTruthy();
    const header = within(container).getAllByRole('button', { name: /^new draft$/i });
    expect(header.some((b) => !t.contains(b))).toBe(true);
  });
  it('pressing "Start from the starter draft" in the row creates the starter draft once, with an idempotency key', async () => {
    m.createVersionAction.mockResolvedValue({ ok: false, status: 500, code: 'common.internal' });
    const { container } = wrap(<LibraryList rows={[]} />);
    await userEvent.setup().click(within(tableOf(container)).getByRole('button', { name: /^start from the starter draft$/i }));
    await waitFor(() => expect(m.createVersionAction).toHaveBeenCalledTimes(1));
    expect(m.createVersionAction.mock.calls[0]![0]).toEqual({ source: 'starter' });
    expect(typeof m.createVersionAction.mock.calls[0]![1]).toBe('string');
  });
  it('with a version: the row shows, no message, no placeholder rows', () => {
    const row = { id: 'v1', version_no: 1, status: 'approved', language: 'en', updated_at: '2026-11-16T05:00:00.000Z' };
    const { container } = wrap(<LibraryList rows={[row as never]} />);
    expect(placeholders(tableOf(container))).toHaveLength(0);
    expect(container.textContent).not.toMatch(/No library yet/);
  });
});
