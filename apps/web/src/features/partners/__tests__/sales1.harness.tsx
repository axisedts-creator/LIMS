// T0D-SALES-1 shared harness (tester-owned): synthetic fixtures + a stateful MSW stand-in for the 15 sales operations of contracts/openapi/partners.yaml
// (/v1/partners/admin/sales/**), updateCollectorFlags of homecollection.yaml, and the party / centre reads the sales screens use. Screens are reached through
// the PAGE default exports (async server components: server page -> serverFetch -> MSW -> client parts), like Next does. Synthetic data only.
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

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
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000e${String(n).padStart(4, '0')}`;
export const READ = ['partners.sales.read'];
export const MANAGE = ['partners.sales.read', 'partners.sales.manage'];
export const TS = '2026-11-01T04:00:00.000Z';
export const S = `${ORIGIN}/v1/partners/admin/sales`;

const des = (n: number, level: number, name: string, o: Rec = {}): Rec => ({ id: ID(n), name, level, is_active: true, version: 1, created_at: TS, updated_at: TS, ...o });
export const DESIGNATIONS = [
  des(11, 1, 'Synthetic Regional Head', { version: 2 }),
  des(12, 2, 'Synthetic Area Head'),
  des(13, 5, 'Synthetic Field Executive'),
  des(14, 6, 'Synthetic Old Grade', { is_active: false, version: 4 }),
];
const rep = (n: number, name: string, d: Rec, o: Rec = {}): Rec => ({ id: ID(n), name, designation_id: d['id'], designation_level: d['level'], is_active: true, version: 1, created_at: TS, updated_at: TS, ...o });
/** Tree: R1 (root) > R2 > R3 ; R1 > R4 > R5 (inactive). */
export const R1 = rep(21, 'Synthetic Root Manager', DESIGNATIONS[0]!, { version: 5 });
export const R2 = rep(22, 'Synthetic Area Lead', DESIGNATIONS[1]!, { manager_id: R1['id'], phone: '+9779800000022', email: 'area.lead@example.test', joining_date: '2026-02-01', version: 3 });
export const R3 = rep(23, 'Synthetic Field Seller', DESIGNATIONS[2]!, { manager_id: R2['id'], phone: '+9779800000023', email: 'field.seller@example.test', joining_date: '2026-04-14', version: 2 });
export const R4 = rep(24, 'Synthetic Peer Manager', DESIGNATIONS[1]!, { manager_id: R1['id'] });
export const R5 = rep(25, 'Synthetic Retired Seller', DESIGNATIONS[2]!, { manager_id: R4['id'], is_active: false, version: 4 });
export const REPS = [R1, R2, R3, R4, R5];
const node = (r: Rec, depth: number): Rec => ({ id: r['id'], name: r['name'], designation_id: r['designation_id'], designation_level: r['designation_level'], ...(r['manager_id'] ? { manager_id: r['manager_id'] } : {}), depth, is_active: r['is_active'] });
export const TREE = [node(R1, 1), node(R2, 2), node(R3, 3), node(R4, 2), node(R5, 3)];

export const PARTY = { cp: ID(31), partner: ID(32), doctor: ID(33), referrer: ID(34) };
export const CLIENT_A: Rec = { assignment_id: ID(41), party_kind: 'credit_party', party_id: PARTY.cp, party_name: 'Synthetic General Hospital', outstanding_paisa: 1250075, last_bill_date: '2026-11-10', effective_from: '2026-05-01' };
export const CLIENT_B: Rec = { assignment_id: ID(42), party_kind: 'partner', party_id: PARTY.partner, party_name: 'Synthetic Collection Lab', outstanding_paisa: -50000, last_bill_date: '2026-10-02', effective_from: '2026-06-01' };
export const CLIENT_C: Rec = { assignment_id: ID(43), party_kind: 'doctor', party_id: PARTY.doctor, party_name: 'Synthetic Doctor Zeta', outstanding_paisa: 0, effective_from: '2026-07-01' };
export const CLIENTS_BY_REP: Record<string, Rec[]> = { [R2['id']]: [CLIENT_A], [R3['id']]: [CLIENT_B, CLIENT_C] };

export const CENTRE = ID(51);
const area = (n: number, o: Rec = {}): Rec => ({ id: ID(n), name: 'Synthetic ward 4', district: 'Kathmandu', area_text: 'Synthetic municipality, ward 4', centre_id: CENTRE, is_active: true, version: 2, created_at: TS, updated_at: TS, ...o });
export const AREAS = [area(61), area(62, { name: 'Synthetic ward 9', district: 'Lalitpur', area_text: undefined, centre_id: undefined, version: 1 }), area(63, { name: 'Synthetic old zone', is_active: false, version: 3 })];

export type Call = { method: string; path: string; search: URLSearchParams; headers: Headers; json?: any };
export const API = {
  calls: [] as Call[],
  designations: DESIGNATIONS as Rec[],
  reps: REPS as Rec[],
  tree: TREE as Rec[],
  areas: AREAS as Rec[],
  clients: CLIENTS_BY_REP as Record<string, Rec[]>,
  /** list reads answer this status instead of the data (403 / 500). */
  listFail: undefined as undefined | 403 | 500,
  /** per-representative clients call that answers 500. */
  clientsFail: new Set<string>(),
  nextCursor: undefined as undefined | string,
  /** the next write answers this (one shot). */
  fail: undefined as undefined | Response,
  writeDelayMs: 0,
  reset() {
    this.calls.length = 0; this.designations = DESIGNATIONS; this.reps = REPS; this.tree = TREE; this.areas = AREAS; this.clients = CLIENTS_BY_REP;
    this.listFail = undefined; this.clientsFail = new Set(); this.nextCursor = undefined; this.fail = undefined; this.writeDelayMs = 0;
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
const list = (get: () => Rec[]) => async ({ request }: { request: Request }) => {
  await rec(request);
  if (API.listFail === 403) return prob(403, 'auth.forbidden');
  if (API.listFail === 500) return prob(500, 'common.internal');
  return page(get());
};
/** A write: recorded, optionally delayed, answers the queued failure once, else `ok`. */
const write = (ok: (body: Rec, params: Record<string, string | readonly string[] | undefined>) => Response) => async ({ request, params }: { request: Request; params: Record<string, string | readonly string[] | undefined> }) => {
  await rec(request);
  await wait(API.writeDelayMs);
  if (API.fail) { const f = API.fail; API.fail = undefined; return f; }
  return ok(API.calls[API.calls.length - 1]!.json ?? {}, params);
};

export const api = setupServer(
  http.get(`${S}/designations`, list(() => API.designations)),
  http.post(`${S}/designations`, write((b) => HttpResponse.json(des(19, b['level'], b['name']), { status: 201 }))),
  http.patch(`${S}/designations/:id`, write((b, p) => HttpResponse.json({ ...DESIGNATIONS.find((d) => d['id'] === p['id'])!, ...b, version: 9 }))),
  http.get(`${S}/representatives/:id/clients`, async ({ request, params }) => {
    await rec(request);
    if (API.clientsFail.has(String(params['id']))) return prob(500, 'common.internal');
    if (API.listFail === 403) return prob(403, 'auth.forbidden');
    return page(API.clients[String(params['id'])] ?? []);
  }),
  http.post(`${S}/representatives/:id/deactivate`, write((_b, p) => HttpResponse.json({ ...REPS.find((r) => r['id'] === p['id'])!, is_active: false, version: 9 }))),
  http.patch(`${S}/representatives/:id`, write((b, p) => HttpResponse.json({ ...REPS.find((r) => r['id'] === p['id'])!, ...b, version: 9 }))),
  http.get(`${S}/representatives`, list(() => API.reps)),
  http.post(`${S}/representatives`, write((b) => HttpResponse.json({ ...rep(29, b['name'], DESIGNATIONS[2]!), ...b }, { status: 201 }))),
  http.get(`${S}/tree`, list(() => API.tree)),
  http.post(`${S}/assignments/:id/unassign`, write((b, p) => HttpResponse.json({ id: p['id'], party_kind: 'credit_party', party_id: PARTY.cp, representative_id: R2['id'], effective_from: '2026-05-01', effective_to: b['effective_to'] ?? '2026-11-20', version: 2, created_at: TS, updated_at: TS }))),
  http.post(`${S}/assignments`, write((b) => HttpResponse.json({ id: ID(49), ...b, version: 1, created_at: TS, updated_at: TS }, { status: 201 }))),
  http.get(`${S}/service-areas`, list(() => API.areas)),
  http.post(`${S}/service-areas`, write((b) => HttpResponse.json(area(69, b), { status: 201 }))),
  http.post(`${S}/service-areas/:id/deactivate`, write((_b, p) => HttpResponse.json({ ...AREAS.find((a) => a['id'] === p['id'])!, is_active: false, version: 9 }))),
  http.patch(`${S}/service-areas/:id`, write((b, p) => HttpResponse.json({ ...AREAS.find((a) => a['id'] === p['id'])!, ...b, version: 9 }))),
  http.patch(`${ORIGIN}/v1/homecollection/phlebotomists/:id`, write((b, p) => HttpResponse.json({ membership_id: p['id'], allow_collection: true, allow_pickup: true, ...b }))),
  // party and centre reads (names only; both name and display_name are served so a screen may read either)
  http.get(`${ORIGIN}/v1/billing/credit-parties`, async ({ request }) => { await rec(request); return page([{ id: PARTY.cp, party_code: 'GH', name: 'Synthetic General Hospital', display_name: 'Synthetic General Hospital', kind: 'hospital', is_active: true, version: 1 }]); }),
  http.get(`${ORIGIN}/v1/partners/admin/partners`, async ({ request }) => { await rec(request); return page([{ id: PARTY.partner, partner_code: 'CL', name: 'Synthetic Collection Lab', display_name: 'Synthetic Collection Lab', status: 'active', version: 1 }]); }),
  http.get(`${ORIGIN}/v1/catalog/doctors`, async ({ request }) => { await rec(request); return page([{ id: PARTY.doctor, display_name: 'Synthetic Doctor Zeta', name: 'Synthetic Doctor Zeta', is_active: true, version: 1 }]); }),
  http.get(`${ORIGIN}/v1/partners/admin/referrers`, async ({ request }) => { await rec(request); return page([{ id: PARTY.referrer, display_name: 'Synthetic Referrer Eta', name: 'Synthetic Referrer Eta', version: 1 }]); }),
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return page([{ id: CENTRE, code: 'KTM', name: 'Synthetic Kathmandu Centre', kind: 'lab', is_active: true }]); }),
  http.get(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return page([]); }),
);

type PageMod = { default: (p: unknown) => Promise<React.ReactNode> };
/** The four page files (empty until the writer creates them); a glob so a missing page fails the test with a clear message instead of breaking the whole harness. */
const PAGES = import.meta.glob('../../../app/(staff)/partners/sales/*/page.tsx') as Record<string, () => Promise<unknown>>;
export type Route = 'designations' | 'representatives' | 'clients' | 'areas';
export const PATH = (r: Route) => `/partners/sales/${r}`;

/** /partners/sales/<route>?<search> like Next: the server page runs first (a throw = error.tsx), then the client parts render. */
export async function openSales(route: Route, opts: { perms?: string[]; search?: string } = {}): Promise<ReturnType<typeof render>> {
  TM.session.permissions = opts.perms ?? MANAGE;
  TM.nav.search = opts.search ?? '';
  TM.nav.path = PATH(route);
  const load = PAGES[`../../../app/(staff)/partners/sales/${route}/page.tsx`];
  if (!load) throw new Error(`missing page file app/(staff)/partners/sales/${route}/page.tsx`);
  const mod = (await load()) as PageMod;
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(opts.search ?? ''))) })}</ToastProvider>);
}

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const rowOf = (text: RegExp | string) => screen.getAllByRole('row').find((r) => (typeof text === 'string' ? r.textContent!.includes(text) : text.test(r.textContent ?? '')))!;
export const headers = () => screen.getAllByRole('columnheader').map((h) => norm(h.textContent));
export const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
export const reasonOf = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
export const quiet = (ms = 60) => new Promise((r) => setTimeout(r, ms));
export const IDEM = /^[A-Za-z0-9_-]{1,64}$/;
/** Open a kit Select (a button named after its label) and click an option. */
export const pickOption = async (user: { click: (e: Element) => Promise<void> }, scope: HTMLElement, label: RegExp, option: RegExp) => {
  await user.click(within(scope).getByRole('button', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
};
/** Names of the options of an open kit Select. */
export const optionNames = () => screen.getAllByRole('option').map((o) => norm(o.textContent));
