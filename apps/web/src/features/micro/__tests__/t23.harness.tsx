// C10.T-23 shared test harness (tester-owned; not a test file). Builds on t20.harness (MSW fake C10 API, session/navigation mocks, kit helpers) and adds the instrument-record endpoints
// (contracts/openapi/micro.yaml: listMicroInstrumentRecords M19, assignMicroInstrumentRecord M20, applyMicroInstrumentRecord M21, ignoreMicroInstrumentRecord M22), the C5 specimen lookup and C7 listInstruments.
// Each test file registers:
//   vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exist; names are mine, data shapes are the spec's):
//   app/(staff)/micro/instrument-records/page.tsx   default async Page({ searchParams: Promise<Record<string,string|string[]|undefined>> })   (04-UI-UX §4)
//        GET /v1/micro/instrument-records?match_status=<csv>&sort=-received_at&limit<=50 (default csv = pending_match,needs_mapping,conflict,late_after_final); searchParams match_status (csv of the six
//        statuses), instrument_id (uuid), received_at_from / received_at_to, cursor are validated and forwarded; anything else is dropped. 403 -> MicroForbidden ("don't have access"); other failures reject (error.tsx).
//        GET /v1/instruments/instruments?limit=200 (C7) feeds the Instrument filter; a failure hides that filter but the page still renders.
//        The page reads process.env.LIMS_MICRO_SPECIMEN_LOOKUP_PORT (TRD §11, "true" = on; unset / anything else = off) on the server and tells the screen.
//   app/(staff)/micro/instrument-records/{loading,error}.tsx   loading = kit LoadingSkeleton; error = 'use client' ErrorState + Retry, never error.message
//   features/micro/components/instrument-records/*   screen + Assign / Resolve-conflict / Ignore dialogs + the culture-page tab; see the test headers for the visible behaviour.
//   Row menu = kit DataTable rowActions: "Assign to culture", "Apply", "Resolve conflict", "Ignore" (04-UI-UX §4), shown per 03-APP-FLOW §2.4 and only with micro.culture.work.
//   Writes go through server actions: M20 Idempotency-Key + If-Match "<record.version>", M21 Idempotency-Key + If-Match, M22 If-Match (+ Idempotency-Key allowed).
//   Culture page tab "Instrument data" (CultureScreen, T-20 seam) shows the culture's records via GET /v1/micro/instrument-records?culture_id=… (04-UI-UX §3.5).
// Synthetic data only.
import { http, HttpResponse } from 'msw';
import { CODED, ID, ORIGIN, PERM_READ, PERM_WORK, api, code, problem } from './t20.harness';

export * from './t20.harness';

export const LIST = /^\/v1\/micro\/instrument-records$/;
export const ASSIGN = /^\/v1\/micro\/instrument-records\/[^/]+\/assign$/;
export const APPLY = /^\/v1\/micro\/instrument-records\/[^/]+\/apply$/;
export const IGNORE = /^\/v1\/micro\/instrument-records\/[^/]+\/ignore$/;
export const LOOKUP = /^\/v1\/lab\/specimens\/lookup$/;
export const OPEN_STATUSES = 'pending_match,needs_mapping,conflict,late_after_final';
export const FLAG_ENV = 'LIMS_MICRO_SPECIMEN_LOOKUP_PORT';
export const BANNER_TEXT = 'Instrument results are matched to cultures manually until automatic matching is enabled.';
export const CONFLICT_COPY = 'This record conflicts with existing data. Choose which value to keep.';
export const BARCODE = 'E260000001';

CODED['record_ignore_reasons'] = [
  code('duplicate', { display: 'Synthetic duplicate result' }),
  code('wrong_patient', { display: 'Synthetic wrong specimen' }),
  code('syn_retired_reason', { display: 'Synthetic retired reason', is_active: false }),
];

export const INSTRUMENT_A = ID(700);
export const INSTRUMENT_B = ID(701);
export const rec = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(800 + n), version: 3, record_kind: 'ast', instrument_id: INSTRUMENT_A, instrument_message_id: ID(850 + n), sample_barcode: BARCODE, isolate_seq: 2,
  organism_code_raw: undefined, antibiotic_code_raw: 'SYN-CEF-A', method: 'mic', raw_value: '<=0.25', interpretation_raw: 'S', standard: 'CLSI', standard_version: '2026',
  instrument_result_time: '2026-11-13T08:30:00.000Z', received_at: '2026-11-13T08:31:00.000Z', is_rerun: false, match_status: 'pending_match', match_reason: 'lookup_unavailable', ...over,
});
export const orgRec = (n: number, over: Record<string, unknown> = {}) => rec(n, {
  record_kind: 'organism_id', antibiotic_code_raw: undefined, method: undefined, raw_value: undefined, interpretation_raw: undefined, standard: undefined, standard_version: undefined, organism_code_raw: 'SYN-ORG-9', isolate_seq: 1, ...over,
});
export const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); // the wire has no undefined / null (TRD §5)

/** Honest list: filters by match_status (csv) and culture_id so the BFF may filter server- or client-side. */
export const recordList = (all: any[], extra: Record<string, unknown> = {}) => http.get(`${ORIGIN}/v1/micro/instrument-records`, ({ request }) => {
  const q = new URL(request.url).searchParams;
  const st = (q.get('match_status') ?? OPEN_STATUSES).split(',');
  const cu = q.get('culture_id');
  const out = all.filter((r) => st.includes(r.match_status) && (!cu || r.culture_id === cu));
  return HttpResponse.json({ data: out.map(clean), page: { limit: 50, ...extra } });
});
export const instrumentList = () => http.get(`${ORIGIN}/v1/instruments/instruments`, () => HttpResponse.json({ data: [{ id: INSTRUMENT_A, code: 'SYN-VITEK', name: 'Synthetic ID analyser A' }, { id: INSTRUMENT_B, code: 'SYN-PHX', name: 'Synthetic ID analyser B' }] }));

// ---- scan chain of the Assign dialog: C5 lookup -> C10 cultures of the specimen (same chain as the T-19 worklist scan)
export const SPECIMEN_ID = ID(401);
export const cultureRow = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n), version: 1, status: 'incubating', order_id: ID(2), order_item_id: ID(3), specimen_id: SPECIMEN_ID, patient_id: ID(5), centre_id: ID(6), test_id: ID(7), test_code: `SYN${n}`, test_name: `Synthetic culture ${n}`,
  specimen_type_code: 'SYN_URINE', received_at: '2026-11-10T04:15:00.000Z', is_read_overdue: false, current_report_version_no: 0, chain_cancelled: false, open_instrument_record_count: 1, ...over,
});
export const scanChain = (cultures: any[] = [cultureRow(1)]) => [
  http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => HttpResponse.json({ id: SPECIMEN_ID, version: 1, barcode: BARCODE })),
  http.get(`${ORIGIN}/v1/micro/cultures`, ({ request }) => {
    const sp = new URL(request.url).searchParams.get('specimen_id');
    return HttpResponse.json({ data: cultures.filter((c) => !sp || c.specimen_id === sp), page: { limit: 50 } });
  }),
];

// ---- write endpoints (answer with the record in its next state)
export const writeOk = (kind: 'assign' | 'apply' | 'ignore', over: Record<string, unknown> = {}) =>
  http.post(`${ORIGIN}/v1/micro/instrument-records/:id/${kind}`, ({ params }) => HttpResponse.json(clean(rec(Number(String(params['id']).slice(-3)) - 800 || 1, { version: 4, match_status: kind === 'ignore' ? 'ignored' : 'applied', match_reason: undefined, culture_id: ID(1), ...over }))));
export const writeFail = (kind: 'assign' | 'apply' | 'ignore', c: string, status: number) => http.post(`${ORIGIN}/v1/micro/instrument-records/:id/${kind}`, () => problem(c, status));
export const useRecords = (records: any[] = [rec(1)]) => api.use(recordList(records), instrumentList(), writeOk('assign'), writeOk('apply'), writeOk('ignore'), ...scanChain());

// ---- conflict comparison data: the CURRENT manual value comes from the culture (GET /v1/micro/cultures/{id}); instrument value from the record
export const astResult = (over: Record<string, unknown> = {}) => ({
  id: ID(420), version: 1, antibiotic_code: 'syn_cef_a', antibiotic_display: 'Synthetic cefA', method: 'mic', raw_value: '0.5', category_code: 'R', standard: 'CLSI', standard_version: 'M100-Ed36', suggestion_overridden: false,
  source: 'manual', is_reportable: true, report_visibility: 'shown', off_panel: false, panel_sort_order: 1, ...over,
});
export const conflictCulture = (over: Record<string, unknown> = {}) => ({
  id: ID(1), version: 7, status: 'growth_detected', order_id: ID(2), order_item_id: ID(3), specimen_id: SPECIMEN_ID, patient_id: ID(5), centre_id: ID(6), test_id: ID(7), test_code: 'SYNCULT', test_name: 'Synthetic Urine Culture',
  specimen_type_code: 'SYN_URINE', received_at: '2026-11-10T04:15:00.000Z', is_read_overdue: false, current_report_version_no: 0, chain_cancelled: false, open_instrument_record_count: 1, barcode: BARCODE,
  plates: [], observations: [], transitions: [], report_versions: [], permissions_hint: { can_amend_approved: false },
  isolates: [{ id: ID(301), version: 1, isolate_seq: 2, status: 'identified', organism_code: 'synthetic_org', organism_display: 'Synthetic organism', organism_source: 'manual', identified_at: '2026-11-11T04:00:00.000Z', is_reportable: true, ast: [astResult()] }],
  ...over,
});

// ---- UI helpers
import { screen, within } from '@testing-library/react';
export const optionNamesOf = async (trigger: HTMLElement) => {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(trigger);
  const list = await screen.findByRole('listbox');
  const names = within(list).getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
  await userEvent.keyboard('{Escape}');
  return names;
};
export { PERM_READ, PERM_WORK, ID, ORIGIN, problem };
export const statusChip = (label: string) => Array.from(document.querySelectorAll('[data-tone]')).find((e) => (e.textContent ?? '').trim() === label) as HTMLElement | undefined;
