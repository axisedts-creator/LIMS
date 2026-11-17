// @vitest-environment jsdom
// T0D-CATUNITS-1 — Catalog Units page (SCR-05): regression for "Something went wrong, Reference: 2489750203" on staging (LD-310; lead check 2026-11-17 05:18 NPT).
// Synthetic data only. The page is rendered through its default export (async server component) with MSW standing in for the API.
// ROOT CAUSE pinned here: the page asks GET /v1/catalog/value-sets with is_active=all, but that operation declares ONLY `scope`
// (contracts/openapi/catalog.yaml listValueSets; services/api masters.service.ts checkEnumQuery rejects any other key with 422),
// so the page threw into error.tsx. The mock below validates query keys exactly as the deployed API does.
//   API contract (catalog.yaml): GET /v1/catalog/units?scope&is_active(true|false|all) -> {data: Unit[]}; Unit = {id?, code, display, scope, is_active, version?} (global rows have no id/version);
//                                POST /v1/catalog/units {code, display} (Idempotency-Key); PATCH /v1/catalog/units/{id} {display?, is_active?} (If-Match).
//                                The contract has NO symbol and NO conversion field, so the form has none (nothing is invented).
//   Page: title "Units & value sets", header button "New unit", table headers drawn with no rows, row text "No units yet. Add a unit" + a New unit button.
//   Error boundary (catalog segment): keeps title + digest reference and names the operation from the path ("units could not be loaded").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

const refresh = vi.fn();
const nav = vi.hoisted(() => ({ path: '/catalog/units' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog/units',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `0193c3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const READ = ['catalog.test.read'];
const MANAGE = ['catalog.test.read', 'catalog.test.manage'];

// Real response shapes from catalog.yaml: tenant row = contract example; global rows come from g_units (no id, no version).
const TENANT = { id: ID(31), code: 'g_dL', display: 'Synthetic display', scope: 'tenant', is_active: true, version: 3 };
const GLOBALS = [{ code: 'mg_dL', display: 'mg/dL', scope: 'global', is_active: true }, { code: 'IU_L', display: 'IU/L', scope: 'global', is_active: true }];
const SET = { id: ID(34), code: 'URINE_GRADE', display: 'Synthetic display', is_ordered: false, scope: 'tenant', is_active: true, version: 1, values: [{ code: 'POS_1', display: 'Synthetic display', sort_order: 1, is_active: true }] };

let UNITS: unknown[] = [];
let SETS: unknown[] = [];
const unitCalls: URL[] = [];
const setCalls: URL[] = [];
const rejected: string[] = [];
const writes: { method: string; url: URL; headers: Headers; body: any }[] = [];
const prob = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
/** Mirrors masters.service.ts checkEnumQuery: only declared keys, only declared values, else 422 common.validation_failed. */
const strict = (u: URL, allowed: Record<string, string[]>) => {
  for (const [k, v] of u.searchParams) {
    if (!Object.hasOwn(allowed, k) || !allowed[k]!.includes(v)) { rejected.push(u.search); return prob(422, 'common.validation_failed', { errors: [{ pointer: `/${k}`, code: Object.hasOwn(allowed, k) ? 'invalid' : 'unknown' }] }); }
  }
  return null;
};

const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/units`, ({ request }) => {
    const u = new URL(request.url); unitCalls.push(u);
    return strict(u, { scope: ['global', 'tenant'], is_active: ['true', 'false', 'all'] }) ?? HttpResponse.json({ data: UNITS });
  }),
  http.get(`${ORIGIN}/v1/catalog/value-sets`, ({ request }) => {
    const u = new URL(request.url); setCalls.push(u);
    return strict(u, { scope: ['global', 'tenant'] }) ?? HttpResponse.json({ data: SETS });
  }),
  http.post(`${ORIGIN}/v1/catalog/units`, async ({ request }) => {
    writes.push({ method: 'POST', url: new URL(request.url), headers: request.headers, body: await request.clone().json() });
    return HttpResponse.json({ id: ID(32), code: 'g_dL', display: 'Synthetic display', scope: 'tenant', is_active: true, version: 1 }, { status: 201 });
  }),
  http.patch(`${ORIGIN}/v1/catalog/units/:id`, async ({ request }) => {
    writes.push({ method: 'PATCH', url: new URL(request.url), headers: request.headers, body: await request.clone().json() });
    return HttpResponse.json({ ...TENANT, version: 4 });
  }),
);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); unitCalls.length = 0; setCalls.length = 0; rejected.length = 0; writes.length = 0; refresh.mockReset(); UNITS = []; SETS = []; session.permissions = MANAGE; nav.path = '/catalog/units'; });
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; session.permissions = MANAGE; });

async function show() {
  const Page = (await import('@/app/(staff)/catalog/units/page')).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<React.ReactNode>;
  const ui = await Page({ searchParams: Promise.resolve({}) });
  return render(<ToastProvider>{ui}</ToastProvider>);
}
const newButtons = () => screen.queryAllByRole('button', { name: /^new unit$/i });
const enabled = (b: HTMLElement) => !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true';
const headers = () => within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent!.trim()).filter(Boolean);
const bodyRows = () => [...screen.getByRole('table').querySelectorAll<HTMLTableRowElement>('tbody tr')];
const rowOf = (code: string) => bodyRows().find((r) => r.cells[0]?.textContent?.trim() === code)!;
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

// ----------------------------------------------------------------------------------------------------------------------------- (1)(2) the regression
describe('the page loads (root cause: value-sets was asked with is_active)', () => {
  it('empty lists: the page renders instead of throwing; the API rejected nothing', async () => {
    await show();
    expect(rejected).toEqual([]);
    expect(screen.getByRole('heading', { level: 1, name: /units/i })).toBeTruthy();
  });

  it('GET /v1/catalog/value-sets carries no is_active (the operation declares only scope); GET /units may ask is_active=all', async () => {
    UNITS = [TENANT, ...GLOBALS]; SETS = [SET];
    await show();
    expect(setCalls).toHaveLength(1);
    expect([...setCalls[0]!.searchParams.keys()].filter((k) => k !== 'scope')).toEqual([]);
    expect(unitCalls).toHaveLength(1);
    expect([...unitCalls[0]!.searchParams.keys()].filter((k) => !['scope', 'is_active'].includes(k))).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('real response shape (global rows without id/version, one lab row): all rows listed; globals read-only, lab row editable', async () => {
    UNITS = [...GLOBALS, TENANT];
    await show();
    expect(bodyRows().map((r) => r.cells[0]!.textContent!.trim())).toEqual(['mg_dL', 'IU_L', 'g_dL']);
    expect(within(rowOf('mg_dL')).queryByRole('button', { name: /edit/i })).toBeNull();
    expect(within(rowOf('g_dL')).getByRole('button', { name: /edit/i })).toBeTruthy();
    expect(within(rowOf('g_dL')).getByText('Lab')).toBeTruthy();
    expect(within(rowOf('mg_dL')).getByText('Global')).toBeTruthy();
  });

  it('a real API failure on units still reaches the error boundary (not swallowed into an empty page)', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/units`, () => prob(500, 'common.internal')));
    await expect(show()).rejects.toBeTruthy();
  });

  it('403 on the read shows the no-access page, not an error', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/units`, () => prob(403, 'auth.forbidden')));
    await show();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.body.textContent).toMatch(/permission|access/i);
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (3) header, empty table, create, edit
describe('header, always-drawn headers, empty state', () => {
  it('header has the title and a New unit button for a manager', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 1, name: 'Units & value sets' })).toBeTruthy();
    expect(newButtons().length).toBeGreaterThan(0);
    expect(newButtons().every(enabled)).toBe(true);
  });

  it('ZERO units: headers Code, Display, Scope, Status are drawn; the row says "No units yet. Add a unit" and repeats New unit', async () => {
    await show();
    expect(headers()).toEqual(['Code', 'Display', 'Scope', 'Status']);
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/No units yet\.?\s*Add a unit/);
    expect(within(rows[0]!).getAllByRole('button', { name: /^new unit$/i }).length).toBeGreaterThan(0);
    expect(newButtons().length).toBeGreaterThanOrEqual(2); // header + row
    await noAxeViolations();
  });

  it('the empty-row New unit button opens the creation form', async () => {
    await show();
    await userEvent.click(within(bodyRows()[0]!).getByRole('button', { name: /^new unit$/i }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByLabelText(/^code/i)).toBeTruthy();
    expect(within(dlg).getByLabelText(/^display/i)).toBeTruthy();
    expect(within(dlg).queryByLabelText(/symbol|conversion/i)).toBeNull(); // not in the contract: nothing invented
  });

  it('Value sets tab with zero value sets also draws its headers', async () => {
    await show();
    await userEvent.click(screen.getByRole('tab', { name: 'Value sets' }));
    expect(headers()).toEqual(['Code', 'Display', 'Ordered', 'Values', 'Scope']);
    expect(bodyRows()[0]!.textContent).toMatch(/No value sets yet/);
  });

  it('read-only actor: no enabled New unit, no Edit, and a visible permission reason', async () => {
    session.permissions = READ; UNITS = [TENANT];
    await show();
    expect(newButtons().filter(enabled)).toEqual([]);
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(document.body.textContent).toMatch(/permission/i);
  });
});

describe('creating and editing a unit works end to end', () => {
  it('New unit: POST {code, display} with Idempotency-Key and nothing else; success refreshes the page', async () => {
    await show();
    await userEvent.click(newButtons()[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'g_dL');
    await userEvent.type(within(dlg).getByLabelText(/^display/i), 'Synthetic display');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('POST');
    expect(writes[0]!.url.pathname).toBe('/v1/catalog/units');
    expect(writes[0]!.body).toEqual({ code: 'g_dL', display: 'Synthetic display' });
    expect(writes[0]!.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('New unit: a bad code (space) is refused client-side, no request', async () => {
    await show();
    await userEvent.click(newButtons()[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'bad code');
    await userEvent.type(within(dlg).getByLabelText(/^display/i), 'x');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await new Promise((r) => setTimeout(r, 150));
    expect(writes).toHaveLength(0);
  });

  it('409 catalog.code_duplicate is shown on the form', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/units`, () => prob(409, 'catalog.code_duplicate')));
    await show();
    await userEvent.click(newButtons()[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'g_dL');
    await userEvent.type(within(dlg).getByLabelText(/^display/i), 'x');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    expect(await within(dlg).findAllByText(/already (used|in use)/i)).not.toHaveLength(0);
  });

  it('Edit lab unit: PATCH /units/{id} with If-Match "3" and only the changed field', async () => {
    UNITS = [...GLOBALS, TENANT];
    await show();
    await userEvent.click(within(rowOf('g_dL')).getByRole('button', { name: /edit/i }));
    const dlg = screen.getByRole('dialog');
    await userEvent.clear(within(dlg).getByLabelText(/^display/i));
    await userEvent.type(within(dlg).getByLabelText(/^display/i), 'g/dL');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('PATCH');
    expect(writes[0]!.url.pathname).toBe(`/v1/catalog/units/${ID(31)}`);
    expect(writes[0]!.headers.get('if-match')).toBe('"3"');
    expect(writes[0]!.body).toEqual({ display: 'g/dL' });
  });
});

// ----------------------------------------------------------------------------------------------------------------------------- (4) error boundary
describe('catalog error boundary names the failed operation and keeps the reference', () => {
  const boundary = async (path: string, digest = '2489750203') => {
    nav.path = path;
    const CatalogError = (await import('@/app/(staff)/catalog/error')).default;
    const e = Object.assign(new Error('raw secret stack detail'), { digest });
    return render(<CatalogError error={e} reset={vi.fn()} />);
  };

  it('/catalog/units: "Something went wrong", "units could not be loaded", the digest reference, a Try again button, no raw message', async () => {
    await boundary('/catalog/units');
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(document.body.textContent).toMatch(/units could not be loaded/i);
    expect(document.body.textContent).toContain('2489750203');
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/raw secret stack detail/);
  });

  it.each([['/catalog/tests', /tests could not be loaded/i], ['/catalog/price-lists', /price lists could not be loaded/i], ['/catalog/comment-codes', /comment codes could not be loaded/i]])('%s names its own operation', async (path, re) => {
    await boundary(path);
    expect(document.body.textContent).toMatch(re);
    expect(document.body.textContent).toContain('2489750203');
  });

  it('/catalog (home) and a detail path still render the title and the reference without a broken sentence', async () => {
    await boundary('/catalog', '111');
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(document.body.textContent).toContain('111');
    expect(document.body.textContent).not.toMatch(/undefined|null|\[object/);
    cleanup();
    await boundary('/catalog/tests/01a1a98a-ac40-7000-8000-0000000e0101', '222');
    expect(document.body.textContent).toContain('222');
    expect(document.body.textContent).not.toMatch(/undefined|null|\[object|01a1a98a/);
  });

  it('no digest: still names the operation, no empty reference label', async () => {
    nav.path = '/catalog/units';
    const CatalogError = (await import('@/app/(staff)/catalog/error')).default;
    render(<CatalogError error={new Error('x')} reset={vi.fn()} />);
    expect(document.body.textContent).toMatch(/units could not be loaded/i);
  });
});
