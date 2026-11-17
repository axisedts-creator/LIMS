// @vitest-environment jsdom
// C3.T-33 — SCR-09 Panels & packages, SCR-10 Comment codes, SCR-11 Doctors (list, verify queue, detail, merge), SCR-12 Credit parties
// (04-UI-UX §4; 03-APP-FLOW §5 states; ACs AC-07.1…07.6, AC-09.1…09.3, AC-11.1…11.5, AC-12.1…12.4 as seen from the UI). Component tests + MSW (server actions run for real) + axe.
// done_when: "Merge dialog with typed confirmation; contact fields hidden by permission". Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + kit components only; writer may dispute a name via the ruling flow). Types = contracts/openapi/catalog.yaml schemas.
//   components/PanelsList.tsx        PanelsList({panels: Panel[], departments: Department[], permissions})                       SCR-09 list (+ "New panel" dialog)
//   components/PanelDetail.tsx       PanelDetail({panel: Panel, departments, orderables: OrderableSummary[], permissions})       members grid names come from `orderables`
//   components/CommentCodesScreen.tsx CommentCodesScreen({commentCodes: CommentCode[], departments, permissions})                SCR-10
//   components/DoctorsList.tsx       DoctorsList({doctors: DoctorSummary[], permissions})                                         SCR-11 list (+ "New doctor" dialog, search box)
//   components/DoctorVerifyQueue.tsx DoctorVerifyQueue({doctors: DoctorSummary[], possibleDuplicates?: Record<id, DoctorSummary[]>, mergeTargets: DoctorSummary[], permissions})
//   components/DoctorDetail.tsx      DoctorDetail({doctor: Doctor, mergeTargets: DoctorSummary[], permissions})                   edit form + "Merge into…" dialog
//   components/CreditPartiesScreen.tsx CreditPartiesScreen({creditParties: CreditParty[], permissions})                           SCR-12 list + New / Edit dialog
//   pages: app/(staff)/catalog/{panels/page,panels/[panel_id]/page,comment-codes/page,doctors/page,doctors/[doctor_id]/page,doctors/verify/page,credit-parties/page}.tsx
//   Edit/New/Merge are role="dialog"; primary buttons: "Save" (forms), "Merge" (merge dialog), "Verify" (queue/detail row action), panel members "Save members".
//   Row/queue actions that need If-Match fetch the entity with GET /v1/catalog/doctors/{id} (list rows are summaries without `version`).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/catalog/doctors',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000d${String(n).padStart(4, '0')}`;
const TEST_READ = ['catalog.test.read'];
const TEST_MANAGE = ['catalog.test.read', 'catalog.test.manage'];
const REF_READ = ['catalog.referrer.read'];
const REF_MANAGE = ['catalog.referrer.read', 'catalog.referrer.manage'];
const PL_READ = ['catalog.price_list.read'];
const PL_MANAGE = ['catalog.price_list.read', 'catalog.price_list.manage'];
session.permissions = TEST_MANAGE;

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------
const base = (n: number, o: Record<string, unknown>) => ({ id: ID(n), is_active: true, version: 3, ...o });
const DEPTS = [base(1, { code: 'HAEM', name: 'Hematology', report_order: 10 }), base(2, { code: 'BIOC', name: 'Biochemistry', report_order: 20 })];
const panel = (n: number, o: Record<string, unknown> = {}) => base(n, { kind: 'panel', code: 'LIPID', name: 'Lipid profile', department_id: ID(2), department_code: 'BIOC', panel_kind: 'clinical', is_orderable: true, revision: 1, members: [{ kind: 'test', orderable_id: ID(101), sort_order: 1 }, { kind: 'test', orderable_id: ID(102), sort_order: 2 }], ...o });
const PANELS = [
  panel(10),
  panel(11, { code: 'HP_ELITE_M', name: 'Health package elite (male)', panel_kind: 'package', sex_restriction: 'male', department_id: undefined, department_code: undefined, members: [{ kind: 'test', orderable_id: ID(103), sort_order: 1 }, { kind: 'panel', orderable_id: ID(10), sort_order: 2 }, { kind: 'test', orderable_id: ID(104), sort_order: 3 }] }),
  panel(12, { code: 'OLDP', name: 'Retired panel', is_active: false }),
];
const ord = (n: number, o: Record<string, unknown>) => ({ id: ID(n), kind: 'test', is_orderable: true, is_active: true, revision: 1, ...o });
const ORDERABLES = [
  ord(101, { code: 'TC', name: 'Total cholesterol' }), ord(102, { code: 'HDL', name: 'HDL cholesterol' }), ord(103, { code: 'CBC', name: 'Complete blood count' }),
  ord(104, { code: 'FBS', name: 'Fasting blood sugar' }), ord(10, { kind: 'panel', code: 'LIPID', name: 'Lipid profile', panel_kind: 'clinical' }),
  ord(105, { code: 'TG', name: 'Triglycerides' }), ord(106, { code: 'OLDT', name: 'Retired test', is_active: false }),
];
const cc = (n: number, o: Record<string, unknown> = {}) => base(n, { code: 'HYPO', text: 'Hypochromia present.', version: 2, ...o });
const COMMENTS = [cc(20, { department_id: ID(1) }), cc(21, { text: 'Hypochromia (tenant-wide wording).' }), cc(22, { code: 'LONG', text: 'L'.repeat(150), version: 5 }), cc(23, { code: 'OLDC', text: 'Retired comment.', is_active: false })];
const dsum = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), is_verified: true, is_active: true, ...o });
const DOCS = [
  dsum(30, { doctor_code: 'DR00001', display_name: 'Dr Synthetic Alpha', qualification: 'MD' }),
  dsum(31, { doctor_code: 'DR00002', display_name: 'Dr Test Referrer 0007', is_verified: false }),
  dsum(32, { doctor_code: 'DR00012', display_name: 'Dr Synthetic Twelve' }),
  dsum(33, { doctor_code: 'DR00003', display_name: 'Dr Inactive Gamma', is_active: false }),
];
const doctor = (n: number, o: Record<string, unknown> = {}) => base(n, { doctor_code: 'DR00002', display_name: 'Dr Test Referrer 0007', qualification: 'MD', registration_council: 'NMC', registration_no: 'SYN-0007', phone_e164: '+9779800000007', email: 'dr.referrer0007@example.test', notes: 'Synthetic note', is_verified: false, source: 'quick_add', price_list_id: ID(60), version: 4, ...o });
const party = (n: number, o: Record<string, unknown> = {}) => base(n, { party_code: 'CP00001', name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true, pan: 'SYN-PAN-001', contact_phone_e164: '+97714000001', contact_email: 'billing@example.test', billing_address: '1 Synthetic Road', price_list_id: ID(61), version: 2, ...o });
const PARTIES = [party(40), party(41, { party_code: 'CP00002', name: 'Synthetic Affiliate Clinic', kind: 'clinic', allows_credit: false }), party(42, { party_code: 'CP00003', name: 'Retired Co', kind: 'company', is_active: false })];

// ---- MSW --------------------------------------------------------------------------------------------------------------------------------
const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: ['POST', 'PATCH', 'PUT'].includes(r.method) ? await r.clone().json().catch(() => undefined) : undefined }); };
const prob = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const writes = () => calls.filter((c) => c.method !== 'GET' && !/\/doctors\/search$|\/orderables\/resolve$/.test(c.url.pathname));
const RESOLVED = { orderables: [{ orderable_id: ID(10), kind: 'panel', test_ids: [ID(101), ID(102)] }], tests: [{ id: ID(101), code: 'TC', name: 'Total cholesterol', is_active: true, specimen_type_codes: ['SERUM'], container_code: 'RED' }, { id: ID(102), code: 'HDL', name: 'HDL cholesterol', is_active: true, specimen_type_codes: ['SERUM'], container_code: 'RED' }], specimen_requirements: [{ specimen_type_code: 'SERUM', container_code: 'RED', test_ids: [ID(101), ID(102)] }], catalog_revision: 12 };
const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/orderables`, async ({ request }) => { await rec(request); const q = new URL(request.url).searchParams.get('q')!.toLowerCase(); return HttpResponse.json({ data: ORDERABLES.filter((o) => (o.code as string).toLowerCase().startsWith(q) || (o.name as string).toLowerCase().includes(q)), page: { limit: 20 } }); }),
  http.post(`${ORIGIN}/v1/catalog/orderables/resolve`, async ({ request }) => { await rec(request); return HttpResponse.json(RESOLVED); }),
  http.post(`${ORIGIN}/v1/catalog/doctors/search`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [DOCS[0]] }); }),
  http.get(`${ORIGIN}/v1/catalog/doctors/:id`, async ({ request, params }) => { await rec(request); return HttpResponse.json(doctor(31, { id: params.id as string })); }),
  http.get(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); session.permissions = TEST_MANAGE; });
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; });

// ---- helpers ----------------------------------------------------------------------------------------------------------------------------
const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const rowOf = (text: string | RegExp) => screen.getByRole('row', { name: typeof text === 'string' ? new RegExp(`\\b${text}\\b`) : text });
const dialog = () => screen.getByRole('dialog');
const press = async (name: RegExp, root: HTMLElement = document.body) => userEvent.click(within(root).getByRole('button', { name }));
const choose = async (root: HTMLElement, label: RegExp, option: string | RegExp) => { await userEvent.click(within(root).getByLabelText(label)); await userEvent.click(await screen.findByRole('option', { name: option })); };
const text = (root: HTMLElement = document.body) => root.textContent ?? '';
const WORD = /commission/i;

// ================================================================================================================ SCR-09
describe('SCR-09 PanelsList (AC-07.1, 07.2, 07.6)', () => {
  const show = async (panels: unknown[] = PANELS, permissions: string[] = TEST_MANAGE) => { const { PanelsList } = await import('../components/PanelsList'); return wrap(<PanelsList panels={panels as never} departments={DEPTS as never} permissions={permissions} />); };

  it('columns Code · Name · Kind · Sex restriction · Members · Status; kind shown as text; member count; inactive stays readable', async () => {
    await show();
    for (const h of ['Code', 'Name', 'Kind', 'Sex restriction', 'Members', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('LIPID')).getByText('Clinical panel')).toBeTruthy();
    expect(within(rowOf('LIPID')).getByText('2')).toBeTruthy();
    expect(within(rowOf('HP_ELITE_M')).getByText('Package')).toBeTruthy();
    expect(within(rowOf('HP_ELITE_M')).getByText(/^male$/i)).toBeTruthy();
    expect(within(rowOf('HP_ELITE_M')).getByText('3')).toBeTruthy();
    expect(within(rowOf('OLDP')).getByText('Inactive')).toBeTruthy();
  });

  it('empty: exact copy "No panels yet." + "New panel" for managers only', async () => {
    const a = await show([], TEST_MANAGE);
    expect(screen.getByText('No panels yet.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /new panel/i }).length).toBeGreaterThan(0);
    a.unmount();
    await show([], TEST_READ);
    expect(screen.getByText('No panels yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new panel/i })).toBeNull();
  });

  it('read-only (catalog.test.read): table only — no New / Edit controls', async () => {
    await show(PANELS, TEST_READ);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new panel|edit|save/i })).toBeNull();
  });

  it('Kind filter (Clinical panel / Package) filters rows (local or via URL)', async () => {
    await show();
    const opt = [...document.querySelectorAll<HTMLElement>('[role=option],[role=radio],[role=tab],button,label')].find((e) => e.textContent?.trim() === 'Package');
    expect(opt, 'Kind filter control "Package"').toBeTruthy();
    await userEvent.click(opt!);
    const urls = [...push.mock.calls, ...replace.mock.calls].map((c) => decodeURIComponent(String(c[0])));
    if (!urls.some((u) => /panel_kind=package|kind=package/.test(u))) {
      expect(screen.queryByText('Lipid profile')).toBeNull();
      expect(screen.getByText('Health package elite (male)')).toBeTruthy();
    }
  });

  it('New panel → POST /panels: code upper-cased, kind radio, sex restriction + department optional, Idempotency-Key; package copy shown for Package', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/panels`, async ({ request }) => { await rec(request); return HttpResponse.json(panel(13, { code: 'NEWP', name: 'New panel', version: 1 }), { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new panel/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'newp');
    expect((within(dlg).getByLabelText(/^code/i) as HTMLInputElement).value).toBe('NEWP');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'New panel');
    await userEvent.click(within(dlg).getByRole('radio', { name: /package/i }));
    expect(text(dlg)).toContain('Packages are priced as one item. Component prices are not added up.'); // AC-07.6
    await userEvent.click(within(dlg).getByRole('radio', { name: /clinical panel/i }));
    expect(text(dlg)).not.toContain('Component prices are not added up');
    await userEvent.type(within(dlg).getByRole('combobox', { name: /orderable|member|add/i }), 'TC');
    await userEvent.click(await screen.findByRole('option', { name: /Total cholesterol/ }));
    await press(/^save$/i, dlg);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0]!;
    expect(w.method).toBe('POST');
    expect(w.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(w.body).toMatchObject({ code: 'NEWP', name: 'New panel', panel_kind: 'clinical', members: [{ kind: 'test', orderable_id: ID(101), sort_order: expect.any(Number) }] });
    expect(Object.keys(w.body).every((k) => ['code', 'name', 'panel_kind', 'sex_restriction', 'department_id', 'members'].includes(k))).toBe(true);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('duplicate code → catalog.code_duplicate shown inline on the Code field; dialog stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/panels`, () => prob(409, 'catalog.code_duplicate')));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new panel/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'CBC');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Dup');
    await userEvent.type(within(dlg).getByRole('combobox', { name: /orderable|member|add/i }), 'TC');
    await userEvent.click(await screen.findByRole('option', { name: /Total cholesterol/ }));
    await press(/^save$/i, dlg);
    await waitFor(() => expect(within(dlg).getAllByRole('alert').length + dlg.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0));
    expect(dialog()).toBeTruthy();
  });

  it('axe: list + empty', async () => {
    const a = await show();
    await noAxeViolations();
    a.unmount();
    await show([]);
    await noAxeViolations();
  });
});

describe('SCR-09 PanelDetail (members grid, expanded tests, cycle banner — AC-07.1…07.5)', () => {
  const show = async (p: unknown = PANELS[1], permissions: string[] = TEST_MANAGE) => { const { PanelDetail } = await import('../components/PanelDetail'); return wrap(<PanelDetail panel={p as never} departments={DEPTS as never} orderables={ORDERABLES as never} permissions={permissions} />); };
  const memberRows = () => screen.getAllByRole('row').filter((r) => /^(TC|HDL|CBC|FBS|LIPID|TG|OLDT)\b|\b(TC|HDL|CBC|FBS|TG|OLDT)\b.*(Test|Panel)/.test(r.textContent ?? '') && !/columnheader/.test(r.innerHTML));

  it('general: code read-only, kind radio disabled (create only), sex restriction + department shown; member grid resolves names (Order · Kind · Orderable · Name · Status)', async () => {
    await show();
    expect((screen.getByLabelText(/^code/i) as HTMLInputElement).readOnly || (screen.getByLabelText(/^code/i) as HTMLInputElement).disabled).toBe(true);
    for (const r of screen.getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
    for (const h of ['Order', 'Kind', 'Orderable', 'Name', 'Status']) expect(screen.getAllByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }).length).toBeGreaterThan(0);
    expect(screen.getByText('Complete blood count')).toBeTruthy();
    expect(screen.getByText('Lipid profile')).toBeTruthy(); // panel member (nested)
    expect(screen.getByText('Fasting blood sugar')).toBeTruthy();
    expect(text()).toContain('Packages are priced as one item. Component prices are not added up.');
  });

  it('"Expanded tests" panel calls the live preview (POST /orderables/resolve) with the member ids and lists tests once with specimen groups (AC-07.1, 07.2)', async () => {
    await show(PANELS[0]);
    const exp = await screen.findByRole('region', { name: /expanded tests/i });
    await waitFor(() => expect(within(exp).getByText(/Total cholesterol/)).toBeTruthy());
    expect(within(exp).getAllByText(/Total cholesterol/)).toHaveLength(1);
    expect(text(exp)).toMatch(/SERUM/);
    expect(text(exp)).toMatch(/RED/);
    const r = calls.find((c) => c.url.pathname === '/v1/catalog/orderables/resolve')!;
    expect(r.body.orderable_ids).toEqual([ID(101), ID(102)]);
  });

  it('inactive member shows an "Inactive" status and the resolve error catalog.test_inactive is shown as text (AC-07.5)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/orderables/resolve`, () => prob(422, 'catalog.test_inactive')));
    await show(panel(14, { members: [{ kind: 'test', orderable_id: ID(106), sort_order: 1 }] }));
    expect(within(screen.getByRole('row', { name: /OLDT/ })).getByText('Inactive')).toBeTruthy();
    const exp = await screen.findByRole('region', { name: /expanded tests/i });
    await waitFor(() => expect(within(exp).getByRole('alert')).toBeTruthy());
    expect(text(exp)).toMatch(/inactive/i);
  });

  it('adding a member via the orderable combobox (GET /orderables?q=) then "Save members" → PUT /panels/{id}/members with If-Match (AC-07.1)', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/panels/:id/members`, async ({ request }) => { await rec(request); return HttpResponse.json(panel(10, { version: 4 })); }));
    await show(PANELS[0]);
    await userEvent.type(screen.getByRole('combobox', { name: /orderable|member|add/i }), 'TG');
    await userEvent.click(await screen.findByRole('option', { name: /Triglycerides/ }));
    expect(calls.some((c) => c.url.pathname === '/v1/catalog/orderables' && c.url.searchParams.get('q') === 'TG')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /save members/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0]!;
    expect(w.method).toBe('PUT');
    expect(w.url.pathname).toBe(`/v1/catalog/panels/${ID(10)}/members`);
    expect(w.headers.get('if-match')).toBe('"3"');
    expect(w.body.members.map((m: any) => m.orderable_id)).toEqual([ID(101), ID(102), ID(105)]);
    expect(w.body.members.every((m: any) => m.kind === 'test' && Number.isInteger(m.sort_order))).toBe(true);
  });

  it('cycle (AC-07.3): 422 catalog.panel_cycle → banner with the exact copy; membership in the grid is unchanged; no raw detail', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/panels/:id/members`, () => prob(422, 'catalog.panel_cycle', { detail: 'pg: constraint panel_member_no_cycle' })));
    await show(PANELS[0]);
    await userEvent.type(screen.getByRole('combobox', { name: /orderable|member|add/i }), 'CBC');
    await userEvent.click(await screen.findByRole('option', { name: /Complete blood count/ }));
    await userEvent.click(screen.getByRole('button', { name: /save members/i }));
    const banner = await screen.findByText('This would make the panel contain itself (P1 → P2 → P1).');
    expect(banner).toBeTruthy();
    expect(text()).not.toMatch(/panel_member_no_cycle/);
    expect(screen.getByText('Total cholesterol')).toBeTruthy(); // grid still shows the saved members
  });

  it('version conflict (If-Match stale) → common.version_conflict banner; nothing silently overwritten', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/panels/:id/members`, () => prob(409, 'common.version_conflict')));
    await show(PANELS[0]);
    await userEvent.type(screen.getByRole('combobox', { name: /orderable|member|add/i }), 'TG');
    await userEvent.click(await screen.findByRole('option', { name: /Triglycerides/ }));
    await userEvent.click(screen.getByRole('button', { name: /save members/i }));
    expect(await screen.findByText(/changed by someone else|reload|version/i)).toBeTruthy();
  });

  it('max 100 members: with 100 rows the add control is disabled and says so', async () => {
    const members = Array.from({ length: 100 }, (_, i) => ({ kind: 'test', orderable_id: ID(1000 + i), sort_order: i }));
    await show(panel(15, { members }));
    const add = screen.getByRole('combobox', { name: /orderable|member|add/i }) as HTMLInputElement;
    expect(add.disabled || add.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(text()).toMatch(/100/);
  });

  it('removing a member row drops it from the PUT body; the last member cannot be removed (API needs ≥1)', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/panels/:id/members`, async ({ request }) => { await rec(request); return HttpResponse.json(panel(10, { version: 4 })); }));
    await show(PANELS[0]);
    await userEvent.click(within(screen.getByRole('row', { name: /\bHDL\b/ })).getByRole('button', { name: /remove/i }));
    await userEvent.click(screen.getByRole('button', { name: /save members/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.members.map((m: any) => m.orderable_id)).toEqual([ID(101)]);
    cleanup();
    await show(panel(16, { members: [{ kind: 'test', orderable_id: ID(101), sort_order: 1 }] }));
    const rm = screen.queryByRole('button', { name: /remove/i }) as HTMLButtonElement | null;
    expect(rm === null || rm.disabled || rm.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('General save → PATCH with If-Match, only changed fields; clearing the sex restriction sends unset', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/panels/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(panel(11, { version: 4 })); }));
    await show(PANELS[1]);
    await choose(document.body, /sex restriction/i, /^none$|^any$|no restriction/i);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.method).toBe('PATCH');
    expect(writes()[0]!.headers.get('if-match')).toBe('"3"');
    expect(writes()[0]!.body).toEqual({ unset: ['sex_restriction'] });
  });

  it('read-only (catalog.test.read): no Save, no Remove, no add combobox, no inputs that look editable', async () => {
    await show(PANELS[0], TEST_READ);
    expect(screen.queryByRole('button', { name: /save|remove/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /orderable|member|add/i })).toBeNull();
    expect(screen.getByText('Total cholesterol')).toBeTruthy();
  });

  it('axe', async () => { await show(); await noAxeViolations(); });
});

// ================================================================================================================ SCR-10
describe('SCR-10 CommentCodesScreen (AC-09.1…09.3)', () => {
  const show = async (items: unknown[] = COMMENTS, permissions: string[] = TEST_MANAGE) => { const { CommentCodesScreen } = await import('../components/CommentCodesScreen'); return wrap(<CommentCodesScreen commentCodes={items as never} departments={DEPTS as never} permissions={permissions} />); };

  it('columns Code · Department · Text · Status · Version; blank department → "All departments"; same code may exist per department and tenant-wide (AC-09.1)', async () => {
    await show();
    for (const h of ['Code', 'Department', 'Text', 'Status', 'Version']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    const hypo = screen.getAllByRole('row', { name: /\bHYPO\b/ });
    expect(hypo).toHaveLength(2);
    expect(hypo.some((r) => /Hematology/.test(r.textContent!))).toBe(true);
    expect(hypo.some((r) => /All departments/.test(r.textContent!))).toBe(true);
    expect(within(rowOf('OLDC')).getByText('Inactive')).toBeTruthy();
    expect(within(rowOf('LONG')).getByText('5')).toBeTruthy(); // version
  });

  it('text column shows the first 80 characters only', async () => {
    await show();
    const cell = within(rowOf('LONG')).getByText(/^L{20,}/);
    expect(cell.textContent!.startsWith('L'.repeat(80))).toBe(true);
    expect(cell.textContent!.replace(/[….]+$/, '').length).toBeLessThanOrEqual(80);
    expect(cell.textContent).not.toContain('L'.repeat(81));
  });

  it('empty copy "No comment codes for this department."; read-only hides New / Edit', async () => {
    const a = await show([], TEST_MANAGE);
    expect(screen.getByText('No comment codes for this department.')).toBeTruthy();
    a.unmount();
    await show(COMMENTS, TEST_READ);
    expect(screen.queryByRole('button', { name: /new comment code|edit/i })).toBeNull();
  });

  it('code-prefix search filters rows (case-insensitive)', async () => {
    await show();
    await userEvent.type(screen.getByLabelText(/search/i), 'lo');
    expect(screen.queryAllByRole('row', { name: /\bHYPO\b/ })).toHaveLength(0);
    expect(screen.getByRole('row', { name: /\bLONG\b/ })).toBeTruthy();
  });

  it('New → POST /comment-codes: code upper-cased, optional department, text; help text about ":CODE" and saved results (exact copy); Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/comment-codes`, async ({ request }) => { await rec(request); return HttpResponse.json(cc(24, { code: 'MACRO', version: 1 }), { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new comment code/i })[0]!);
    const dlg = dialog();
    expect(text(dlg)).toContain('Technologists type :CODE followed by a space in the result comment to insert this text. Changing the text later does not change results already saved.');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'macro');
    expect((within(dlg).getByLabelText(/^code/i) as HTMLInputElement).value).toBe('MACRO');
    await userEvent.type(within(dlg).getByLabelText(/^text/i), 'Macrocytes seen.');
    await choose(dlg, /department/i, 'Hematology');
    await press(/^save$/i, dlg);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(writes()[0]!.body).toEqual({ code: 'MACRO', department_id: ID(1), text: 'Macrocytes seen.' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('validation: code with illegal chars / >16 chars or empty text blocks the request (no network)', async () => {
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new comment code/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'BAD-CODE!');
    await userEvent.type(within(dlg).getByLabelText(/^text/i), 'x');
    await press(/^save$/i, dlg);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
    expect(dlg.querySelectorAll('[aria-invalid="true"]').length + within(dlg).queryAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('duplicate code (409 catalog.code_duplicate) → inline on Code; dialog stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/comment-codes`, () => prob(409, 'catalog.code_duplicate')));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new comment code/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'HYPO');
    await userEvent.type(within(dlg).getByLabelText(/^text/i), 'x');
    await press(/^save$/i, dlg);
    await waitFor(() => expect(within(dlg).getAllByRole('alert').length + dlg.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0));
    expect(dialog()).toBeTruthy();
  });

  it('Edit text → PATCH with If-Match = row version (AC-09.3 version bump is server-side); code is read-only; only changed fields sent', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/comment-codes/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(cc(22, { code: 'LONG', version: 6 })); }));
    await show();
    await userEvent.click(within(rowOf('LONG')).getByRole('button', { name: /edit/i }));
    const dlg = dialog();
    const code = within(dlg).getByLabelText(/^code/i) as HTMLInputElement;
    expect(code.readOnly || code.disabled).toBe(true);
    const t = within(dlg).getByLabelText(/^text/i);
    await userEvent.clear(t);
    await userEvent.type(t, 'Revised wording.');
    await press(/^save$/i, dlg);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.method).toBe('PATCH');
    expect(writes()[0]!.headers.get('if-match')).toBe('"5"');
    expect(writes()[0]!.body).toEqual({ text: 'Revised wording.' });
  });

  it('stale version → common.version_conflict banner in the dialog', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/comment-codes/:id`, () => prob(409, 'common.version_conflict')));
    await show();
    await userEvent.click(within(rowOf('LONG')).getByRole('button', { name: /edit/i }));
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^text/i), '!');
    await press(/^save$/i, dlg);
    expect(await within(dlg).findByText(/changed by someone else|reload|version/i)).toBeTruthy();
  });

  it('text is rendered as text (XSS) and never contains "commission"', async () => {
    await show([cc(25, { code: 'XSS', text: '<img src=x onerror=alert(1)>' })]);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeTruthy();
    expect(text()).not.toMatch(WORD);
  });

  it('axe', async () => { await show(); await noAxeViolations(); });
});

// ================================================================================================================ SCR-11
describe('SCR-11 DoctorsList (AC-11.1, 11.2, 11.4)', () => {
  const show = async (doctors: unknown[] = DOCS, permissions: string[] = REF_MANAGE) => { const { DoctorsList } = await import('../components/DoctorsList'); return wrap(<DoctorsList doctors={doctors as never} permissions={permissions} />); };

  it('columns Code · Name · Qualification · Verified · Status; verified is a text badge (Verified / Unverified); inactive stays readable', async () => {
    await show();
    for (const h of ['Code', 'Name', 'Qualification', 'Verified', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('DR00001')).getByText('Verified')).toBeTruthy();
    expect(within(rowOf('DR00002')).getByText('Unverified')).toBeTruthy();
    expect(within(rowOf('DR00003')).getByText('Inactive')).toBeTruthy();
  });

  it('empty: exact copy "No doctors yet."', async () => {
    await show([]);
    expect(screen.getByText('No doctors yet.')).toBeTruthy();
  });

  it('list never shows phone/email (summaries carry none; even if a row object has them they are not rendered — AC-11.4)', async () => {
    await show([{ ...DOCS[0], phone_e164: '+9779800000001', email: 'leak@example.test' }]);
    expect(text()).not.toMatch(/\+9779800000001|leak@example\.test/);
  });

  it('search posts to /doctors/search with the query in the BODY; the name is never in any URL (D-C3-06)', async () => {
    await show();
    const box = screen.getByRole('searchbox', { name: /search/i });
    await userEvent.type(box, 'Referrer 0007{Enter}');
    await waitFor(() => expect(calls.some((c) => c.url.pathname === '/v1/catalog/doctors/search')).toBe(true));
    const s = calls.find((c) => c.url.pathname === '/v1/catalog/doctors/search')!;
    expect(s.method).toBe('POST');
    expect(s.body.q).toBe('Referrer 0007');
    expect(calls.every((c) => !/Referrer/i.test(decodeURIComponent(c.url.href)))).toBe(true);
    expect([...push.mock.calls, ...replace.mock.calls].every((c) => !/Referrer/i.test(decodeURIComponent(String(c[0]))))).toBe(true);
  });

  it('Verified filter "Unverified" → URL param is_verified=false or local filter; Source filter exists (Back office / Quick add / Import)', async () => {
    await show();
    const ctl = (n: string) => [...document.querySelectorAll<HTMLElement>('[role=option],[role=radio],[role=tab],button,label')].find((e) => e.textContent?.trim() === n);
    expect(ctl('Unverified')).toBeTruthy();
    await userEvent.click(ctl('Unverified')!);
    const urls = [...push.mock.calls, ...replace.mock.calls].map((c) => decodeURIComponent(String(c[0])));
    if (!urls.some((u) => /is_verified=false/.test(u))) expect(screen.queryByText('Dr Synthetic Alpha')).toBeNull();
    for (const s of ['Quick add', 'Back office', 'Import']) expect(text(), `Source option ${s}`).toContain(s);
  });

  it('New doctor (back office): POST /doctors with display name + phone only, Idempotency-Key; code left blank = auto; no is_verified/source from the client (AC-11.1)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/doctors`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...doctor(34, { doctor_code: 'DR00007', version: 1 }), possible_duplicate_of: [] }, { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new doctor/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/display name/i), 'Dr Test Referrer 0007');
    await userEvent.type(within(dlg).getByLabelText(/^phone/i), '+9779800000007');
    await press(/^save$/i, dlg);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0]!;
    expect(w.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(w.body).toEqual({ display_name: 'Dr Test Referrer 0007', phone_e164: '+9779800000007' });
  });

  it('possible duplicates (201 + possible_duplicate_of) → NOT an error: the UI names the existing doctor(s) and offers to open them (AC-11.2)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/doctors`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...doctor(35, { doctor_code: 'DR00008', version: 1 }), possible_duplicate_of: [DOCS[1]] }, { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new doctor/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/display name/i), 'Dr Test Referrer 0007');
    await userEvent.type(within(dlg).getByLabelText(/^phone/i), '+9779800000007');
    await press(/^save$/i, dlg);
    const note = await screen.findByText(/possible duplicate|already exists|same name/i);
    expect(note).toBeTruthy();
    expect(text()).toMatch(/DR00002/);
    expect(screen.queryAllByRole('alert').filter((a) => /error|failed|duplicate_code/i.test(a.textContent ?? '')).length).toBe(0);
    expect(screen.getAllByRole('link', { name: /DR00002|Dr Test Referrer 0007/ })[0]!.getAttribute('href')).toContain(ID(31));
  });

  it('phone must be E.164 (+977…): "9841234567" shows an inline error and sends nothing; display name is required', async () => {
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new doctor/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/display name/i), 'Dr A');
    await userEvent.type(within(dlg).getByLabelText(/^phone/i), '9841234567');
    await press(/^save$/i, dlg);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
    expect(dlg.querySelectorAll('[aria-invalid="true"]').length + within(dlg).queryAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('without catalog.referrer.manage: no "New doctor" button (read-only list)', async () => {
    await show(DOCS, REF_READ);
    expect(screen.queryByRole('button', { name: /new doctor/i })).toBeNull();
  });

  it('axe', async () => { await show(); await noAxeViolations(); });
});

describe('SCR-11 DoctorVerifyQueue', () => {
  const show = async (doctors: unknown[] = [DOCS[1]], o: Record<string, unknown> = {}) => {
    const { DoctorVerifyQueue } = await import('../components/DoctorVerifyQueue');
    return wrap(<DoctorVerifyQueue doctors={doctors as never} possibleDuplicates={{ [ID(31)]: [DOCS[0]] } as never} mergeTargets={DOCS as never} permissions={REF_MANAGE} {...(o as object)} />);
  };

  it('lists unverified doctors with their possible duplicates under the row; actions Verify · Merge into… · Edit', async () => {
    await show();
    const row = rowOf('DR00002');
    expect(text(row.closest('table')!.parentElement!)).toContain('Dr Synthetic Alpha'); // duplicate listed with the row
    for (const n of [/^verify$/i, /merge into/i, /^edit$|open/i]) expect(within(row).getAllByRole('button', { name: n }).length + within(row).queryAllByRole('link', { name: n }).length).toBeGreaterThan(0);
  });

  it('empty: exact copy "No doctors waiting for verification."', async () => {
    await show([]);
    expect(screen.getByText('No doctors waiting for verification.')).toBeTruthy();
  });

  it('Verify → loads the doctor for its version, then POST /doctors/{id}/verify with If-Match = that version; list refreshes', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/doctors/:id/verify`, async ({ request }) => { await rec(request); return HttpResponse.json(doctor(31, { is_verified: true, version: 5 })); }));
    await show();
    await userEvent.click(within(rowOf('DR00002')).getByRole('button', { name: /^verify$/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.url.pathname).toBe(`/v1/catalog/doctors/${ID(31)}/verify`);
    expect(writes()[0]!.headers.get('if-match')).toBe('"4"'); // version served by GET /doctors/{id}
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Verify with a stale version shows the conflict banner and does not claim success', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/doctors/:id/verify`, () => prob(409, 'common.version_conflict')));
    await show();
    await userEvent.click(within(rowOf('DR00002')).getByRole('button', { name: /^verify$/i }));
    expect(await screen.findByText(/changed by someone else|reload|version/i)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('without catalog.referrer.manage there are no Verify / Merge / Edit actions', async () => {
    await show([DOCS[1]], { permissions: REF_READ });
    expect(screen.queryByRole('button', { name: /^verify$|merge into|^edit$/i })).toBeNull();
  });
});

describe('SCR-11 DoctorDetail — contact fields hidden by permission (done_when; AC-11.4, S-11)', () => {
  const show = async (d: unknown = doctor(31), permissions: string[] = REF_MANAGE, targets: unknown[] = DOCS) => { const { DoctorDetail } = await import('../components/DoctorDetail'); return wrap(<DoctorDetail doctor={d as never} mergeTargets={targets as never} permissions={permissions} />); };

  it('with catalog.referrer.manage: Phone + Email shown and editable; all form fields present; Price list is a read-only link to SCR-13', async () => {
    await show();
    expect((screen.getByLabelText(/^phone/i) as HTMLInputElement).value).toBe('+9779800000007');
    expect((screen.getByLabelText(/^email/i) as HTMLInputElement).value).toBe('dr.referrer0007@example.test');
    for (const l of [/doctor code/i, /display name/i, /qualification/i, /registration council/i, /registration no/i, /notes/i]) expect(screen.getByLabelText(l)).toBeTruthy();
    expect(screen.getByRole('link', { name: /price list/i }).getAttribute('href')).toBe(`/catalog/price-lists/${ID(60)}`);
  });

  it('WITHOUT catalog.referrer.manage: no Phone / Email field, label or value anywhere in the DOM — even if the object carries them (defence in depth)', async () => {
    await show(doctor(31), REF_READ);
    expect(screen.queryByLabelText(/^phone/i)).toBeNull();
    expect(screen.queryByLabelText(/^email/i)).toBeNull();
    expect(text()).not.toMatch(/\+9779800000007|dr\.referrer0007@example\.test/);
    expect(document.querySelector('input[value*="9779800000007"], input[value*="example.test"]')).toBeNull();
    // non-contact data stays readable
    expect(text()).toMatch(/Dr Test Referrer 0007/);
    expect(text()).toMatch(/DR00002/);
  });

  it('without manage the form is read-only: no Save / Verify / Merge buttons, no editable inputs', async () => {
    await show(doctor(31), REF_READ);
    expect(screen.queryByRole('button', { name: /^save$|^verify$|merge into/i })).toBeNull();
    for (const i of document.querySelectorAll<HTMLInputElement>('input,textarea')) expect(i.readOnly || i.disabled, i.name).toBe(true);
  });

  it('the API response without contact fields (what the server sends to non-managers) renders cleanly', async () => {
    const { phone_e164, email, ...noContact } = doctor(31) as Record<string, unknown>;
    await show(noContact, REF_READ);
    expect(text()).toMatch(/DR00002/);
  });

  it('Save → PATCH with If-Match and only changed fields; clearing Qualification sends unset:["qualification"]', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/doctors/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(doctor(31, { version: 5 })); }));
    await show();
    await userEvent.clear(screen.getByLabelText(/qualification/i));
    await userEvent.clear(screen.getByLabelText(/display name/i));
    await userEvent.type(screen.getByLabelText(/display name/i), 'Dr Test Referrer 0007 MD');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.method).toBe('PATCH');
    expect(writes()[0]!.headers.get('if-match')).toBe('"4"');
    expect(writes()[0]!.body).toEqual({ display_name: 'Dr Test Referrer 0007 MD', unset: ['qualification'] });
  });

  it('invalid email / phone / name length are rejected inline without a request', async () => {
    await show();
    const email = screen.getByLabelText(/^email/i);
    await userEvent.clear(email);
    await userEvent.type(email, 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
    expect(document.querySelectorAll('[aria-invalid="true"]').length + screen.queryAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('a merged-away (inactive) doctor says which doctor it was merged into and offers no Merge / Verify', async () => {
    await show(doctor(33, { doctor_code: 'DR00003', is_active: false, merged_into_id: ID(32) }));
    expect(text()).toMatch(/merged into/i);
    expect(screen.getAllByRole('link').some((l) => (l.getAttribute('href') ?? '').includes(ID(32)))).toBe(true);
    expect(screen.queryByRole('button', { name: /merge into/i })).toBeNull();
  });

  it('axe: manager and read-only', async () => {
    const a = await show();
    await noAxeViolations();
    a.unmount();
    await show(doctor(31), REF_READ);
    await noAxeViolations();
  });
});

describe('SCR-11 merge dialog with typed confirmation (done_when; AC-11.3)', () => {
  const MERGE_OK = () => http.post(`${ORIGIN}/v1/catalog/doctors/:id/merge`, async ({ request }) => { await rec(request); return HttpResponse.json(doctor(31, { is_active: false, merged_into_id: ID(32), version: 5 })); });
  const open = async (permissions: string[] = REF_MANAGE) => {
    const { DoctorDetail } = await import('../components/DoctorDetail');
    wrap(<DoctorDetail doctor={doctor(31) as never} mergeTargets={[...DOCS, dsum(36, { doctor_code: 'DR00009', display_name: 'Dr Source Twin' })] as never} permissions={permissions} />);
    await userEvent.click(screen.getByRole('button', { name: /merge into/i }));
    return dialog();
  };
  const pickTarget = async (dlg: HTMLElement, name: string | RegExp = /DR00012/) => { await userEvent.click(within(dlg).getByRole('combobox', { name: /target|merge into|doctor/i })); await userEvent.click(await screen.findByRole('option', { name })); };
  const confirmField = (dlg: HTMLElement) => within(dlg).getByLabelText(/type .*DR00002|confirm/i) as HTMLInputElement;
  const mergeBtn = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: /^merge$/i }) as HTMLButtonElement;
  const disabled = (b: HTMLButtonElement) => b.disabled || b.getAttribute('aria-disabled') === 'true';

  it('only holders of catalog.referrer.manage see "Merge into…"', async () => {
    const { DoctorDetail } = await import('../components/DoctorDetail');
    wrap(<DoctorDetail doctor={doctor(31) as never} mergeTargets={DOCS as never} permissions={REF_READ} />);
    expect(screen.queryByRole('button', { name: /merge into/i })).toBeNull();
  });

  it('target list = verified, ACTIVE doctors other than the source (unverified, inactive and self are not offered)', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('combobox', { name: /target|merge into|doctor/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names.some((n) => /DR00012/.test(n))).toBe(true);
    expect(names.some((n) => /DR00001/.test(n))).toBe(true);
    expect(names.some((n) => /DR00002/.test(n))).toBe(false); // the source itself (and it is unverified)
    expect(names.some((n) => /DR00003/.test(n))).toBe(false); // inactive
  });

  it('typed confirmation of the SOURCE code: Merge stays disabled until a target is chosen AND the exact source code is typed', async () => {
    const dlg = await open();
    expect(disabled(mergeBtn(dlg))).toBe(true);
    await userEvent.type(confirmField(dlg), 'DR00002');
    expect(disabled(mergeBtn(dlg))).toBe(true); // no target yet
    await pickTarget(dlg);
    expect(disabled(mergeBtn(dlg))).toBe(false);
    await userEvent.clear(confirmField(dlg));
    await userEvent.type(confirmField(dlg), 'DR0000');
    expect(disabled(mergeBtn(dlg))).toBe(true); // partial
    await userEvent.clear(confirmField(dlg));
    await userEvent.type(confirmField(dlg), 'DR00012');
    expect(disabled(mergeBtn(dlg))).toBe(true); // the TARGET code is not the confirmation
    await userEvent.clear(confirmField(dlg));
    await userEvent.type(confirmField(dlg), 'DR00002 ');
    expect(disabled(mergeBtn(dlg))).toBe(true); // trailing junk
    expect(writes()).toHaveLength(0);
  });

  it('copy: "Past orders keep the original doctor. Reports and analytics will show <target>."', async () => {
    const dlg = await open();
    await pickTarget(dlg);
    expect(text(dlg)).toContain('Past orders keep the original doctor.');
    expect(text(dlg)).toMatch(/Reports and analytics will show[^.]*Dr Synthetic Twelve/);
  });

  it('submit → POST /doctors/{source}/merge: If-Match = source version, Idempotency-Key, body exactly {into_doctor_id}; toast "Merged into DR00012"; dialog closes; list refreshes', async () => {
    api.use(MERGE_OK());
    const dlg = await open();
    await pickTarget(dlg);
    await userEvent.type(confirmField(dlg), 'DR00002');
    await userEvent.click(mergeBtn(dlg));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0]!;
    expect(w.method).toBe('POST');
    expect(w.url.pathname).toBe(`/v1/catalog/doctors/${ID(31)}/merge`);
    expect(w.headers.get('if-match')).toBe('"4"');
    expect(w.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(w.body).toEqual({ into_doctor_id: ID(32) });
    expect(await screen.findByText(/Merged into DR00012/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it('double-click on Merge sends ONE request (race / double submit)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/doctors/:id/merge`, async ({ request }) => { await rec(request); await new Promise((r) => setTimeout(r, 100)); return HttpResponse.json(doctor(31, { is_active: false, merged_into_id: ID(32), version: 5 })); }));
    const dlg = await open();
    await pickTarget(dlg);
    await userEvent.type(confirmField(dlg), 'DR00002');
    await userEvent.dblClick(mergeBtn(dlg));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes()).toHaveLength(1);
  });

  it('validation error (422 common.validation_failed, e.g. target already merged) → inline in the dialog, dialog stays open, nothing claims success', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/doctors/:id/merge`, () => prob(422, 'common.validation_failed', { detail: 'pg: fk violation doctor_merge_target' })));
    const dlg = await open();
    await pickTarget(dlg);
    await userEvent.type(confirmField(dlg), 'DR00002');
    await userEvent.click(mergeBtn(dlg));
    await waitFor(() => expect(within(dlg).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(text(dlg)).not.toMatch(/fk violation|doctor_merge_target/);
    expect(screen.queryByText(/Merged into/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stale version (409 common.version_conflict) → conflict banner; retry after a failure re-uses the SAME Idempotency-Key (once per open)', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/catalog/doctors/:id/merge`, async ({ request }) => { await rec(request); n += 1; return n === 1 ? prob(409, 'common.version_conflict') : HttpResponse.json(doctor(31, { is_active: false, merged_into_id: ID(32), version: 5 })); }));
    const dlg = await open();
    await pickTarget(dlg);
    await userEvent.type(confirmField(dlg), 'DR00002');
    await userEvent.click(mergeBtn(dlg));
    expect(await within(dlg).findByText(/changed by someone else|reload|version/i)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(mergeBtn(dlg)); // retry within the same open dialog
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]!.headers.get('idempotency-key')).toBe(writes()[0]!.headers.get('idempotency-key'));
  });

  it('Esc / Cancel closes without any request; reopening starts with an empty confirmation and no target', async () => {
    const dlg = await open();
    await userEvent.type(confirmField(dlg), 'DR00002');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: /merge into/i }));
    expect(confirmField(dialog()).value).toBe('');
    expect(disabled(mergeBtn(dialog()))).toBe(true);
  });

  it('merge from the verify queue uses the same dialog: typed confirmation of that row\'s code, If-Match from GET /doctors/{id}', async () => {
    api.use(MERGE_OK());
    const { DoctorVerifyQueue } = await import('../components/DoctorVerifyQueue');
    wrap(<DoctorVerifyQueue doctors={[DOCS[1]] as never} mergeTargets={DOCS as never} permissions={REF_MANAGE} />);
    await userEvent.click(within(rowOf('DR00002')).getByRole('button', { name: /merge into/i }));
    const dlg = dialog();
    await pickTarget(dlg);
    await userEvent.type(confirmField(dlg), 'DR00002');
    await userEvent.click(mergeBtn(dlg));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.headers.get('if-match')).toBe('"4"');
    expect(writes()[0]!.body).toEqual({ into_doctor_id: ID(32) });
  });

  it('axe: open merge dialog', async () => { const dlg = await open(); await pickTarget(dlg); await noAxeViolations(); });
});

// ================================================================================================================ SCR-12
describe('SCR-12 CreditPartiesScreen (AC-12.1…12.4)', () => {
  const show = async (items: unknown[] = PARTIES, permissions: string[] = PL_MANAGE) => { const { CreditPartiesScreen } = await import('../components/CreditPartiesScreen'); return wrap(<CreditPartiesScreen creditParties={items as never} permissions={permissions} />); };

  it('columns Code · Name · Kind · Credit allowed · Price list · Status; Credit allowed is Yes/No text (AC-12.2); inactive readable', async () => {
    await show();
    for (const h of ['Code', 'Name', 'Kind', 'Credit allowed', 'Price list', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('CP00001')).getByText('Yes')).toBeTruthy();
    expect(within(rowOf('CP00001')).getByText('Hospital')).toBeTruthy();
    expect(within(rowOf('CP00002')).getByText('No')).toBeTruthy();
    expect(within(rowOf('CP00003')).getByText('Inactive')).toBeTruthy();
  });

  it('empty copy "No credit parties or affiliations yet."; the Billing note is always present', async () => {
    await show([]);
    expect(screen.getByText('No credit parties or affiliations yet.')).toBeTruthy();
    expect(text()).toContain('Credit limits, credit days and monthly statements are managed in Billing.');
  });

  it('AC-12.3: no credit limit / credit days / balance column or field exists in C3 (even in the editor)', async () => {
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new credit party|new affiliation|new/i })[0]!);
    expect(text(dialog())).not.toMatch(/credit limit|credit days|outstanding|balance/i);
    expect(screen.queryByLabelText(/credit limit|credit days|balance/i)).toBeNull();
  });

  it('AC-12.4: with catalog.price_list.read only — PAN, phone, email and billing address are absent (labels AND values), even if the object carries them; no New/Edit', async () => {
    await show(PARTIES, PL_READ);
    expect(text()).not.toMatch(/SYN-PAN-001|\+97714000001|billing@example\.test|1 Synthetic Road/);
    for (const h of [/^pan/i, /phone/i, /email/i, /billing address/i]) expect(screen.queryByRole('columnheader', { name: h })).toBeNull();
    expect(screen.queryByRole('button', { name: /new|edit/i })).toBeNull();
    expect(screen.getByRole('row', { name: /CP00001/ })).toBeTruthy();
  });

  it('New (finance, price_list.manage): blank party code → body has NO party_code (server assigns CP{seq:5}); name, kind Hospital, allows_credit true; Idempotency-Key (AC-12.1)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/credit-parties`, async ({ request }) => { await rec(request); return HttpResponse.json(party(43, { party_code: 'CP00004', name: 'Synthetic General Hospital', version: 1 }), { status: 201 }); }));
    await show([]);
    await userEvent.click(screen.getAllByRole('button', { name: /new/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Synthetic General Hospital');
    await choose(dlg, /^kind/i, 'Hospital');
    const sw = within(dlg).getByRole('switch', { name: /credit allowed/i }) as HTMLInputElement;
    if (!sw.checked) await userEvent.click(sw);
    await press(/^save$/i, dlg);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0]!;
    expect(w.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(w.body).toEqual({ name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('editor copy: Kind options (Hospital, Company, Clinic, Partner lab, Insurer, Other); Credit allowed help text exact; PAN/phone/email/address fields present for managers', async () => {
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new/i })[0]!);
    const dlg = dialog();
    expect(text(dlg)).toContain('Off = affiliation with its own prices; patients still pay at the counter');
    for (const l of [/party code/i, /^pan/i, /^phone/i, /^email/i, /billing address/i]) expect(within(dlg).getByLabelText(l)).toBeTruthy();
    await userEvent.click(within(dlg).getByLabelText(/^kind/i));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(opts).toEqual(['Hospital', 'Company', 'Clinic', 'Partner lab', 'Insurer', 'Other']);
  });

  it('party code is upper-cased as typed; duplicate (409 catalog.code_duplicate) shows inline on Party code', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/credit-parties`, () => prob(409, 'catalog.code_duplicate')));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new/i })[0]!);
    const dlg = dialog();
    const code = within(dlg).getByLabelText(/party code/i) as HTMLInputElement;
    await userEvent.type(code, 'cp00001');
    expect(code.value).toBe('CP00001');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Dup');
    await choose(dlg, /^kind/i, 'Company');
    await press(/^save$/i, dlg);
    await waitFor(() => expect(within(dlg).getAllByRole('alert').length + dlg.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0));
    expect(dialog()).toBeTruthy();
  });

  it('validation: invalid phone (not +E.164), invalid email, PAN > 20 → no request', async () => {
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Bad data Co');
    await choose(dlg, /^kind/i, 'Company');
    await userEvent.type(within(dlg).getByLabelText(/^phone/i), '014444444');
    await userEvent.type(within(dlg).getByLabelText(/^email/i), 'nope');
    await press(/^save$/i, dlg);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(0);
    expect(dlg.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThanOrEqual(2);
  });

  it('Edit → PATCH with If-Match = row version and only changed fields; party code read-only; switching Credit allowed off sends allows_credit:false (AC-12.2)', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/credit-parties/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(party(40, { allows_credit: false, version: 3 })); }));
    await show();
    await userEvent.click(within(rowOf('CP00001')).getByRole('button', { name: /edit/i }));
    const dlg = dialog();
    const code = within(dlg).getByLabelText(/party code/i) as HTMLInputElement;
    expect(code.readOnly || code.disabled).toBe(true);
    expect((within(dlg).getByLabelText(/^pan/i) as HTMLInputElement).value).toBe('SYN-PAN-001');
    await userEvent.click(within(dlg).getByRole('switch', { name: /credit allowed/i }));
    await press(/^save$/i, dlg);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.method).toBe('PATCH');
    expect(writes()[0]!.headers.get('if-match')).toBe('"2"');
    expect(writes()[0]!.body).toEqual({ allows_credit: false });
  });

  it('403 auth.mfa_required (privileged price_list.manage at aal1) is shown as a step-up message, not a generic crash', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/credit-parties`, () => prob(403, 'auth.mfa_required')));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new/i })[0]!);
    const dlg = dialog();
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'MFA Co');
    await choose(dlg, /^kind/i, 'Company');
    await press(/^save$/i, dlg);
    expect(await within(dlg).findByText(/verify|multi-factor|second factor|mfa|step.?up/i)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('text is rendered as text (XSS); no "commission" wording anywhere on the screen (AC-11.5)', async () => {
    await show([party(44, { party_code: 'XSS', name: '<script>alert(1)</script>' })]);
    expect(document.querySelector('script')).toBeNull();
    expect(text()).not.toMatch(WORD);
  });

  it('axe: list (manager) and list (read-only)', async () => {
    const a = await show();
    await noAxeViolations();
    a.unmount();
    await show(PARTIES, PL_READ);
    await noAxeViolations();
  });
});

// ================================================================================================================ cross-cutting
describe('no access token or commission wording leaks into any SCR-09…12 screen', () => {
  it('rendered DOM of every screen contains neither the bearer token nor the word "commission"', async () => {
    const { PanelsList } = await import('../components/PanelsList');
    const { CommentCodesScreen } = await import('../components/CommentCodesScreen');
    const { DoctorsList } = await import('../components/DoctorsList');
    const { CreditPartiesScreen } = await import('../components/CreditPartiesScreen');
    wrap(<><PanelsList panels={PANELS as never} departments={DEPTS as never} permissions={TEST_MANAGE} /><CommentCodesScreen commentCodes={COMMENTS as never} departments={DEPTS as never} permissions={TEST_MANAGE} /><DoctorsList doctors={DOCS as never} permissions={REF_MANAGE} /><CreditPartiesScreen creditParties={PARTIES as never} permissions={PL_MANAGE} /></>);
    expect(document.documentElement.innerHTML).not.toMatch(/jwt-synthetic/);
    expect(document.documentElement.innerHTML).not.toMatch(WORD);
  });
});
