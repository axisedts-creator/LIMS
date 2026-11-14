// C11.T-22 shared harness (tester-owned; not a test file). Re-uses the T-19 MSW server + session/router mocks (via t20.harness) and adds assay / batch / molecular fixtures and default handlers.
// Each test file registers the same three mocks as T-19/T-20 (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock)
// and call `beforeEach(() => api.use(...t22Defaults))` (api.resetHandlers() in afterEach removes them again).
// CONTRACT PINNED BY THE T-22 TESTS (writer: make these exist; names are mine, data shapes are contracts/openapi/anatomic.yaml):
//   CaseWorkspace (T-19 seam) shows a working tab "Molecular" for case_kind 'molecular' only (04-UI-UX §4.2.6). The tab loads its own pickers through server actions:
//     GET /v1/anatomic/assays (K8, active assays/targets/values only are offered) and GET /v1/anatomic/batches (Q2, filtered client side per assay); results come from detail.molecular_results, rev from detail.molecular_rev.
//   app/(staff)/anatomic/batches/page.tsx              default async Page({ searchParams: Promise<{ status?, assay_code?, cursor? }> })   (04-UI-UX §4.6; GET /batches with the same query)
//   app/(staff)/anatomic/batches/[batch_id]/page.tsx   default async Page({ params: Promise<{ batch_id }> })                              (04-UI-UX §4.6; GET /batches/{id})
//   Shortcut page ids: none new (the batch pages register no shortcuts). Help keys 'anatomic.batches' and 'anatomic.batch' -> features/anatomic/help/<key>.ts
// Synthetic data only.
import { http, HttpResponse } from 'msw';
export { IDEM_RE, ID, ORIGIN, PERM_NONE, PERM_READ, PERM_WORK, api, detail, hit, hits, navigationMock, page, problem, resetHits, router, sessionMock, state, summary } from './t20.harness';
import { ID, ORIGIN, api, detail, page } from './t20.harness';

// ---------------------------------------------------------------- fixtures (schemas Assay, Batch, BatchDetail, MolecularResult)
const value = (code: string, display: string, is_abnormal: boolean, over: Record<string, unknown> = {}) => ({ code, display, is_abnormal, sort_order: 1, is_active: true, ...over });
/** SYN_PCR_A: T1 is quantitative (unit copies_per_ml, 0 decimals), T2 is qualitative, T3 is inactive. One inactive result value on T1 ("equivocal"). */
export const assay = (over: Record<string, unknown> = {}) => ({
  id: ID(900 + 1), code: 'SYN_PCR_A', display: 'Synthetic PCR A', method_text_default: 'Synthetic real-time PCR', is_active: true, version: 1,
  targets: [
    { id: ID(910), code: 'T1', display: 'Target one', allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 0, sort_order: 1, is_active: true,
      result_values: [value('detected', 'Detected', true), value('not_detected', 'Not detected', false), value('invalid', 'Invalid', false), value('equivocal', 'Equivocal', false, { is_active: false })] },
    { id: ID(911), code: 'T2', display: 'Target two', allows_quantitative: false, sort_order: 2, is_active: true,
      result_values: [value('positive', 'Positive', true), value('negative', 'Negative', false)] },
    { id: ID(912), code: 'T3', display: 'Retired target', allows_quantitative: false, sort_order: 3, is_active: false, result_values: [value('positive', 'Positive', true)] },
  ],
  ...over,
});
export const otherAssay = () => assay({ id: ID(902), code: 'SYN_NGS_B', display: 'Synthetic NGS B', method_text_default: undefined, targets: [{ id: ID(920), code: 'G1', display: 'Gene one', allows_quantitative: false, sort_order: 1, is_active: true, result_values: [value('variant', 'Variant found', true), value('wild_type', 'Wild type', false)] }] });
export const inactiveAssay = () => assay({ id: ID(903), code: 'SYN_OLD_C', display: 'Retired assay', is_active: false });

export const batch = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(1000 + n), batch_no: `MB26${String(n).padStart(4, '0')}`, assay_code: 'SYN_PCR_A', status: 'open', kit_name: 'Synthetic kit', kit_lot: `LOT-${n}`, kit_expiry_on: '2027-06-30',
  instrument_text: 'Synthetic cycler 1', run_at: '2026-11-12T03:15:00.000Z', capacity: 96, member_count: 0, version: 1, ...over,
});
export const member = (n: number, position: number, over: Record<string, unknown> = {}) => ({ case_id: ID(1100 + n), accession_no: `MO26-${String(n).padStart(6, '0')}`, position, ...over });
export const batchDetail = (n = 1, members: Record<string, unknown>[] = [], over: Record<string, unknown> = {}) => ({ ...batch(n, { member_count: members.length }), members, ...over });

export const molResult = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(1200 + n), assay_code: 'SYN_PCR_A', assay_display: 'Synthetic PCR A', target_code: 'T1', target_display: 'Target one', result_code: 'detected', result_display: 'Detected', is_abnormal: true,
  value_decimal: '1250', unit_code: 'copies_per_ml', method_text: 'Synthetic real-time PCR', kit_name: 'Synthetic kit', kit_lot: 'LOT-7', kit_expiry_on: '2027-06-30', comment_text: 'Synthetic comment', ...over,
});
/** A molecular case in processing; molecular_rev 2. */
export const molCase = (over: Record<string, unknown> = {}) =>
  detail({
    case_kind: 'molecular', accession_no: 'MO26-000042', status: 'in_processing', molecular_rev: 2, molecular_results: [],
    allowed_actions: ['markAnatomicCaseReady', 'cancelAnatomicCase'], ...over,
  });

// ---------------------------------------------------------------- default handlers
export const t22Defaults = [
  http.get(`${ORIGIN}/v1/anatomic/assays`, () => page([assay(), otherAssay(), inactiveAssay()])),
  http.get(`${ORIGIN}/v1/anatomic/batches`, () => page([batch(1), batch(2, { status: 'closed', member_count: 3 })])),
  http.put(`${ORIGIN}/v1/anatomic/cases/:id/molecular-results`, async ({ request }) => {
    const b = (await request.clone().json()) as { results: Record<string, unknown>[] };
    return HttpResponse.json({ molecular_rev: 3, results: b.results.map((r, i) => molResult(i + 1, r)) });
  }),
  http.post(`${ORIGIN}/v1/anatomic/batches`, () => HttpResponse.json(batch(7, { version: 1 }), { status: 201 })),
  http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [member(1, 1), member(2, 3)]))),
  http.post(`${ORIGIN}/v1/anatomic/batches/:id/members`, () => HttpResponse.json(batchDetail(1, [member(1, 1), member(2, 3), member(3, 2)], { version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/batches/:id/members/remove`, () => HttpResponse.json(batchDetail(1, [member(2, 3)], { version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/batches/:id/close`, () => HttpResponse.json(batchDetail(1, [member(1, 1), member(2, 3)], { status: 'closed', version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => HttpResponse.json({ object_kind: 'case', case_id: ID(1103) })),
];
void api;
