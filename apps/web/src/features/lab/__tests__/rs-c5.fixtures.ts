// RS-C5 shared synthetic fixtures (no real patient data). Imported by the rs-c5.* tests only.
import { HttpResponse } from 'msw';

export const ORIGIN = 'http://api.test';
export const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const problem = (status: number, code: string, title = code) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });

export interface Call { method: string; url: URL; headers: Headers; body?: unknown }
export const calls: Call[] = [];
export const rec = async (r: Request) => {
  calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) });
};
export const sent = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url.pathname));

// ── receive / collect
export const CENTRE_A = id(2001);
export const CENTRES = [{ id: CENTRE_A, name: 'Synthetic Central Lab' }];
export const REASONS = [{ code: 'haemolysed', display: 'Haemolysed' }];
export const BC = (n: number) => `SYN${String(n).padStart(7, '0')}`;
export const specimen = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(5000 + n), version: 1, barcode: BC(n), order_id: id(4001), registration_no: 'REG2611050001', specimen_type_code: 'serum', container_code: 'sst',
  status: 'collected', priority: 'routine', centre_id: CENTRE_A, is_active: true, collection_barcode_unverified: false, label_print_count: 1,
  tests: [{ test_id: id(3000 + n), test_code: `TST${n}` }], ...o,
});

// ── worklist
export const DEPT = '0d1d1d1d-ac40-7000-8000-0000000000d1';
export const worklistItem = (n: number, o: Record<string, unknown> = {}) => ({
  order_test_id: id(0x100 + n), order_id: id(0x200 + n), specimen_id: id(0x300 + n), barcode: `E26000001${String(n).padStart(2, '0')}`, registration_no: `R26110500${String(n).padStart(2, '0')}`,
  patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '34Y/F', patient_code: `PC${n}` }, test_id: id(0x400), test_code: 'CBC', priority: 'routine', status: 'in_process',
  received_at: '2026-11-05T04:15:00.000Z', result_counts: { total: 3, resulted: 1, verified: 0 }, ...o,
});

// ── result grid (ResultDto subset the grid reads; ids: result n = id(n), analyte = id(100+n))
const CODE = ['', 'HB', 'WBC', 'TC', 'HDL', 'GLU'] as const;
export const res = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(n), version: 1, order_id: id(8888), order_item_id: id(10), specimen_id: id(3000 + n), test_id: id(4010), analyte_id: id(100 + n), analyte_code: CODE[n]!,
  status: 'pending', origin: 'manual', unit_code: 'g_dl', range_unavailable_age_unknown: false, critical: { is_critical: false },
  on_hold: false, qc_review_required: false, unit_mismatch: false, current_version_no: 0, delta: { status: 'none' }, instrument_flags: [], ...o,
});
export const analytes = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [id(100 + n), { name: ['', 'Hemoglobin', 'Leukocytes', 'Total cholesterol', 'High density chol.', 'Glucose'][n]!, decimals: 2, value_type: 'numeric' as const }]));
export const gridOf = (items: { code: string; results: Record<string, unknown>[] }[]) => ({
  order: { order_id: id(8888), registration_no: 'REG0042', specimens: [], order_tests: [] },
  items: items.map((it, i) => ({ order_item_id: id(10 * (i + 1)), test: { test_id: id(4010 + i), test_code: it.code }, results: it.results })),
});
/** CBC verified (HB manual, WBC from an instrument with a failed delta), LIPID resulted, GLU approved: one item per track state. */
export const threeStateGrid = () => gridOf([
  { code: 'CBC', results: [res(1, { status: 'verified', value_numeric: '13.50', flag: 'N' }), res(2, { status: 'verified', origin: 'instrument', value_numeric: '12.40', unit_code: 'g_dl', delta: { status: 'fail', prev_value: '10.0', abs: '2.4', pct: '24', prev_at: '2026-11-01T04:00:00.000Z' } })] },
  { code: 'LIPID', results: [res(3, { status: 'resulted', value_numeric: '4.10' }), res(4, { status: 'resulted', value_numeric: '1.20' })] },
  { code: 'GLU', results: [res(5, { status: 'approved', value_numeric: '5.10', current_version_no: 1 })] },
]);

/** Snapshot normaliser: react-aria / useId ids differ between runs; nothing else is touched. */
export const normalise = (root: HTMLElement) => root.innerHTML.replace(/react-aria[\w-]*:?[\w]*/g, 'ID').replace(/:r[0-9a-z]+:/g, 'ID').replace(/></g, '>\n<');
