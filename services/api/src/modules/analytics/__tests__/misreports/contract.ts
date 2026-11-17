// T0B-MISREPORTS-1 (LD-321, LD-325, LD-342 / A39): the 11 report definitions of contracts/openapi/analytics.yaml (root x-report-definitions, T0C-MISREPORTS-1).
// Not a test file. Everything the tests pin about a report (columns, permission, flag, row cap) is READ from the contract, never retyped.
import { DOCS } from '../probes/spec.js';

export interface ReportDefinition {
  code: string; title: string; description: string; permission: string; flag?: string; params: string[];
  columns: { name: string; type: string; title: string }[]; default_sort: { column: string; direction: 'asc' | 'desc' };
  row_cap: number; exportable: boolean; schedulable: boolean; example_params: Record<string, any>;
}
export const DEFS: readonly ReportDefinition[] = DOCS.analytics['x-report-definitions'];
export const NEW_CODES: readonly string[] = DEFS.map((d) => d.code);
/** LD-342 / A39: the only two codes that may carry the word and money about a party's rate (gate: flag + analytics.referral_report.read + aal2). */
export const MONEY_CODES = ['two_level_commission', 'tds'] as const;
export const PLAIN_CODES: readonly string[] = NEW_CODES.filter((c) => !(MONEY_CODES as readonly string[]).includes(c));
export const def = (code: string): ReportDefinition => DEFS.find((d) => d.code === code) ?? (() => { throw new Error(`no definition ${code}`); })();

/** The 14 codes of the g_cs_report_codes seed that exist before this task, in table order (domain/reportRegistry.ts). */
export const OLD_CODES = ['dashboard', 'income', 'department_income', 'collections', 'volume', 'top_referrers', 'top_centres', 'referral_incentive',
  'tests_done', 'tat', 'pending_tests', 'quality_indicators', 'delivery', 'interfaces'] as const;

/** contract column type -> ExportKind of export/layout.ts (what buildReport / runMisReport return in `columns[].kind`). */
export const KIND: Record<string, string> = { string: 'text', date: 'text', datetime: 'text', integer: 'count', integer_paisa: 'paisa', basis_points: 'bp' };
export const expectedColumns = (code: string) => def(code).columns.map((c) => ({ key: c.name, label: c.title, kind: KIND[c.type]! }));
