// @vitest-environment jsdom
// T0D-CATTESTS-1 — Catalog Tests page (SCR-06 list): header + New test, search, filters, always-drawn column headers, 25 rows per page,
// address-bar state, one working creation form (LD-310; lead walkthrough 2026-11-17 05:18 NPT: staging showed only "No tests yet.").
// Synthetic data only. The page is rendered through its default export (async server component) with MSW standing in for the API,
// so the tests do not depend on component or file names; only on the page, the kit and these CONTRACT points:
//   address bar : q, department_id, specimen_type_id, is_active (true|false; absent = All). Paging param is free but must survive filters.
//   API         : GET /v1/catalog/tests accepts ONLY department_id, workflow_type, is_active, sort, cursor, limit (TRD #23; unknown key = 422).
//                 So q and specimen_type_id are NEVER sent to it. Search = name/code; the specimen filter resolves through test detail
//                 (GET /v1/catalog/tests/{id}.specimen_requirements) because OrderableSummary carries no specimen. No contract change.
//   create form : role=dialog "New test" opened by the header button, the empty-state button and ?new=1 (same form); fields Code, Name,
//                 Department, Workflow type, Specimen type; POST /v1/catalog/tests with Idempotency-Key; success -> push /catalog/tests/{id}.
//   permissions : catalog.test.read sees the list; catalog.test.manage may create (otherwise button disabled/absent + a visible reason).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

const navLog: string[] = [];
const push = vi.fn((u: string) => { navLog.push(String(u)); });
const replace = vi.fn((u: string) => { navLog.push(String(u)); });
const refresh = vi.fn();
const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/catalog/tests',
  useSearchParams: () => new URLSearchParams(nav.search),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog/tests',
}));
const used = vi.hoisted(() => new Set<string>());
vi.mock('@/core/i18n/messages', async (orig) => {
  const a = await orig<typeof import('@/core/i18n/messages')>();
  return { ...a, t: (k: string) => { used.add(k); return a.t(k); } };
});

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000e${String(n).padStart(4, '0')}`;
const READ = ['catalog.test.read'];
const MANAGE = ['catalog.test.read', 'catalog.test.manage'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const dept = (n: number, code: string, name: string, o: Record<string, unknown> = {}) => ({ id: ID(n), code, name, report_order: n * 10, is_active: true, version: 1, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-06T09:30:00.000Z', ...o });
const HAEM = dept(1, 'HAEM', 'Hematology');
const BIOC = dept(2, 'BIOC', 'Biochemistry');
const DEPTS = [HAEM, BIOC];
const spec = (n: number, code: string, name: string) => ({ id: ID(n), code, name, report_label: name.toUpperCase(), is_active: true, version: 1, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-06T09:30:00.000Z' });
const EDTA = spec(11, 'EDTA_WB', 'EDTA whole blood');
const SERUM = spec(12, 'SERUM', 'Serum');

type T = { id: string; kind: 'test'; code: string; name: string; department_id: string; department_code: string; workflow_type: string; is_orderable: boolean; is_active: boolean; revision: number };
const test = (n: number, code: string, name: string, d: typeof HAEM, o: Partial<T> = {}): T => ({ id: ID(100 + n), kind: 'test', code, name, department_id: d.id, department_code: d.code, workflow_type: 'standard', is_orderable: true, is_active: true, revision: 1, ...o });
const FIVE = [
  test(1, 'HB', 'Hemoglobin', HAEM),
  test(2, 'CBC', 'Complete blood count', HAEM),
  test(3, 'GLU', 'Glucose fasting', BIOC),
  test(4, 'HBA1C', 'Glycated haemoglobin', BIOC, { is_active: false }),
  test(5, 'TSH', 'Thyroid stimulating hormone', BIOC),
];
const SPEC_OF: Record<string, string[]> = { [ID(101)]: [EDTA.id], [ID(102)]: [EDTA.id], [ID(103)]: [SERUM.id], [ID(104)]: [EDTA.id], [ID(105)]: [SERUM.id] };
const MANY = Array.from({ length: 60 }, (_, i) => test(200 + i, `C${String(i + 1).padStart(3, '0')}`, `Synthetic test ${i + 1}`, BIOC));

let TESTS: T[] = FIVE;
const listCalls: URL[] = [];
const rejected: string[] = [];
const creates: { headers: Headers; body: any }[] = [];
const prob = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const ALLOWED = new Set(['department_id', 'workflow_type', 'is_active', 'sort', 'cursor', 'limit']);

const api = setupServer(
  // Mirrors the deployed validator (TRD #23, tests.service.ts listTests): declared keys only, strict values, keyset cursor "c<offset>".
  http.get(`${ORIGIN}/v1/catalog/tests`, ({ request }) => {
    const u = new URL(request.url);
    listCalls.push(u);
    const p = u.searchParams;
    const bad = (why: string) => { rejected.push(`${why}: ${u.search}`); return prob(422, 'common.validation_failed', { errors: [{ pointer: `/${why}`, code: 'invalid' }] }); };
    for (const k of p.keys()) if (!ALLOWED.has(k)) return bad(k);
    const ia = p.get('is_active') ?? 'true'; // the API default is Active only; "All" must be asked for
    if (!['true', 'false', 'all'].includes(ia)) return bad('is_active');
    const dep = p.get('department_id');
    if (dep !== null && !UUID.test(dep)) return bad('department_id');
    const limit = p.has('limit') ? Number(p.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return bad('limit');
    const sort = p.get('sort') ?? 'code';
    if (!['code', '-code', 'name', '-name', 'report_order', '-report_order'].includes(sort)) return bad('sort');
    const cur = p.get('cursor');
    const offset = cur === null ? 0 : /^c\d{1,6}$/.test(cur) ? Number(cur.slice(1)) : -1;
    if (offset < 0) return bad('cursor');
    const col = sort.replace(/^-/, '') === 'name' ? 'name' : 'code';
    const rows = TESTS.filter((t) => (ia === 'all' || t.is_active === (ia === 'true')) && (!dep || t.department_id === dep))
      .sort((a, b) => a[col].localeCompare(b[col]) * (sort.startsWith('-') ? -1 : 1));
    const data = rows.slice(offset, offset + limit);
    const more = rows.length > offset + limit;
    return HttpResponse.json({ data, page: { limit, ...(more ? { next_cursor: `c${offset + limit}` } : {}) } });
  }),
  http.get(`${ORIGIN}/v1/catalog/tests/:id`, ({ params }) => {
    const t = TESTS.find((x) => x.id === params['id']);
    if (!t) return prob(404, 'common.not_found');
    return HttpResponse.json({ ...t, report_order: 100, uses_existing_material: false, specimen_requirements: (SPEC_OF[t.id] ?? []).map((s, i) => ({ specimen_type_id: s, is_preferred: i === 0 })), analytes: [], tat_targets: [], version: 1 });
  }),
  http.post(`${ORIGIN}/v1/catalog/tests`, async ({ request }) => {
    creates.push({ headers: request.headers, body: await request.clone().json().catch(() => undefined) });
    return createReply();
  }),
  http.get(`${ORIGIN}/v1/catalog/departments`, () => HttpResponse.json({ data: DEPTS, page: { limit: 200 } })),
  http.get(`${ORIGIN}/v1/catalog/specimen-types`, () => HttpResponse.json({ data: [EDTA, SERUM], page: { limit: 200 } })),
  http.get(`${ORIGIN}/v1/catalog/*`, () => HttpResponse.json({ data: [], page: { limit: 200 } })), // containers etc. if the form reads them
);
let createReply = (): Response => HttpResponse.json({ ...test(900, 'HGB2', 'Hemoglobin A2', BIOC), report_order: 100, version: 1, specimen_requirements: [], analytes: [], tat_targets: [] }, { status: 201 });

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup(); api.resetHandlers(); listCalls.length = 0; rejected.length = 0; creates.length = 0; navLog.length = 0; used.clear();
  push.mockClear(); replace.mockClear(); refresh.mockReset(); session.permissions = MANAGE; TESTS = FIVE; nav.search = '';
  createReply = () => HttpResponse.json({ ...test(900, 'HGB2', 'Hemoglobin A2', BIOC), report_order: 100, version: 1, specimen_requirements: [], analytes: [], tat_targets: [] }, { status: 201 });
});
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; session.permissions = MANAGE; });

// ----------------------------------------------------------------------------------------------------------------------------- helpers
type Sp = Record<string, string>;
/** Render /catalog/tests?<search> exactly as Next would: the server page gets the parsed search params, client parts read useSearchParams. */
async function show(search = '') {
  nav.search = search.replace(/^\?/, '');
  const Page = (await import('@/app/(staff)/catalog/tests/page')).default as (p: { searchParams: Promise<Sp> }) => Promise<React.ReactNode>;
  const ui = await Page({ searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(nav.search))) });
  return render(<ToastProvider>{ui}</ToastProvider>);
}
const reshow = async (u: URL) => { expect(u.pathname).toBe('/catalog/tests'); cleanup(); listCalls.length = 0; return show(u.search); };
/** Run a user action and return the address the page navigated to (router.push/replace). */
async function addressAfter(action: () => Promise<unknown> | unknown): Promise<URL> {
  const before = navLog.length;
  await action();
  await waitFor(() => expect(navLog.length).toBeGreaterThan(before), { timeout: 4000 });
  return new URL(navLog.at(-1)!, 'http://x.test');
}
/** A pager control is a link (read its href; jsdom cannot navigate) or a button (click it and read the router call). */
async function pagerTarget(name: RegExp): Promise<URL> {
  const el = screen.getByRole(screen.queryByRole('link', { name }) ? 'link' : 'button', { name });
  const href = el instanceof HTMLAnchorElement ? el.getAttribute('href') : null;
  return href ? new URL(href, 'http://x.test') : addressAfter(() => userEvent.click(el));
}
const pagerOn = (name: RegExp) => {
  const el = screen.queryByRole('link', { name }) ?? screen.queryByRole('button', { name });
  return !!el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';
};
const bodyRows = () => [...screen.getByRole('table').querySelectorAll<HTMLTableRowElement>('tbody tr')];
const codes = () => bodyRows().map((r) => r.cells[0]!.textContent!.trim());
const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent!.trim());
const newButtons = () => screen.queryAllByRole('button', { name: /new test/i });
const enabled = (b: HTMLElement) => !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true';
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }); // jsdom has no layout/colour; the shell supplies the landmarks
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const RAW_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const rawKeys = (root: HTMLElement) => {
  const out: string[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const s = n.textContent?.trim() ?? ''; if (RAW_KEY.test(s)) out.push(s); }
  root.querySelectorAll('[aria-label],[title],[placeholder]').forEach((e) => ['aria-label', 'title', 'placeholder'].forEach((a) => { const v = e.getAttribute(a)?.trim(); if (v && RAW_KEY.test(v)) out.push(v); }));
  return out;
};
const choose = async (scope: HTMLElement | null, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope ?? document.body).getByLabelText(label));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

// ----------------------------------------------------------------------------------------------------------------------------- (1)(3) header, headers, empty
describe('page header, table headers, empty state', () => {
  it('has the Departments/Doctors page pattern: title Tests, breadcrumb to Catalog, New test button, search, department / specimen / status filters', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 1, name: 'Tests' })).toBeTruthy();
    expect(document.querySelector('a[href="/catalog"]')).toBeTruthy(); // breadcrumb Catalog > Tests (PageHeader)
    expect(newButtons().some(enabled)).toBe(true);
    expect(screen.getByLabelText(/search/i)).toBeTruthy();
    expect(screen.getByLabelText(/^department/i)).toBeTruthy();
    expect(screen.getByLabelText(/^specimen/i)).toBeTruthy();
    for (const s of ['All', 'Active', 'Inactive']) expect(screen.queryByRole('radio', { name: s }) ?? screen.queryByRole('option', { name: s }) ?? screen.queryByText(s, { selector: 'label,button,span' })).toBeTruthy();
  });

  it('with ZERO tests: column headers are drawn; the first row says "No tests yet. Add a test" and repeats the New test button (done_when 1, 3)', async () => {
    TESTS = [];
    await show();
    expect(headers().slice(0, 5)).toEqual(['Code', 'Name', 'Department', 'Workflow type', 'Status']);
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/No tests yet\.?\s*Add a test/);
    expect(within(rows[0]!).getAllByRole('button', { name: /new test/i }).length).toBeGreaterThan(0);
    expect(newButtons().length).toBeGreaterThanOrEqual(2); // header + the row
    expect(screen.queryByText(/^No tests yet\.$/)).toBeNull(); // the old bare paragraph is gone
    await noAxeViolations();
  });

  it('the empty-state New test button opens the creation form', async () => {
    TESTS = [];
    await show();
    await userEvent.click(within(bodyRows()[0]!).getByRole('button', { name: /new test/i }));
    expect(within(screen.getByRole('dialog')).getByLabelText(/^code/i)).toBeTruthy();
  });

  it('with rows: same headers; each row = code link to /catalog/tests/{id}, name, department, workflow type, Active/Inactive text', async () => {
    await show();
    expect(headers().slice(0, 5)).toEqual(['Code', 'Name', 'Department', 'Workflow type', 'Status']);
    expect(codes()).toEqual(['CBC', 'GLU', 'HB', 'HBA1C', 'TSH']); // default status All: the inactive test is listed too
    const hb = bodyRows().find((r) => r.cells[0]!.textContent!.trim() === 'HB')!;
    expect(within(hb).getByRole('link', { name: 'HB' }).getAttribute('href')).toBe(`/catalog/tests/${ID(101)}`);
    expect(hb.textContent).toMatch(/Hemoglobin/);
    expect(hb.textContent).toMatch(/Hematology|HAEM/);
    expect(hb.textContent).toMatch(/Active/);
    expect(bodyRows().find((r) => r.cells[0]!.textContent!.trim() === 'HBA1C')!.textContent).toMatch(/Inactive/);
    await noAxeViolations();
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (1)(5) permission
describe('New test button by permission', () => {
  it('catalog.test.manage: New test is shown and enabled', async () => {
    await show();
    expect(newButtons().length).toBeGreaterThan(0);
    expect(newButtons().every(enabled)).toBe(true);
  });

  it('read-only actor: no ENABLED New test button, a visible (not title-only) reason, no dialog even with ?new=1', async () => {
    session.permissions = READ;
    await show('new=1');
    expect(newButtons().filter(enabled)).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).toMatch(/permission/i); // visible text explaining why
    expect(screen.getByRole('table')).toBeTruthy(); // the list itself still works
  });

  it('read-only actor and zero rows: the first row says No tests yet; its New test control is not enabled', async () => {
    session.permissions = READ;
    TESTS = [];
    await show();
    expect(bodyRows()[0]!.textContent).toMatch(/No tests yet/);
    expect(within(bodyRows()[0]!).queryAllByRole('button', { name: /new test/i }).filter(enabled)).toEqual([]);
  });

  it('no catalog.test.read: no table, no New test, and the tests API is never called', async () => {
    session.permissions = [];
    await show();
    expect(screen.queryByRole('table')).toBeNull();
    expect(newButtons()).toEqual([]);
    expect(listCalls).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (2) creation form
describe('creation form: one form for the button, the empty-state button and /catalog/tests?new=1', () => {
  const labelsOf = (dlg: HTMLElement) => [...dlg.querySelectorAll('label')].map((l) => l.textContent!.trim().replace(/\s*\*$/, '')).filter(Boolean).sort();

  it('?new=1 opens the form at once; the header button opens the SAME form (same fields)', async () => {
    await show('new=1');
    const viaLink = screen.getByRole('dialog');
    const a = labelsOf(viaLink);
    for (const f of [/^code/i, /^name/i, /^department/i, /^workflow type/i, /^specimen/i]) expect(within(viaLink).getByLabelText(f)).toBeTruthy();
    cleanup();
    await show();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(newButtons()[0]!);
    expect(labelsOf(screen.getByRole('dialog'))).toEqual(a);
  });

  const fill = async (dlg: HTMLElement, o: { code?: string; name?: string; dept?: RegExp; spec?: RegExp } = {}) => {
    if (o.code) await userEvent.type(within(dlg).getByLabelText(/^code/i), o.code);
    if (o.name) await userEvent.type(within(dlg).getByLabelText(/^name/i), o.name);
    if (o.dept) await choose(dlg, /^department/i, o.dept);
    await choose(dlg, /^workflow type/i, /^standard$/i);
    if (o.spec) await choose(dlg, /^specimen/i, o.spec);
  };
  const save = () => userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^(save|create test)$/i }));

  it('Save -> one POST /v1/catalog/tests (Idempotency-Key, upper-case code, ids not names, preferred specimen) -> opens the new test', async () => {
    await show('new=1');
    const dlg = screen.getByRole('dialog');
    await fill(dlg, { code: 'hgb2', name: 'Hemoglobin A2', dept: /biochemistry/i, spec: /edta whole blood/i });
    await save();
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(creates[0]!.body).toMatchObject({ code: 'HGB2', name: 'Hemoglobin A2', department_id: BIOC.id, workflow_type: 'standard', specimen_requirements: [{ specimen_type_id: EDTA.id, is_preferred: true }] });
    expect(Object.keys(creates[0]!.body).sort()).toEqual(expect.arrayContaining(['code', 'name', 'department_id', 'workflow_type', 'specimen_requirements']));
    await waitFor(() => expect(navLog.some((u) => u.split('?')[0] === `/catalog/tests/${ID(900)}`)).toBe(true));
  });

  it('a test without a specimen is allowed (add-on on existing material): specimen_requirements is []', async () => {
    await show('new=1');
    await fill(screen.getByRole('dialog'), { code: 'addon1', name: 'Add-on test', dept: /hematology/i });
    await save();
    await waitFor(() => expect(creates).toHaveLength(1));
    expect(creates[0]!.body['specimen_requirements']).toEqual([]);
  });

  it('empty required fields: no request, field errors shown', async () => {
    await show('new=1');
    await save();
    await new Promise((r) => setTimeout(r, 150));
    expect(creates).toEqual([]);
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).queryAllByRole('alert').length + dlg.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
  });

  it('two quick Save clicks create one test', async () => {
    await show('new=1');
    await fill(screen.getByRole('dialog'), { code: 'dbl1', name: 'Double click', dept: /hematology/i });
    const b = within(screen.getByRole('dialog')).getByRole('button', { name: /^(save|create test)$/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(creates.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(creates).toHaveLength(1);
  });

  it('duplicate code (409 catalog.code_duplicate): inline message, form stays open, no navigation, nothing leaks of the raw problem', async () => {
    createReply = () => prob(409, 'catalog.code_duplicate', { detail: 'duplicate key value violates unique constraint "orderables_tenant_code_uq"' });
    await show('new=1');
    await fill(screen.getByRole('dialog'), { code: 'hb', name: 'Dup', dept: /hematology/i });
    await save();
    await waitFor(() => expect(creates).toHaveLength(1));
    const dlg = await screen.findByRole('dialog');
    await waitFor(() => expect(dlg.textContent).toMatch(/already/i));
    expect(dlg.textContent).not.toMatch(/unique constraint|orderables_tenant/);
    expect(navLog.filter((u) => u.startsWith('/catalog/tests/'))).toEqual([]);
  });

  it('the form passes axe', async () => {
    await show('new=1');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await noAxeViolations();
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (1)(4)(5) search + filters
describe('search and filters: state in the address bar, the request changes', () => {
  it('Status Inactive -> address has is_active=false -> the page asks the API for is_active=false and shows only inactive tests', async () => {
    await show();
    const target = await addressAfter(async () => {
      const radio = screen.queryByRole('radio', { name: 'Inactive' });
      if (radio) return userEvent.click(radio);
      await userEvent.click(screen.getByLabelText(/^status/i));
      return userEvent.click(await screen.findByRole('option', { name: 'Inactive' }));
    });
    expect(target.searchParams.get('is_active')).toBe('false');
    await reshow(target);
    expect(listCalls.at(-1)!.searchParams.get('is_active')).toBe('false');
    expect(codes()).toEqual(['HBA1C']);
  });

  it('a status filter in the address bar is honoured on load (Active = no inactive rows; All = every row)', async () => {
    await show('is_active=true');
    expect(codes()).toEqual(['CBC', 'GLU', 'HB', 'TSH']);
    cleanup();
    await show('');
    expect(codes()).toHaveLength(5);
  });

  it('Department filter -> address has department_id -> request carries it -> only that department', async () => {
    await show();
    const target = await addressAfter(() => choose(null, /^department/i, /biochemistry/i));
    expect(target.searchParams.get('department_id')).toBe(BIOC.id);
    await reshow(target);
    expect(listCalls.at(-1)!.searchParams.get('department_id')).toBe(BIOC.id);
    expect(codes()).toEqual(['GLU', 'HBA1C', 'TSH']);
    expect((screen.getByLabelText(/^department/i) as HTMLElement).textContent + (screen.getByLabelText(/^department/i) as HTMLInputElement).value).toMatch(/biochemistry/i);
  });

  it('Specimen filter -> address has specimen_type_id -> only tests that collect it; the tests API is never sent specimen_type_id', async () => {
    await show();
    const target = await addressAfter(() => choose(null, /^specimen/i, /edta whole blood/i));
    expect(target.searchParams.get('specimen_type_id')).toBe(EDTA.id);
    await reshow(target);
    expect(codes()).toEqual(['CBC', 'HB', 'HBA1C']);
    expect(listCalls.every((u) => !u.searchParams.has('specimen_type_id'))).toBe(true);
    expect(rejected).toEqual([]);
  });

  it('Search: typing + Enter puts q in the address; q=hb matches code and name case-insensitively and is never sent to the API', async () => {
    await show();
    const box = screen.getByLabelText(/search/i);
    const target = await addressAfter(async () => { await userEvent.type(box, 'hb{Enter}'); });
    expect(target.searchParams.get('q')).toBe('hb');
    await reshow(target);
    expect((screen.getByLabelText(/search/i) as HTMLInputElement).value).toBe('hb'); // restored from the address bar
    expect(codes()).toEqual(['HB', 'HBA1C']);
    expect(listCalls.every((u) => !u.searchParams.has('q'))).toBe(true);
    expect(rejected).toEqual([]);
  });

  it.each([['glucose', ['GLU']], ['  HEMOGLOBIN ', ['HB']], ['stimulating', ['TSH']], ['no-such-test', []]] as const)('q=%j shows %j (name or code, trimmed, any case)', async (q, want) => {
    await show(`q=${encodeURIComponent(q)}`);
    expect(codes().filter((c) => !/^No tests/.test(c))).toEqual(want);
    expect(headers().length).toBeGreaterThanOrEqual(5); // headers stay drawn when the search matches nothing
  });

  it('filters combine: department + status + search', async () => {
    await show(`department_id=${BIOC.id}&is_active=true&q=t`);
    expect(codes()).toEqual(['GLU', 'TSH']); // Biochemistry, active, contains "t" in code or name (GLU: "Glucose fasting")
    expect(rejected).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (4) 25 per page
describe('25 rows per page with Next / Previous; search and filters survive paging', () => {
  const FILTERS = `department_id=${BIOC.id}&is_active=true&q=C0`;

  it('page 1 = 25 rows, Next on, Previous off; Next -> rows 26-50; Previous -> back to 1-25; last page = 10 rows, Next off', async () => {
    TESTS = MANY;
    await show(FILTERS);
    expect(codes()).toEqual(MANY.slice(0, 25).map((t) => t.code));
    expect(pagerOn(/^next/i)).toBe(true);
    expect(pagerOn(/^previous/i)).toBe(false);

    const next = await pagerTarget(/^next/i);
    await reshow(next);
    expect(codes()).toEqual(MANY.slice(25, 50).map((t) => t.code));
    expect(pagerOn(/^previous/i)).toBe(true);

    const prev = await pagerTarget(/^previous/i);
    await reshow(prev);
    expect(codes()).toEqual(MANY.slice(0, 25).map((t) => t.code));

    await reshow(await pagerTarget(/^next/i));
    await reshow(await pagerTarget(/^next/i));
    expect(codes()).toEqual(MANY.slice(50).map((t) => t.code));
    expect(pagerOn(/^next/i)).toBe(false);
    expect(rejected).toEqual([]);
  });

  it('the Next address keeps department_id, is_active and q', async () => {
    TESTS = MANY;
    await show(FILTERS);
    const next = await pagerTarget(/^next/i);
    expect(next.searchParams.get('department_id')).toBe(BIOC.id);
    expect(next.searchParams.get('is_active')).toBe('true');
    expect(next.searchParams.get('q')).toBe('C0');
  });

  it('a single page (5 tests): no Next, no Previous', async () => {
    await show();
    expect(pagerOn(/^next/i)).toBe(false);
    expect(pagerOn(/^previous/i)).toBe(false);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- adversarial
describe('hostile address bar', () => {
  it.each([
    ['department_id=not-a-uuid', 'department_id=not-a-uuid'], ['is_active=maybe', 'is_active=maybe'], ['cursor with SQL', 'cursor=%27%3B%20drop%20table'], ['limit=99999', 'limit=99999'],
    ['sort=password', 'sort=password'], ['specimen_type_id=zzz', 'specimen_type_id=zzz'], ['workflow_type=script', 'workflow_type=%3Cscript%3E'],
    ['q of 5000 characters', `q=${'x'.repeat(5000)}`], ['unknown key + NUL', 'unknown=1&department_id=%00'], ['new=2', 'new=2'],
  ])('%s: the page still renders its headers and never sends the API an invalid or undeclared value (no 422)', async (_label, qs) => {
    await show(qs);
    expect(headers().slice(0, 5)).toEqual(['Code', 'Name', 'Department', 'Workflow type', 'Status']);
    expect(rejected).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('q is text, never markup', async () => {
    await show(`q=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(headers().length).toBeGreaterThanOrEqual(5);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (6) English from the catalogue
describe('page text is English from the message catalogue (CV §13), no raw keys', () => {
  it('no raw key is visible in the list, the empty state, the read-only state or the form; the page uses catalog.tests.* catalogue keys that all resolve', async () => {
    const { t: real } = await vi.importActual<typeof import('@/core/i18n/messages')>('@/core/i18n/messages');
    await show('new=1');
    expect(rawKeys(document.body)).toEqual([]);
    cleanup();
    TESTS = [];
    await show();
    expect(rawKeys(document.body)).toEqual([]);
    cleanup();
    TESTS = FIVE;
    session.permissions = READ;
    await show();
    expect(rawKeys(document.body)).toEqual([]);

    const own = [...used].filter((k) => k.startsWith('catalog.tests.'));
    expect(own.length).toBeGreaterThanOrEqual(8);
    expect(own.filter((k) => real(k) === k)).toEqual([]); // every key used is defined in the English catalogue
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Tests/);
    expect(text).not.toMatch(/[ऀ-ॿ]/); // English page: no Devanagari
  });
});
