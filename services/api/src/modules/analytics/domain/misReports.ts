// T0B-MISREPORTS-1 (LD-321, LD-325, LD-342 / A39, LD-346): the MIS reports of contracts/openapi/analytics.yaml x-report-definitions (T0C-MISREPORTS-1)
// that this task delivers, as frozen data. Pure: no I/O. [CONV] restated here (not parsed from the YAML at runtime, the worker imports this file too);
// misreports/registry.static.test.ts pins every field to the contract, so a drift fails the suite.
// LD-346 (1): consultant is volume only (no money column, sorted by tests_count desc). LD-346 (2): the two gated money reports are PENDING
// (PENDING_REPORT_CODES in reportRegistry.ts, an allow-listed file of the c8 CI word gate; no row here).
import type { ExportColumn, ExportKind } from '../export/layout.js';

export type MisParam = 'centre_id' | 'party_id' | 'representative_id' | 'referrer_id' | 'department_id' | 'collector_id' | 'min_repeat_count' | 'visit_type';
type ColType = 'string' | 'date' | 'datetime' | 'integer' | 'integer_paisa' | 'basis_points';
export interface MisColumn { readonly name: string; readonly type: ColType; readonly title: string }
export interface MisDef {
  readonly code: string;
  readonly title: string;
  readonly permission: 'analytics.dashboard.read' | 'analytics.collections.read';
  readonly params: readonly MisParam[]; // filters besides business_date_from / business_date_to
  readonly columns: readonly MisColumn[];
  readonly sort: { readonly column: string; readonly direction: 'asc' | 'desc' };
  readonly rowCap: number;
}

const KIND: Readonly<Record<ColType, ExportKind>> = { string: 'text', date: 'text', datetime: 'text', integer: 'count', integer_paisa: 'paisa', basis_points: 'bp' };
const S = (name: string, title: string): MisColumn => ({ name, type: 'string', title });
const D = (name: string, title: string): MisColumn => ({ name, type: 'date', title });
const DT = (name: string, title: string): MisColumn => ({ name, type: 'datetime', title });
const I = (name: string, title: string): MisColumn => ({ name, type: 'integer', title });
const P = (name: string, title: string): MisColumn => ({ name, type: 'integer_paisa', title });
const COLL = 'analytics.collections.read' as const;
const DASH = 'analytics.dashboard.read' as const;

const DEFS: MisDef[] = [
  {
    code: 'bill_of_the_day', title: 'Bill of the Day', permission: COLL, params: ['centre_id', 'party_id'],
    columns: [S('invoice_id', 'Invoice id'), S('invoice_number', 'Invoice number'), DT('billed_at', 'Billed at'), D('business_date', 'Business date'), S('centre_id', 'Centre'),
      S('party_id', 'Party'), P('gross_paisa', 'Gross'), P('discount_paisa', 'Discount'), P('net_paisa', 'Net'), P('paid_paisa', 'Paid'), P('due_paisa', 'Due')],
    sort: { column: 'billed_at', direction: 'desc' }, rowCap: 5000,
  },
  {
    code: 'sales_representative', title: 'Sales representative', permission: DASH, params: ['centre_id', 'representative_id', 'party_id'],
    columns: [S('representative_id', 'Representative'), S('representative_name', 'Representative name'), I('designation_level', 'Designation level'), I('parties_count', 'Parties'),
      I('orders_registered', 'Orders'), P('net_billed_paisa', 'Net billed'), P('collected_paisa', 'Collected')],
    sort: { column: 'net_billed_paisa', direction: 'desc' }, rowCap: 2000,
  },
  {
    code: 'consultant', title: 'Consultant', permission: DASH, params: ['centre_id', 'referrer_id', 'department_id'],
    columns: [S('referrer_id', 'Consultant'), S('referrer_name', 'Consultant name'), S('department_id', 'Department'), I('orders_registered', 'Orders'), I('tests_count', 'Tests')],
    sort: { column: 'tests_count', direction: 'desc' }, rowCap: 5000,
  },
  {
    code: 'collection_boy', title: 'Collection boy', permission: COLL, params: ['centre_id', 'collector_id'],
    columns: [S('collector_id', 'Collector'), S('collector_name', 'Collector name'), I('collections_count', 'Collections'), I('pickups_count', 'Pickups'),
      P('collected_paisa', 'Collected'), DT('last_activity_at', 'Last activity')],
    sort: { column: 'collected_paisa', direction: 'desc' }, rowCap: 2000,
  },
  {
    code: 'repeated_patient', title: 'Repeated patient', permission: DASH, params: ['centre_id', 'min_repeat_count'],
    columns: [S('patient_id', 'Patient id'), S('patient_number', 'Patient number'), I('visit_count', 'Visits'), D('first_visit_date', 'First visit'), D('last_visit_date', 'Last visit'),
      P('net_billed_paisa', 'Net billed')],
    sort: { column: 'visit_count', direction: 'desc' }, rowCap: 5000,
  },
  {
    code: 'repeated_test', title: 'Repeated test', permission: DASH, params: ['centre_id', 'department_id', 'min_repeat_count'],
    columns: [S('test_code', 'Test code'), S('test_name', 'Test'), S('department_id', 'Department'), I('test_count', 'Tests'), I('patients_count', 'Patients'),
      I('repeat_patients_count', 'Repeat patients')],
    sort: { column: 'test_count', direction: 'desc' }, rowCap: 5000,
  },
  {
    code: 'ipd_opd', title: 'IPD and OPD', permission: DASH, params: ['centre_id', 'visit_type', 'referrer_id', 'party_id'],
    columns: [D('business_date', 'Business date'), S('centre_id', 'Centre'), S('visit_type', 'Patient type'), I('orders_registered', 'Orders'), I('tests_count', 'Tests'),
      P('gross_paisa', 'Gross'), P('net_paisa', 'Net')],
    sort: { column: 'business_date', direction: 'desc' }, rowCap: 5000,
  },
  {
    code: 'party_billing', title: 'Party billing', permission: COLL, params: ['centre_id', 'party_id'],
    columns: [S('party_id', 'Party'), S('party_name', 'Party name'), S('billing_mode', 'Billing mode'), I('orders_registered', 'Orders'), P('gross_paisa', 'Gross'),
      P('discount_paisa', 'Discount'), P('net_billed_paisa', 'Net billed'), P('paid_paisa', 'Paid'), P('outstanding_paisa', 'Outstanding')],
    sort: { column: 'outstanding_paisa', direction: 'desc' }, rowCap: 5000,
  },
  {
    code: 'outsource', title: 'Outsource and inter lab transfer', permission: DASH, params: ['centre_id', 'department_id'],
    columns: [S('processing_branch_id', 'Processing lab'), S('processing_lab_name', 'Processing lab name'), S('department_id', 'Department'), I('tests_sent', 'Tests sent'),
      I('tests_resulted', 'Tests resulted')],
    sort: { column: 'tests_sent', direction: 'desc' }, rowCap: 5000,
  },
];

const freeze = (d: MisDef): MisDef => Object.freeze({ ...d, params: Object.freeze([...d.params]), columns: Object.freeze(d.columns.map((c) => Object.freeze(c))), sort: Object.freeze(d.sort) });
export const MIS_DEFS: Readonly<Record<string, MisDef>> = Object.freeze(Object.fromEntries(DEFS.map((d) => [d.code, freeze(d)])));
/** The delivered MIS codes, contract order. */
export const MIS_REPORT_CODES: readonly string[] = Object.freeze(DEFS.map((d) => d.code));
export const isMisReport = (code: unknown): boolean => typeof code === 'string' && Object.hasOwn(MIS_DEFS, code);
export const misColumns = (d: MisDef): ExportColumn[] => d.columns.map((c) => ({ key: c.name, label: c.title, kind: KIND[c.type] }));
