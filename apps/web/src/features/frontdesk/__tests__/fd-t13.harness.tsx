// FD-T13 shared harness (tester-owned; NOT a test file). Registration page UI tests: MSW plays the API (C4 F1/F8/F9, C3 search, B3 print, C5 #14a).
// ASSUMED contract (the spec fixes only the route files + kit components; writer disputes if wrong). Everything under apps/web/src/features/frontdesk/:
//   components/RegistrationForm.tsx  named export `RegistrationForm({ centres, permissions, defaultCentreId? })`  — the whole page body (client component).
//     centres = {id,name}[] (centres in scope); permissions = readonly string[] (actor permissions; needs 'frontdesk.registration.create').
//   It reaches the API only through server actions / .server.ts in features/frontdesk/server/ (serverFetch -> LIMS_ORIGIN_API), so MSW at ORIGIN sees every call:
//     POST /v1/frontdesk/patients/search {query}            -> {data: PatientSummary[]}           (search is POST: no PHI in URLs)
//     GET  /v1/catalog/orderables?q=                         -> {data: OrderableSummary[]}          (C3 searchOrderables)
//     POST /v1/catalog/doctors/search {q}                    -> {data: DoctorSummary[]}             (C3 searchDoctors)
//     GET  /v1/catalog/credit-parties?q=                     -> {data: CreditParty[], page}         (C3 listCreditParties; B19 is NOT called by front_desk)
//     GET  /v1/billing/coded-sets/payment_methods            -> {data: CodedSetEntry[]}
//     POST /v1/frontdesk/registrations/quote                 -> Quote (F8)        POST /v1/frontdesk/registrations -> RegistrationResult (F9, Idempotency-Key)
//     POST /v1/billing/invoices/:id/print {reason_code}      -> InvoicePrint (B3)  POST /v1/lab/orders/:id/label-prints {} -> 200 | 409 (C5 #14a)
//   LD-25 (2026-11-07, downtime mode): the page has a "Downtime back-entry" switch. ON adds fields labelled /original time/i (kit DateTimePicker, typed as
//   "DD/MM/YYYY hh:mm AM" in Asia/Kathmandu) and /paper form serial/i; F9 then carries entry_mode:'downtime_backentry', occurred_at (ISO UTC), downtime_ref.
//   OFF (default) sends none of occurred_at/downtime_ref and entry_mode absent or 'live'. The window is the constant 72 h (CR FD-T06-ld25-gaps: front_desk cannot read settings).
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { createHash } from 'node:crypto';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
export const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE = U(1), PATIENT = U(2), ORDER = U(3), INVOICE = U(4), PARTY = U(5), RECEIPT = U(6);
export const ITEM = { CBC: U(11), LIPID: U(12), TSH: U(13) } as const;
export const PERMS = ['frontdesk.registration.create', 'frontdesk.patient.read', 'frontdesk.trf.upload', 'catalog.test.read', 'catalog.referrer.read', 'billing.invoice.issue', 'lab.specimen.label_print'];
export const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }, { id: U(7), name: 'Synthetic Centre B2' }];

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: extra['title'] ?? code, status, code, ...extra }, { status });
export const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });

export const patient = { id: PATIENT, patient_code: 'P-000123', full_name: 'Synthetic Patient One', sex: 'female', age_display: '43 Years', phone_masked: '98xxxxxx42', last_visit_at: '2026-10-01T04:00:00.000Z', is_anonymised: false };
const ORDERABLES = [
  { id: ITEM.CBC, kind: 'test', code: 'CBC', name: 'Complete blood count' },
  { id: ITEM.LIPID, kind: 'panel', code: 'LIPID', name: 'Lipid profile' },
  { id: ITEM.TSH, kind: 'test', code: 'TSH', name: 'Thyroid stimulating hormone' },
].map((o) => ({ ...o, is_orderable: true, is_active: true, revision: 1 }));
export const party = { id: PARTY, party_code: 'SYNCORP', name: 'Synthetic Corp', kind: 'company', allows_credit: true, is_active: true, version: 1 };

// Every item costs NPR 100.00 + 13% VAT = NPR 113.00 (11300 paisa); 3 items -> net 33900.
export const UNIT = 11300;
export const fp = (items: unknown) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
export function quoteFor(body: any, over: Record<string, unknown> = {}) {
  const items: any[] = body.items ?? [];
  const byId = (id: string) => ORDERABLES.find((o) => o.id === id)!;
  const lines = items.map((it, i) => ({
    line_ref: `l${i}`, orderable_id: it.orderable_id, orderable_kind: byId(it.orderable_id).kind, code: byId(it.orderable_id).code, name: byId(it.orderable_id).name,
    priority: it.priority ?? body.priority ?? 'routine', kind: 'orderable', unit_price: npr(10000), discount: npr(0), taxable: npr(10000), exempt: npr(0), vat: npr(1300), other_tax: npr(0), net: npr(UNIT),
    price_source: 'price_list', price_list_id: U(20), price_list_version: 1,
  }));
  const n = items.length;
  return {
    lines,
    totals: { gross: npr(10000 * n), discount: npr(0), exempt: npr(0), taxable: npr(10000 * n), vat: npr(1300 * n), other_tax: npr(0), net: npr(UNIT * n) },
    discount_evaluation: { within_limit: true, approval_required: false, limit_percent_bp: 500, limit_paisa: 0 },
    catalog_revision: 1, quote_fingerprint: fp(items), base_fingerprint: fp(items), fiscal_year_bs: '2083/84',
    ...(body.billing_mode === 'credit' ? { credit_status: { state: 'ok' } } : {}),
    ...over,
  };
}
export const result = (over: Record<string, unknown> = {}) => ({
  order: { id: ORDER, registration_no: 'R-2083-000042', status: 'registered', billing_mode: 'cash' },
  invoice: { id: INVOICE, invoice_no: 'INV/2083-84/000042', status: 'issued' },
  ledger_entries: [{ id: RECEIPT }],
  balance: { order_id: ORDER, net: npr(UNIT * 3), paid: npr(UNIT * 3), due: npr(0), balance_version: 2 },
  print: { invoice_id: INVOICE, receipt_ledger_entry_ids: [RECEIPT] },
  notifications: { registration_sms: 'queued' },
  label_print: { autoprint: false },
  ...over,
});

export interface Call { method: string; path: string; search: string; headers: Headers; body?: any }
export const calls: Call[] = [];
export const of = (m: string, pathRe: RegExp) => calls.filter((c) => c.method === m && pathRe.test(c.path));
export const PATH = { search: /\/patients\/search$/, quote: /\/registrations\/quote$/, register: /\/frontdesk\/registrations$/, print: /\/billing\/invoices\/[^/]+\/print$/, labels: /\/lab\/orders\/[^/]+\/label-prints$/, orderables: /\/catalog\/orderables$/ };

const defaults = {
  patients: () => HttpResponse.json({ data: [patient] }),
  quote: async (b: any) => HttpResponse.json(quoteFor(b)),
  register: async (_b: any) => HttpResponse.json(result(), { status: 201 }),
  print: async (_b: any) => HttpResponse.json({ print_no: 1, document: { id: INVOICE, invoice_no: 'INV/2083-84/000042' } }),
  labels: async () => HttpResponse.json({ order_id: ORDER, specimens: [{ specimen_id: U(30), barcode: 'E2600000101', outcome: 'ready' }], labels_route: 'staff.lab.order_labels' }),
};
/** Per-test overrides: handlers.quote = async (body) => Response; reset after every test by setup(). */
export const handlers: Record<keyof typeof defaults, (b: any) => any> = { ...defaults };
const rec = async (r: Request) => {
  const u = new URL(r.url);
  const c: Call = { method: r.method, path: u.pathname, search: u.search, headers: r.headers };
  if (r.method !== 'GET') c.body = await r.clone().json().catch(() => undefined);
  calls.push(c);
  return c;
};
export const api = setupServer(
  http.post(`${ORIGIN}/v1/frontdesk/patients/search`, async ({ request }) => { const c = await rec(request); return handlers.patients(c.body); }),
  http.get(`${ORIGIN}/v1/catalog/orderables`, async ({ request }) => {
    await rec(request);
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return HttpResponse.json({ data: ORDERABLES.filter((o) => o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q)) });
  }),
  http.post(`${ORIGIN}/v1/catalog/doctors/search`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ id: U(40), doctor_code: 'CP00001', display_name: 'Dr Synthetic Referrer', is_verified: true, is_active: true }] }); }),
  http.get(`${ORIGIN}/v1/catalog/credit-parties`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [party], page: { next_cursor: null } }); }),
  http.get(`${ORIGIN}/v1/billing/coded-sets/payment_methods`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ code: 'cash', display: 'Cash', sort_order: 1 }, { code: 'card', display: 'Card', sort_order: 2 }, { code: 'esewa', display: 'eSewa', sort_order: 3 }] }); }),
  // F25 listFrontdeskCodes (C4 02-TRD:219); deliberately unsorted — the UI sorts by sort_order. Seed codes per 05-SCHEMA:1859.
  http.get(`${ORIGIN}/v1/frontdesk/coded-sets/discount_reasons`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ code: 'promotion', display: 'Promotion', sort_order: 3 }, { code: 'staff_family', display: 'Staff family', sort_order: 1 }, { code: 'senior_citizen', display: 'Senior citizen', sort_order: 2 }] }); }),
  http.post(`${ORIGIN}/v1/frontdesk/registrations/quote`, async ({ request }) => { const c = await rec(request); return handlers.quote(c.body); }),
  http.post(`${ORIGIN}/v1/frontdesk/registrations`, async ({ request }) => { const c = await rec(request); return handlers.register(c.body); }),
  http.post(`${ORIGIN}/v1/billing/invoices/:id/print`, async ({ request }) => { const c = await rec(request); return handlers.print(c.body); }),
  http.post(`${ORIGIN}/v1/lab/orders/:id/label-prints`, async ({ request }) => { const c = await rec(request); return handlers.labels(c.body); }),
  http.post(`${ORIGIN}/v1/frontdesk/discount-approvals`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: U(50), state: 'pending' }, { status: 201 }); }),
);

export const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/frontdesk/registrations/new',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['frontdesk.registration.create'], displayName: 'Synthetic Desk', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/frontdesk/registrations/new',
}));

/** Call once at the top of each test file. */
export function setup() {
  beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => {
    cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset();
    Object.assign(handlers, defaults);
  });
  afterAll(() => api.close());
}

export const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
export const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/${p}`)) as T;
export async function renderForm(props: Record<string, unknown> = {}) {
  const { RegistrationForm } = await mod<{ RegistrationForm: any }>('RegistrationForm');
  return wrap(<RegistrationForm centres={centres} permissions={PERMS} defaultCentreId={CENTRE} {...props} />);
}
export const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
/** Rupee text as the kit renders it ("Rs. 339.00"; spec wording "NPR 339.00" also accepted). */
export const MONEY = (paisa: number) => new RegExp(`(NPR|Rs\\.?)\\s*${(paisa / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }).replace(/\./g, '\\.')}`);
export { delay, http, HttpResponse } from 'msw';
