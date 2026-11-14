// C10.T-20 shared test harness (tester-owned; not a test file). MSW plays the C10 API (contracts/openapi/micro.yaml), the C4 patient read
// (frontdesk.yaml getPatient) and the C5 specimen read (lab.yaml); the BFF server functions run for real. Each test file registers three mocks:
//   vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; names are mine, the data shapes are the spec's):
//   app/(staff)/micro/cultures/[culture_id]/page.tsx   default async Page({ params: Promise<{ culture_id: string }> })   (04-UI-UX §3; 03-APP-FLOW §4.2)
//        + loading.tsx (kit LoadingSkeleton) + error.tsx ('use client', ErrorState + Retry, never error.message)
//   features/micro/components/culture/CultureScreen   ({ culture: CultureDetailDto, patient: PatientLite | null, specimen?: SpecimenLite | null, permissions: string[] })
//        PatientLite = { name: string; age_display?: string; sex?: string }; patient === null renders "Patient details unavailable" + ONE Retry link.
//        Coded sets, plating protocols and the micro settings are loaded by the screen through server actions when a dialog / tab first needs them
//        (GET /v1/micro/coded-sets/{set}, /plating-protocols, /settings); the page passes only the three props above.
//   features/micro/server/getCulture.server.ts    getCulture(id): CultureDetailDto            (server-only; id validated as UUID before the path)
//   features/micro/server/getPatient.server.ts    getPatient(patientId): Promise<PatientLite | null>   (GET /v1/frontdesk/patients/{id}; ANY failure -> null, one request, no retry)
//   features/micro/server/getSpecimen.server.ts   already exists (T-19); the page uses it for Reg no / barcode.
//   Shortcut page id 'micro.culture' (04-UI-UX §3): Alt+S, Alt+R, Alt+G, Alt+I, Alt+A, Alt+P, Alt+F, Alt+B.
//   Writes go through server actions: Idempotency-Key where the contract says `required`, If-Match "<version>" where it takes one.
// Synthetic data only.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const CULTURE_ID = ID(1);
export const PERM_WORK = ['micro.culture.read', 'micro.culture.work', 'frontdesk.patient.read', 'lab.specimen.read'];
export const PERM_READ = ['micro.culture.read', 'frontdesk.patient.read', 'lab.specimen.read'];

export const state = { permissions: PERM_WORK as string[], token: 'jwt-synthetic' as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Technologist', membershipId: ID(900), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => `/micro/cultures/${CULTURE_ID}`,
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => `/micro/cultures/${CULTURE_ID}`,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });

// ---------------------------------------------------------------- fixtures (CultureDetailDto & children, contracts/openapi/micro.yaml)
export const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
export const plate = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(100 + n), version: 1, plate_no: n, media_code: n === 1 ? 'synthetic_blood_agar' : 'synthetic_mac_agar', incubation_text: `Synthetic incubation ${n}`, planted_at: HOURS_AGO(30), status: 'active', ...over,
});
export const obs = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(200 + n), kind: 'plate_read', plate_id: ID(101), growth_code: 'synthetic_growth', quantity_text: '≥10^5 CFU/mL', observed_at: HOURS_AGO(24 - n), hours_since_planting: 6 + n,
  recorded_by_display: `Synthetic Tech ${n}`, is_corrected: false, ...over,
});
export const isolate = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(300 + n), version: 1, isolate_seq: n, status: 'identified', organism_code: 'synthetic_org', organism_display: 'Synthetic organism', organism_source: 'manual', identified_at: HOURS_AGO(10),
  quantity_text: '++', is_reportable: true, ast: [], ...over,
});
export const protocolLite = { id: ID(50), code: 'synthetic_protocol', version_no: 1, display: 'Synthetic urine protocol' };
export const protocolDto = (over: Record<string, unknown> = {}) => ({
  id: ID(50), version: 1, code: 'synthetic_protocol', version_no: 1, display: 'Synthetic urine protocol', read_schedule_hours: [18, 24, 48], final_no_growth_hours: 48, requires_gram_stain: false,
  default_specimen_site_code: 'syn_site', is_active: true, media: [{ media_code: 'synthetic_blood_agar', incubation_text: 'Synthetic incubation 1' }, { media_code: 'synthetic_mac_agar' }], ...over,
});
export const culture = (over: Record<string, unknown> = {}) => ({
  id: CULTURE_ID, version: 5, status: 'awaiting_setup', order_id: ID(2), order_item_id: ID(3), specimen_id: ID(4), patient_id: ID(5), centre_id: ID(6), test_id: ID(7), test_code: 'SYNCULT', test_name: 'Synthetic Urine Culture',
  specimen_type_code: 'SYN_URINE', specimen_site_code: 'syn_site', received_at: HOURS_AGO(2), is_read_overdue: false, current_report_version_no: 0, chain_cancelled: false, open_instrument_record_count: 0, barcode: 'E260000001',
  suggested_protocol: protocolLite, plates: [], observations: [], isolates: [], transitions: [], report_versions: [], permissions_hint: { can_amend_approved: false }, ...over,
});
/** An incubating culture with plates + a read + an isolate (the common "work" state). */
export const incubating = (over: Record<string, unknown> = {}) => culture({
  status: 'incubating', planted_at: HOURS_AGO(30), next_read_due_at: new Date(Date.now() + 6 * 3600_000).toISOString(), final_due_at: new Date(Date.now() + 18 * 3600_000).toISOString(), protocol: protocolDto(),
  plates: [plate(1), plate(2)], observations: [obs(1)], isolates: [], ...over,
});
export const patient = (over: Record<string, unknown> = {}) => ({
  id: ID(5), patient_code: 'P-SYN-0001', full_name: 'Synthetic Patient One', sex: 'F', age_display: '34 y', phone_masked: '98XXXXXX01', last_visit_at: '2026-11-01T00:00:00.000Z', is_anonymised: false, ...over,
});
export const specimen = (over: Record<string, unknown> = {}) => ({
  id: ID(4), version: 1, barcode: 'E260000001', order_id: ID(2), registration_no: 'R261100001', specimen_type_code: 'SYN_URINE', container_code: 'SYN_CODE', status: 'received', priority: 'SYN_CODE', centre_id: ID(6), is_active: true,
  collection_barcode_unverified: false, label_print_count: 1, tests: [], ...over,
});
export const code = (c: string, over: Record<string, unknown> = {}) => ({ code: c, display: `Synthetic ${c}`, sort_order: 10, is_active: true, source: 'global', ...over });
export const CODED: Record<string, ReturnType<typeof code>[]> = {
  media: [code('synthetic_blood_agar', { display: 'Synthetic blood agar' }), code('synthetic_mac_agar', { display: 'Synthetic MacConkey agar' }), code('synthetic_old_agar', { display: 'Synthetic retired agar', is_active: false })],
  specimen_sites: [code('syn_site', { display: 'Synthetic site' }), code('syn_site_two', { display: 'Synthetic site two' })],
  growth_codes: [code('synthetic_growth', { display: 'Synthetic growth', indicates_growth: true }), code('no_growth', { display: 'No growth', indicates_growth: false })],
  isolate_withdraw_reasons: [code('synthetic_contaminant', { display: 'Synthetic contaminant' }), code('synthetic_duplicate', { display: 'Synthetic duplicate' })],
  organisms: [code('synthetic_org', { display: 'Synthetic organism', organism_group_code: 'synthetic_group' }), code('synthetic_org_two', { display: 'Synthetic organism two', organism_group_code: 'synthetic_group' })],
};

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[]) => HttpResponse.json({ data, page: { limit: 50 } });
export const URL_CULTURE = `${ORIGIN}/v1/micro/cultures/${CULTURE_ID}`;

/** Default handlers; tests override with api.use(...). Writes answer with a plausible next culture so a test that ignores the result still passes the happy path. */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(culture())),
  http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, () => HttpResponse.json(patient())),
  http.get(`${ORIGIN}/v1/lab/specimens/:id`, () => HttpResponse.json(specimen())),
  http.get(`${ORIGIN}/v1/micro/coded-sets/:name`, ({ params, request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return page((CODED[String(params['name'])] ?? []).filter((c) => !q || c.display.toLowerCase().includes(q) || c.code.includes(q)));
  }),
  http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => page([protocolDto()])),
  http.get(`${ORIGIN}/v1/micro/ast-panels`, () => page([])),
  http.get(`${ORIGIN}/v1/micro/settings`, () => HttpResponse.json({ id: ID(9), version: 1, manual_ast_standard: 'CLSI', zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: true, recent_window_days: 7, is_active: true })),
  http.post(`${ORIGIN}/v1/micro/cultures/:id/setup`, () => HttpResponse.json(incubating({ version: 6 }))),
  http.post(`${ORIGIN}/v1/micro/cultures/:id/plates`, () => HttpResponse.json(plate(3))),
  http.post(`${ORIGIN}/v1/micro/cultures/:id/plates/:pid/discard`, () => HttpResponse.json(plate(2, { status: 'discarded' }))),
  http.post(`${ORIGIN}/v1/micro/cultures/:id/observations`, () => HttpResponse.json(obs(2))),
  http.post(`${ORIGIN}/v1/micro/cultures/:id/isolates`, () => HttpResponse.json(isolate(1, { status: 'pending_id' }))),
  http.post(`${ORIGIN}/v1/micro/isolates/:id/identify`, () => HttpResponse.json(isolate(1))),
  http.post(`${ORIGIN}/v1/micro/isolates/:id/describe`, () => HttpResponse.json(isolate(1))),
  http.post(`${ORIGIN}/v1/micro/isolates/:id/withdraw`, () => HttpResponse.json(isolate(1, { status: 'withdrawn', is_reportable: false }))),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };

// ---------------------------------------------------------------- UI helpers (kit = react-aria Select: trigger button + listbox options; DateTimePicker = text "DD/MM/YYYY hh:mm AM" in Asia/Kathmandu)
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** Open the kit Select labelled `label` (inside `root`) and pick the option named `option`. */
export async function pick(root: HTMLElement | undefined, label: RegExp, option: RegExp) {
  const scope = root ? within(root) : screen;
  await userEvent.click(scope.getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}
/** DateTimePicker text for a UTC instant, in the tenant zone (CV §4.8 [CONV] Asia/Kathmandu). */
export function localText(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']} ${String(p['dayPeriod']).toUpperCase()}`;
}
export async function typeDate(field: HTMLElement, d: Date) {
  await userEvent.clear(field);
  await userEvent.type(field, localText(d));
  await userEvent.tab();
}
/** Row action of a kit DataTable: the item is either a direct button in the row or a menuitem behind the row's last button (kit `rowActions` menu). */
export async function rowAction(rowText: RegExp | string, item: RegExp) {
  const row = screen.getAllByRole('row').find((r) => (typeof rowText === 'string' ? (r.textContent ?? '').includes(rowText) : rowText.test(r.textContent ?? '')));
  if (!row) throw new Error(`no table row matching ${String(rowText)}`);
  const direct = within(row).queryByRole('button', { name: item });
  if (direct) return userEvent.click(direct);
  const buttons = within(row).getAllByRole('button');
  await userEvent.click(buttons[buttons.length - 1]!);
  return userEvent.click(await screen.findByRole('menuitem', { name: item }));
}
export const dialog = async (name: RegExp) => screen.findByRole('dialog', { name });
export const lastHit = async (method: string, re: RegExp) => { await waitFor(() => expect(hit(method, re).length).toBeGreaterThan(0)); return hit(method, re).at(-1)!; };
import { expect } from 'vitest';
