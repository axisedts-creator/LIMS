// T0D-PARTYSET-1 shared harness (tester-owned; NOT a test file): synthetic fixtures + a stateful MSW stand-in for the 18 operations of T0C-PARTYSET-1
// (contracts/openapi/partners.yaml /v1/partners/admin/{party-settings,onboarding,penalties,penalty-events,parties/.../id-number}; catalog.yaml /v1/catalog/icd-master)
// plus the party / doctor reads the screens already use. Screens are reached through the PAGE default exports (async server components: server page ->
// serverFetch -> MSW -> client parts), like Next does. Synthetic data only. Shapes follow the contract schemas exactly (additionalProperties: false).
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { partner as partnerFixture, partnerUser, PARTNER } from './t16.fixtures';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
export { PARTNER };

type TMState = {
  nav: { search: string; path: string };
  session: { permissions: string[] };
  navLog: string[];
  push: { mockClear: () => void; mock: { calls: unknown[][] } };
  replace: { mockClear: () => void; mock: { calls: unknown[][] } };
  refresh: { mockReset: () => void; mockClear: () => void; mock: { calls: unknown[][] } };
};
export const TM = (globalThis as unknown as { __TM: TMState }).__TM;

type Rec = Record<string, any>;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
export const TS = '2026-11-01T04:00:00.000Z';
export const A = `${ORIGIN}/v1/partners/admin`;
export const C = `${ORIGIN}/v1/catalog`;

export const PERM = {
  settingRead: 'partners.party_setting.read', settingManage: 'partners.party_setting.manage', decide: 'partners.onboarding.decide', idRead: 'partners.party_id_number.read',
  penalty: 'partners.penalty.manage', icd: 'catalog.icd.manage', partnerRead: 'partners.partner.read', partnerManage: 'partners.partner.manage', referrerRead: 'catalog.referrer.read', referrerManage: 'catalog.referrer.manage',
} as const;

/** The party ids used by the fixtures. */
export const P = { partner: PARTNER, cp: ID(31), doctor: ID(33), referrer: ID(34) };

export const SETTING_DEFAULT: Rec = {
  party_kind: 'partner', party_id: P.partner, is_default: true, auto_release_reports: false, whatsapp_enabled: false, insurance_enabled: false, print_exception: false,
  billing_cycle: 'monthly', invoice_payment_days: 30, invoice_blocking_days: 60, invoice_warning_days: 45, interest_bp_per_day: 0, priority: 'P3', header_footer_mode: 'both',
  commission_bp: 0, tds_bp: 0, auto_block_overdue: false, version: 1,
};
export const SETTING_SAVED: Rec = {
  ...SETTING_DEFAULT, id: ID(81), is_default: false, auto_release_reports: true, whatsapp_enabled: true, lab_number_scheme_code: 'KTM_A', billing_cycle: 'quarterly',
  invoice_payment_days: 30, invoice_blocking_days: 90, invoice_warning_days: 45, interest_bp_per_day: 5, priority: 'P2', header_footer_mode: 'without', commission_bp: 1250, tds_bp: 100,
  auto_block_overdue: true, version: 4, updated_at: TS,
};

const onb = (n: number, o: Rec = {}): Rec => ({ id: ID(n), party_kind: 'partner', party_id: ID(n + 100), party_name: 'Synthetic Franchise One', status: 'pending', version: 1, created_at: '2026-11-10T04:00:00.000Z', ...o });
export const ONBOARDING = [
  onb(91),
  onb(92, { party_kind: 'credit_party', party_name: 'Synthetic Hospital Two', status: 'held', reason: 'Documents missing', decided_by: ID(7), decided_at: '2026-11-11T04:00:00.000Z', version: 2 }),
  onb(93, { party_kind: 'doctor', party_name: 'Synthetic Doctor Three', status: 'approved', decided_by: ID(7), decided_at: '2026-11-12T04:00:00.000Z', version: 3 }),
  onb(94, { party_kind: 'referrer', party_name: 'Synthetic Referrer Four', status: 'rejected', reason: 'Duplicate of an existing party', decided_by: ID(7), decided_at: '2026-11-12T05:00:00.000Z', version: 2 }),
];

const pen = (n: number, o: Rec = {}): Rec => ({ id: ID(n), code: 'LATE', name: 'Late sample delivery', amount_paisa: 150000, is_active: true, version: 2, created_at: TS, updated_at: TS, ...o });
export const PENALTIES = [pen(101), pen(102, { code: 'NOPAN', name: 'Missing PAN on invoice', amount_paisa: 50025, version: 1 }), pen(103, { code: 'OLD', name: 'Retired penalty', amount_paisa: 10000, is_active: false, version: 5 })];
const ev = (n: number, o: Rec = {}): Rec => ({ id: ID(n), party_kind: 'partner', party_id: P.partner, penalty_id: ID(101), event_date: '2026-11-15', amount_paisa: 150000, status: 'raised', version: 1, created_at: TS, ...o });
export const EVENTS = [
  ev(111),
  ev(112, { party_kind: 'credit_party', party_id: P.cp, penalty_id: ID(102), amount_paisa: 50025, event_date: '2026-11-14', status: 'waived', reason: 'Waived after a phone call', decided_by: ID(7), version: 2 }),
  ev(113, { party_kind: 'doctor', party_id: P.doctor, event_date: '2026-11-13', status: 'charged', ledger_entry_id: ID(121), decided_by: ID(7), version: 2 }),
];
const icd = (n: number, o: Rec = {}): Rec => ({ id: ID(n), code: 'A00', title: 'Cholera', chapter: 'Certain infectious and parasitic diseases', is_active: true, version: 1, created_at: TS, updated_at: TS, ...o });
export const ICD = [icd(131), icd(132, { code: 'E11.9', title: 'Type 2 diabetes mellitus without complications', chapter: 'Endocrine, nutritional and metabolic diseases', version: 3 }), icd(133, { code: 'Z99', title: 'Retired synthetic code', chapter: undefined, is_active: false, version: 2 })];

export const DOCTOR: Rec = {
  id: P.doctor, doctor_code: 'DR00001', display_name: 'Synthetic Doctor Zeta', qualification: 'MD Pathology', registration_council: 'NMC', registration_no: 'SYN-0001', phone_e164: '+9779800000033', email: 'zeta@example.test',
  speciality: 'Pathology', hospital: 'Synthetic General Hospital', national_id_number: '********0002', is_verified: true, source: 'back_office', is_active: true, version: 3,
};
export const PARTNER_SYN = partnerFixture({ tax_number: '********0001', national_id_number: '********0002', version: 4 });

export type Call = { method: string; path: string; search: URLSearchParams; headers: Headers; json?: any };
export const API = {
  calls: [] as Call[],
  setting: SETTING_DEFAULT as Rec,
  onboarding: ONBOARDING as Rec[],
  penalties: PENALTIES as Rec[],
  events: EVENTS as Rec[],
  icd: ICD as Rec[],
  /** the party the partner / doctor reads answer with */
  partner: PARTNER_SYN as Rec,
  doctor: DOCTOR,
  /** reveal answers this value (200) unless revealFail is set */
  revealValue: 'SYN000000001',
  revealFail: undefined as undefined | Response,
  /** reads (any list / get of the PARTYSET operations) answer this status instead of the data */
  readFail: undefined as undefined | 403 | 500 | 501,
  nextCursor: undefined as undefined | string,
  /** the next write answers this (one shot). */
  fail: undefined as undefined | Response,
  writeDelayMs: 0,
  reset() {
    this.calls.length = 0; this.setting = SETTING_DEFAULT; this.onboarding = ONBOARDING; this.penalties = PENALTIES; this.events = EVENTS; this.icd = ICD; this.partner = PARTNER_SYN; this.doctor = DOCTOR;
    this.revealValue = 'SYN000000001'; this.revealFail = undefined; this.readFail = undefined; this.nextCursor = undefined; this.fail = undefined; this.writeDelayMs = 0;
  },
  find: (method: string, re: RegExp) => API.calls.filter((c) => c.method === method && re.test(c.path)),
  writes: () => API.calls.filter((c) => c.method !== 'GET'),
};
export const prob = (status: number, code: string, errors?: { path: string; code: string; message: string }[]) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162', ...(errors ? { errors } : {}) }, { status, headers: { 'content-type': 'application/problem+json' } });

const rec = async (request: Request) => {
  const u = new URL(request.url);
  API.calls.push({ method: request.method, path: u.pathname, search: u.searchParams, headers: request.headers, ...(request.method === 'GET' ? {} : { json: await request.clone().json().catch(() => undefined) }) });
};
const wait = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : undefined);
const page = (data: Rec[]) => HttpResponse.json({ data, page: { limit: 50, ...(API.nextCursor ? { next_cursor: API.nextCursor } : {}) } });
const readGate = () => (API.readFail ? prob(API.readFail, API.readFail === 403 ? 'auth.forbidden' : API.readFail === 501 ? 'common.operation_pending' : 'common.internal') : undefined);
const list = (get: (q: URLSearchParams) => Rec[]) => async ({ request }: { request: Request }) => {
  await rec(request);
  return readGate() ?? page(get(new URL(request.url).searchParams));
};
const one = (get: () => Rec) => async ({ request }: { request: Request }) => { await rec(request); return readGate() ?? HttpResponse.json(get()); };
/** A write: recorded, optionally delayed, answers the queued failure once, else `ok`. */
const write = (ok: (body: Rec, params: Record<string, string | readonly string[] | undefined>) => Response) => async ({ request, params }: { request: Request; params: Record<string, string | readonly string[] | undefined> }) => {
  await rec(request);
  await wait(API.writeDelayMs);
  if (API.fail) { const f = API.fail; API.fail = undefined; return f; }
  return ok(API.calls[API.calls.length - 1]!.json ?? {}, params);
};
const row = (rows: Rec[], p: Record<string, string | readonly string[] | undefined>, key = 'id') => rows.find((r) => r['id'] === p[key])!;

export const api = setupServer(
  // commercial settings
  http.get(`${A}/party-settings/:kind/:id`, one(() => API.setting)),
  http.put(`${A}/party-settings/:kind/:id`, write((b, p) => HttpResponse.json({ ...API.setting, ...b, party_kind: p['kind'], party_id: p['id'], is_default: false, id: ID(82), version: Number(API.setting['version']) + (API.setting['is_default'] ? 0 : 1) }))),
  // onboarding queue
  http.get(`${A}/onboarding`, list((q) => API.onboarding.filter((r) => (q.get('status') ? r['status'] === q.get('status') : true)))),
  http.post(`${A}/onboarding/:id/decision`, write((b, p) => HttpResponse.json({ ...row(API.onboarding, p), status: b['decision'] === 'approve' ? 'approved' : b['decision'] === 'hold' ? 'held' : 'rejected', ...(b['reason'] ? { reason: b['reason'] } : {}), decided_by: ID(7), decided_at: TS, version: 9 }))),
  // penalty master + events
  http.get(`${A}/penalties`, list((q) => API.penalties.filter((r) => (q.get('is_active') ? String(r['is_active']) === q.get('is_active') : true)).filter((r) => (q.get('q') ? `${r['code']} ${r['name']}`.toLowerCase().includes(q.get('q')!.toLowerCase()) : true)))),
  http.post(`${A}/penalties`, write((b) => HttpResponse.json(pen(109, b), { status: 201 }))),
  http.post(`${A}/penalties/:id/deactivate`, write((_b, p) => HttpResponse.json({ ...row(API.penalties, p), is_active: false, version: 9 }))),
  http.patch(`${A}/penalties/:id`, write((b, p) => HttpResponse.json({ ...row(API.penalties, p), ...b, version: 9 }))),
  http.get(`${A}/penalty-events`, list((q) => API.events.filter((r) => (q.get('status') ? r['status'] === q.get('status') : true)))),
  http.post(`${A}/penalty-events/:id/waive`, write((b, p) => HttpResponse.json({ ...row(API.events, p), status: 'waived', reason: b['reason'], decided_by: ID(7), version: 9 }))),
  http.post(`${A}/penalty-events/:id/charge`, write((_b, p) => HttpResponse.json({ ...row(API.events, p), status: 'charged', ledger_entry_id: ID(122), decided_by: ID(7), version: 9 }))),
  http.post(`${A}/penalty-events`, write((b) => HttpResponse.json(ev(119, { ...b, amount_paisa: b['amount_paisa'] ?? 150000 }), { status: 201 }))),
  // masked ID numbers
  http.post(`${A}/parties/:kind/:id/id-number`, async ({ request, params }) => {
    await rec(request);
    if (API.revealFail) return API.revealFail;
    const b = API.calls[API.calls.length - 1]!.json ?? {};
    return HttpResponse.json({ party_kind: params['kind'], party_id: params['id'], field: b['field'], value: API.revealValue });
  }),
  // ICD master
  http.get(`${C}/icd-master/search`, list(() => API.icd)),
  http.get(`${C}/icd-master`, list((q) => API.icd.filter((r) => (q.get('q') ? `${r['code']} ${r['title']}`.toLowerCase().includes(q.get('q')!.toLowerCase()) : true)))),
  http.post(`${C}/icd-master`, write((b) => HttpResponse.json(icd(139, b), { status: 201 }))),
  http.post(`${C}/icd-master/:id/deactivate`, write((_b, p) => HttpResponse.json({ ...row(API.icd, p), is_active: false, version: 9 }))),
  http.patch(`${C}/icd-master/:id`, write((b, p) => HttpResponse.json({ ...row(API.icd, p), ...b, version: 9 }))),
  // partner detail (existing screen) and its tab reads
  http.get(`${A}/partners/:id/users`, async ({ request }) => { await rec(request); return page([partnerUser(1)]); }),
  http.get(`${A}/partners/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(API.partner); }),
  http.patch(`${A}/partners/:id`, write((b) => HttpResponse.json({ ...API.partner, ...b, version: 9 }))),
  // doctor detail (existing screen)
  http.get(`${C}/doctors/:id`, one(() => API.doctor)),
  http.patch(`${C}/doctors/:id`, write((b) => HttpResponse.json({ ...API.doctor, ...b, version: 9 }))),
  // party and penalty-party reads (names only; both name and display_name are served so a screen may read either)
  http.get(`${ORIGIN}/v1/billing/credit-parties/:id/charges`, async ({ request }) => { await rec(request); return page([]); }),
  http.get(`${ORIGIN}/v1/billing/credit-parties/:id/statement`, async ({ request }) => { await rec(request); return HttpResponse.json({ rows: [] }); }),
  http.get(`${ORIGIN}/v1/billing/credit-parties/:id`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: P.cp, code: 'GH', name: 'Synthetic General Hospital', credit_limit_paisa: 5000000, credit_days: 30, is_locked: false, outstanding: { amount_paisa: 1250075, currency: 'NPR' }, version: 1 }); }),
  http.get(`${ORIGIN}/v1/billing/credit-parties`, async ({ request }) => { await rec(request); return page([{ id: P.cp, party_code: 'GH', code: 'GH', name: 'Synthetic General Hospital', display_name: 'Synthetic General Hospital', kind: 'hospital', is_active: true, version: 1 }]); }),
  http.get(`${A}/partners`, async ({ request }) => { await rec(request); return page([{ id: P.partner, partner_code: 'CL', name: 'Synthetic Collection Lab', display_name: 'Synthetic Collection Lab', status: 'active', version: 1 }]); }),
  http.get(`${C}/doctors`, async ({ request }) => { await rec(request); return page([{ id: P.doctor, doctor_code: 'DR00001', display_name: 'Synthetic Doctor Zeta', name: 'Synthetic Doctor Zeta', is_verified: true, is_active: true, version: 1 }]); }),
  http.get(`${A}/referrers`, async ({ request }) => { await rec(request); return page([{ id: P.referrer, display_name: 'Synthetic Referrer Eta', name: 'Synthetic Referrer Eta', mapping_state: 'mapped', samples_this_month: 0, version: 1 }]); }),
  http.get(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return page([]); }),
);

type PageMod = { default: (p: any) => Promise<ReactNode> | ReactNode };
/** `rel` is relative to apps/web/src/app/(staff)/, e.g. 'partners/onboarding' or 'partners/[partner_id]'. A missing page file fails the test with a clear message. */
export async function openPage(rel: string, opts: { perms: string[]; params?: Record<string, string>; search?: string; path?: string }): Promise<ReturnType<typeof render>> {
  TM.session.permissions = opts.perms;
  TM.nav.search = opts.search ?? '';
  TM.nav.path = opts.path ?? `/${rel}`;
  let mod: PageMod;
  try { mod = (await import(/* @vite-ignore */ `../../../app/(staff)/${rel}/page`)) as PageMod; } catch (e) { throw new Error(`missing or broken page file app/(staff)/${rel}/page.tsx: ${(e as Error).message}`); }
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve(opts.params ?? {}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(opts.search ?? ''))) })}</ToastProvider>);
}
export const ROUTE = { onboarding: 'partners/onboarding', penalties: 'partners/penalties', events: 'partners/penalty-events', icd: 'catalog/icd', partner: 'partners/[partner_id]', doctor: 'catalog/doctors/[doctor_id]' } as const;
export const PATHS = { onboarding: '/partners/onboarding', penalties: '/partners/penalties', events: '/partners/penalty-events', icd: '/catalog/icd' } as const;

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const rowOf = (text: RegExp | string) => screen.getAllByRole('row').find((r) => (typeof text === 'string' ? r.textContent!.includes(text) : text.test(r.textContent ?? '')))!;
export const headers = () => screen.getAllByRole('columnheader').map((h) => norm(h.textContent));
export const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
export const reasonOf = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
export const quiet = (ms = 60) => new Promise((r) => setTimeout(r, ms));
export const IDEM = /^[A-Za-z0-9_-]{1,64}$/;
/** A kit Select trigger: a button labelled by its Label (accessible name is "<value text> <label>": never match by name prefix; LD-353 ruling of T0D-SALES-1). */
export const selectTrigger = (scope: HTMLElement, label: RegExp) => within(scope).getByLabelText(label, { selector: 'button' });
export const pickOption = async (user: { click: (e: Element) => Promise<void> }, scope: HTMLElement, label: RegExp, option: RegExp) => {
  await user.click(selectTrigger(scope, label));
  await user.click(await screen.findByRole('option', { name: option }));
};
export const optionNames = () => screen.getAllByRole('option').map((o) => norm(o.textContent));
