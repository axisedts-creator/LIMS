// @vitest-environment jsdom
// T0D-UILIST-3 (1) catalog masters — LD-353 template 1 LIST (rules 2, 5, 6, 8). Every screen is rendered with fake synthetic data twice: no rows and one row.
// Contract per screen: h1 = the ElabAssist menu label (read from the generated nav manifest); exactly one FilterBar (Imports: at most one) holding
// plain kit controls in ONE row (no radio group: it is taller than the other controls, rule 2); the table header row always present and inside
// `.lims-table-scroll`; a cut off text cell carries its full text as `title` (rule 5); no "!" and no development notes (rule 8).
// Fails today because: the catalog tables are bare <table>s outside `.lims-table-scroll`; credit parties, price lists, surcharges and tax have no
// FilterBar; panels has two, imports has two; status/kind filters are radio groups; the raw-table screens have no title on cut off cells.
// Not here (other tasks own them, brief): price list detail + version editor + price tools (T0D-PRICETOOLS-1), tests list / test details / categories /
// popular (T0D-TESTMGMT-1), doctors verify queue and doctor detail (T0D-SALES-1 / T0D-PARTYSET-1 neighbours), catalog home (not in done_when).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectListScreen, filterBars, norm } from '@/features/catalog/__tests__/uilist3.helpers';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/catalog',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => '/catalog' }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { has: (_t, k) => typeof k !== 'symbol', get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }) }));
vi.mock('@/features/catalog/server/actions', stub);
vi.mock('@/features/catalog/server/catalogActions', stub);
vi.mock('@/features/catalog/server/testMgmtActions', stub);
vi.mock('@/features/catalog/server/pricingActions', stub);
vi.mock('@/features/catalog/server/importActions', stub);

import { DepartmentsList } from '@/features/catalog/components/DepartmentsList';
import { SpecimensScreen } from '@/features/catalog/components/SpecimensScreen';
import { MethodsList } from '@/features/catalog/components/MethodsList';
import { UnitsScreen } from '@/features/catalog/components/UnitsScreen';
import { PanelsList } from '@/features/catalog/components/PanelsList';
import { CommentCodesScreen } from '@/features/catalog/components/CommentCodesScreen';
import { DoctorsList } from '@/features/catalog/components/DoctorsList';
import { CreditPartiesScreen } from '@/features/catalog/components/CreditPartiesScreen';
import { ImportsScreen } from '@/features/catalog/components/ImportsScreen';
import { PriceListsList } from '@/features/catalog/components/PriceListsList';
import { SurchargeRulesScreen } from '@/features/catalog/components/SurchargeRulesScreen';
import { TaxScreen } from '@/features/catalog/components/TaxScreen';

afterEach(cleanup);
const wrap = (el: React.ReactElement) => render(<ToastProvider>{el}</ToastProvider>);

const MANAGE = ['catalog.test.read', 'catalog.test.manage', 'catalog.referrer.read', 'catalog.referrer.manage', 'catalog.price_list.read', 'catalog.price_list.manage'];
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
/** 70 characters: far past any sensible column width, so the cell is cut off and must carry its full text as a title. */
const LONG = 'Synthetic long label that is wider than any sensible column width 0123';
const base = (n: number, o: Record<string, unknown>) => ({ id: ID(n), is_active: true, version: 2, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-06T09:30:00.000Z', ...o });

const DEPT = (name = 'Hematology') => base(1, { code: 'HAEM', name, report_order: 10, report_heading: 'HAEMATOLOGY' });
const PLIST = (name = 'Default list') => ({ id: ID(71), code: 'DEFAULT', name, owner_kind: 'default', falls_through: false, assignments: [], is_active: true, version: 1, current_version: { id: ID(72), version_no: 1, effective_from: '2026-01-01T00:00:00.000Z' } });
const IMPORT = (file = 'synthetic-masters.xlsx') => ({ id: ID(81), kind: 'catalog_master', status: 'validated', file_name: file, file_sha256: 'a'.repeat(64), summary: { rows: 4, added: 2, changed: 1, removed: 0, unchanged: 1, errors: 0, warnings: 1 }, expires_at: '2026-12-01T00:00:00.000Z', created_at: '2026-11-05T04:15:00.000Z', created_by: ID(99), version: 1 });
const EXPORT = () => ({ id: ID(82), kind: 'catalog_master', status: 'ready', file_name: 'synthetic-export.xlsx', byte_size: 20480, expires_at: '2026-12-01T00:00:00.000Z', version: 1 });

interface Screen {
  name: string;
  path: string;
  headers: string[];
  /** Imports holds two tables; one shared FilterBar at most. Everything else: exactly one. */
  filterBar?: 1 | 'optional';
  mount: (rows: boolean) => ReturnType<typeof wrap>;
  /** Full text of the cell that one-row mounting makes too long; the cell (or its link) must carry it as title. */
  long: string;
  /** The identifier text that proves the row was drawn. */
  marker: string;
}

const SCREENS: Screen[] = [
  { name: 'departments', path: '/catalog/departments', headers: ['Code', 'Name', 'Report order', 'Report heading', 'Status', 'Updated'], long: LONG, marker: 'HAEM',
    mount: (r) => wrap(<DepartmentsList departments={(r ? [DEPT(LONG)] : []) as never} permissions={MANAGE} />) },
  { name: 'specimens', path: '/catalog/specimens', headers: ['Code', 'Name', 'Report label', 'Status'], long: LONG, marker: 'EDTA_WB',
    mount: (r) => wrap(<SpecimensScreen specimenTypes={(r ? [base(11, { code: 'EDTA_WB', name: LONG, report_label: 'EDTA WHOLE BLOOD' })] : []) as never} containers={[]} permissions={MANAGE} />) },
  { name: 'methods', path: '/catalog/methods', headers: ['Code', 'Name', 'Status', 'Updated'], long: LONG, marker: 'PCR',
    mount: (r) => wrap(<MethodsList methods={(r ? [base(21, { code: 'PCR', name: LONG })] : []) as never} permissions={MANAGE} />) },
  { name: 'units', path: '/catalog/units', headers: ['Code', 'Display', 'Scope', 'Status'], long: LONG, marker: 'lab_ratio',
    mount: (r) => wrap(<UnitsScreen units={(r ? [base(31, { code: 'lab_ratio', display: LONG, scope: 'tenant' })] : []) as never} valueSets={[]} permissions={MANAGE} />) },
  { name: 'panels', path: '/catalog/panels', headers: ['Code', 'Name', 'Kind', 'Sex restriction', 'Members', 'Status'], long: LONG, marker: 'CBC',
    mount: (r) => wrap(<PanelsList panels={(r ? [base(41, { kind: 'panel', code: 'CBC', name: LONG, panel_kind: 'clinical', is_orderable: true, revision: 1, members: [] })] : []) as never} departments={[DEPT()] as never} permissions={MANAGE} />) },
  { name: 'comment codes', path: '/catalog/comment-codes', headers: ['Code', 'Department', 'Text', 'Status', 'Version'], long: LONG, marker: 'NORMAL',
    mount: (r) => wrap(<CommentCodesScreen commentCodes={(r ? [base(51, { code: 'NORMAL', text: LONG })] : []) as never} departments={[DEPT()] as never} permissions={MANAGE} />) },
  { name: 'doctors', path: '/catalog/doctors', headers: ['Code', 'Name', 'Qualification', 'Verified', 'Status'], long: LONG, marker: 'DR001',
    mount: (r) => wrap(<DoctorsList doctors={(r ? [{ id: ID(61), doctor_code: 'DR001', display_name: LONG, qualification: 'MD', is_verified: true, is_active: true }] : []) as never} permissions={MANAGE} />) },
  { name: 'credit parties', path: '/catalog/credit-parties', headers: ['Code', 'Name', 'Kind', 'Credit allowed', 'Price list', 'Status'], long: LONG, marker: 'HOSP1',
    mount: (r) => wrap(<CreditPartiesScreen creditParties={(r ? [base(71, { party_code: 'HOSP1', name: LONG, kind: 'hospital', allows_credit: true })] : []) as never} permissions={MANAGE} />) },
  { name: 'imports', path: '/catalog/imports', headers: ['Started', 'Kind', 'Target', 'File name', 'Status', 'Errors / Warnings', 'By'], filterBar: 'optional', long: LONG + '.xlsx', marker: 'Synthetic',
    mount: (r) => wrap(<ImportsScreen imports={(r ? [IMPORT(LONG + '.xlsx')] : []) as never} exports={(r ? [EXPORT()] : []) as never} priceLists={[]} permissions={MANAGE} />) },
  { name: 'price lists', path: '/catalog/price-lists', headers: ['Code', 'Name', 'Applies to', 'Assigned to', 'Current version', 'Scheduled', 'Draft', 'Status'], long: LONG, marker: 'DEFAULT',
    mount: (r) => wrap(<PriceListsList priceLists={(r ? [PLIST(LONG)] : []) as never} permissions={MANAGE} />) },
  { name: 'surcharges', path: '/catalog/surcharges', headers: ['Applies to', 'Price list', 'Amount', 'Effective from', 'Effective to', 'Status'], long: LONG, marker: 'All tests',
    mount: (r) => wrap(<SurchargeRulesScreen rules={(r ? [{ id: ID(91), scope: 'all', price_list_id: ID(71), amount_kind: 'percent', percent_bp: 1000, effective_from: '2026-01-01T00:00:00.000Z', version: 1 }] : []) as never} departments={[]} orderables={[]} priceLists={[{ id: ID(71), code: 'DEFAULT', name: LONG }] as never} permissions={MANAGE} />) },
  { name: 'tax', path: '/catalog/tax', headers: ['Applies to', 'VAT', 'Other tax', 'HS code', 'Effective from', 'Effective to'], long: `Department ${LONG}`, marker: 'Department',
    mount: (r) => wrap(<TaxScreen rules={(r ? [{ id: ID(95), scope: 'department', department_id: ID(1), vat_treatment: 'taxable', effective_from: '2026-01-01T00:00:00.000Z', version: 1 }] : []) as never} taxTypes={[]} departments={[{ id: ID(1), name: LONG }] as never} orderables={[]} permissions={MANAGE} />) },
];

/** The cell (or the link / span inside it) whose text is exactly `full` must carry `full` as its title attribute (rule 5). */
function titledCell(root: ParentNode, full: string): boolean {
  const hits = [...root.querySelectorAll<HTMLElement>('tbody *, [role="gridcell"], [role="gridcell"] *')].filter((e) => norm(e.textContent) === full);
  return hits.some((e) => e.getAttribute('title') === full || e.closest('td, [role="gridcell"]')?.getAttribute('title') === full);
}

describe.each(SCREENS)('catalog $name — list template (no rows, one row)', (s) => {
  it('no rows: h1 = menu label, one FilterBar, table header row present in the kit scroll box', () => {
    const { container } = s.mount(false);
    expectListScreen(container, { path: s.path, headers: s.headers, filterBar: s.filterBar ?? 1 });
  });

  it('one row: same header, FilterBar and title; the row is drawn', () => {
    const { container } = s.mount(true);
    expectListScreen(container, { path: s.path, headers: s.headers, filterBar: s.filterBar ?? 1 });
    expect(norm(container.querySelector('tbody')?.textContent ?? container.textContent)).toContain(s.marker);
  });

  it('the filter bar is ONE row of plain controls: no radio group inside it and no bar inside a bar', () => {
    const { container } = s.mount(true);
    const bars = filterBars(container);
    expect(bars.length, 'the screen has a FilterBar').toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.querySelector('[role="radiogroup"]'), 'a radio group is taller than the other controls (rule 2): use a select').toBeNull();
      expect(bar.querySelector('.lims-filter-bar'), 'nested filter bar').toBeNull();
      expect(bar.querySelectorAll('input, select, button, [role="combobox"], [role="button"]').length, 'the bar holds controls').toBeGreaterThan(0);
    }
  });

  it('a cut off text cell carries its full text as title (rule 5)', () => {
    const { container } = s.mount(true);
    expect(titledCell(container, s.long), `a cell with the text "${s.long}" needs title="${s.long}"`).toBe(true);
  });
});
