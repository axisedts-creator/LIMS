// AN-T15b test fixtures (tester). SYNTHETIC data only. Not a test file.
// Shapes follow 02-TRD §10.2 step 6a (analytics.report render data). Own copies: the writer's bundled sample fixture is not read here.
export const NOT_STATUTORY = 'Internal MIS — not a statutory register';
export type Col = { key: string; label: string; kind: 'text' | 'count' | 'paisa' | 'seconds' | 'bp' };
export type Row = Record<string, string | number>;
export type ReportData = {
  tenantDisplayName: string; reportTitle: string; periodLabelAd: string; periodLabelBs: string; scopeLabel: string; generatedAtLocal: string;
  exportId: string; exportedBy: string; freshnessNote: string; notStatutoryNote: string; columns: Col[]; rows: Row[];
};

export const COLUMNS: Col[] = [
  { key: 'department', label: 'Department', kind: 'text' }, { key: 'tests', label: 'Tests', kind: 'count' },
  { key: 'income_paisa', label: 'Income', kind: 'paisa' }, { key: 'avg_tat', label: 'Avg TAT', kind: 'seconds' }, { key: 'share_bp', label: 'Share', kind: 'bp' },
];
export const FORMULA = `'=HYPERLINK("http://x","click")`;   // what neutraliseFormula leaves behind: a leading apostrophe, shown literally
export const ROWS: Row[] = [
  { department: 'Biochemistry', tests: 42, income_paisa: 123456789, avg_tat: 2520, share_bp: 1234 },
  { department: 'Haematology', tests: 7, income_paisa: -5000, avg_tat: 18720, share_bp: 7 },
  { department: FORMULA, tests: 0, income_paisa: 0, avg_tat: 273600, share_bp: 10000 },
];
/** Expected rendered cells of ROWS (string = exact text, RegExp = allows an optional currency prefix, which the spec does not fix). */
const CUR = '(?:Rs\\.?\\s?|NPR\\s?)?';
export const EXPECTED_CELLS: (string | RegExp)[][] = [
  ['Biochemistry', '42', new RegExp(`^${CUR}12,34,567\\.89$`), '42 min', '12.3%'],
  ['Haematology', '7', new RegExp(`^(?:-${CUR}|${CUR}-)50\\.00$`), '5 h 12 min', '0.1%'],
  [FORMULA, '0', new RegExp(`^${CUR}0\\.00$`), '3 d 4 h', '100.0%'],
];

export const REPORT: ReportData = {
  tenantDisplayName: 'Synthetic Test Lab', reportTitle: 'Department income', periodLabelAd: '01/11/2026 – 30/11/2026',
  periodLabelBs: '2083-07-15 – 2083-08-14 B.S.', scopeLabel: 'Centre Alpha, Centre Beta', generatedAtLocal: '2026-11-10 09:15',
  exportId: '018f0000-0000-7000-8000-0000000000e1', exportedBy: 'Exported by Synthetic Analyst', freshnessNote: 'Updated 2026-11-10 09:10',
  notStatutoryNote: NOT_STATUTORY, columns: COLUMNS, rows: ROWS,
};
export const META_KEYS = ['tenantDisplayName', 'reportTitle', 'periodLabelAd', 'periodLabelBs', 'scopeLabel', 'generatedAtLocal', 'exportId', 'exportedBy', 'freshnessNote', 'notStatutoryNote'] as const;

export const clone = <T,>(v: T): T => structuredClone(v);
export const deepFreeze = <T,>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
export const withRows = (n: number, cols: Col[] = COLUMNS): ReportData => ({
  ...clone(REPORT), columns: clone(cols),
  rows: Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map((c) => [c.key,
    c.kind === 'text' ? `Dept ${String(i).padStart(4, '0')}` : c.kind === 'seconds' ? 60 + i : c.kind === 'bp' ? i % 10001 : i * 100]))),
});
export const wideColumns = (n = 40): Col[] => Array.from({ length: n }, (_, i) => ({ key: `c${String(i + 1).padStart(2, '0')}`, label: `H${String(i + 1).padStart(2, '0')}`, kind: 'count' as const }));
const without = (k: string): Record<string, unknown> => { const d: Record<string, unknown> = clone(REPORT); delete d[k]; return d; };
const one = (kind: Col['kind'], rows: unknown[]) => ({ ...clone(REPORT), columns: [{ key: 'a', label: 'A', kind }], rows });

/** Schema-violating variants of REPORT (02-TRD §10.2 step 6a): every one must be rejected by the analytics.report schema. */
export const INVALID: [string, unknown][] = [
  ['extra top-level property', { ...clone(REPORT), results: 'Hb 9.1' }],
  ...[...META_KEYS, 'columns', 'rows'].map((k): [string, unknown] => [`missing ${k}`, without(k)]),
  ['reportTitle 201 chars', { ...clone(REPORT), reportTitle: 'x'.repeat(201) }],
  ['column label 201 chars', { ...clone(REPORT), columns: [{ key: 'a', label: 'x'.repeat(201), kind: 'text' }], rows: [] }],
  ['row text 201 chars', one('text', [{ a: 'x'.repeat(201) }])],
  ['column key uppercase', { ...clone(REPORT), columns: [{ key: 'Dept', label: 'A', kind: 'text' }], rows: [] }],
  ['column key with dash', { ...clone(REPORT), columns: [{ key: 'a-b', label: 'A', kind: 'text' }], rows: [] }],
  ['column key 41 chars', { ...clone(REPORT), columns: [{ key: 'a'.repeat(41), label: 'A', kind: 'text' }], rows: [] }],
  ['column kind unknown', { ...clone(REPORT), columns: [{ key: 'a', label: 'A', kind: 'money' }], rows: [] }],
  ['column extra property', { ...clone(REPORT), columns: [{ key: 'a', label: 'A', kind: 'text', width: 5 }], rows: [] }],
  ['0 columns', { ...clone(REPORT), columns: [], rows: [] }],
  ['41 columns', { ...clone(REPORT), columns: wideColumns(41), rows: [] }],
  ['5,001 rows', one('count', Array.from({ length: 5001 }, (_, i) => ({ a: i })))],
  ['row value boolean', one('count', [{ a: true }])],
  ['row value float', one('paisa', [{ a: 1.5 }])],
  ['row value null', one('text', [{ a: null }])],
  ['rows not an array', { ...clone(REPORT), rows: { a: 1 } }],
];
