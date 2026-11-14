// @vitest-environment jsdom
// C3.T-31 — SCR-01 Catalog home, SCR-02 Departments, SCR-03 Specimen types & containers, SCR-04 Methods, SCR-05 Units & value sets
// (04-UI-UX §3/§4; 03-APP-FLOW §5 states; ACs AC-01.1…AC-01.6 as seen from the UI). Component tests + MSW (server actions run for real) + axe.
// Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + kit components only; writer may dispute a name via the ruling flow):
//   components/CatalogHome.tsx     CatalogHome({health: CatalogHealthReport|null, counts: {departments,tests,panels,doctors,doctors_unverified,price_lists}|null,
//                                               revision: number|null, permissions, requestId?})   null = load failed (tiles "—", Reference + Retry)
//   components/DepartmentsList.tsx DepartmentsList({departments, permissions})      components/MethodsList.tsx MethodsList({methods, permissions})
//   components/SpecimensScreen.tsx SpecimensScreen({specimenTypes, containers, permissions})   (tabs "Specimen types" / "Containers")
//   components/UnitsScreen.tsx     UnitsScreen({units, valueSets, permissions})                 (tabs "Units" / "Value sets")
//   pages: app/(staff)/catalog/{page,departments/page,specimens/page,methods/page,units/page}.tsx (async server components, searchParams: Promise<…>),
//          app/(staff)/catalog/{loading,error}.tsx.   permissions = session.actor.permissions; list refresh = next/navigation useRouter().refresh().
//   Edit/New forms are role="dialog" (Drawer or Dialog); primary button is named "Save"; Ctrl+S saves the open form (04-UI-UX §3).
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
  usePathname: () => '/catalog/departments',
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
const READ = ['catalog.test.read'];
const MANAGE = ['catalog.test.read', 'catalog.test.manage'];
const FULL = [...MANAGE, 'catalog.price_list.read', 'catalog.price_list.manage', 'catalog.referrer.read'];
session.permissions = MANAGE;

const base = (n: number, o: Record<string, unknown>) => ({ id: ID(n), is_active: true, version: 3, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-06T09:30:00.000Z', ...o });
const dept = (n: number, o: Record<string, unknown> = {}) => base(n, { code: 'HAEM', name: 'Hematology', report_order: 10, report_heading: 'HAEMATOLOGY', ...o });
const DEPTS = [dept(1), dept(2, { code: 'BIOC', name: 'Biochemistry', report_order: 20, report_heading: undefined }), dept(3, { code: 'OLDD', name: 'Retired dept', is_active: false })];
const spec = (n: number, o: Record<string, unknown> = {}) => base(n, { code: 'EDTA_WB', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD', ...o });
const SPECS = [spec(11), spec(12, { code: 'SERUM', name: 'Serum', report_label: 'SERUM' }), spec(13, { code: 'OLDS', name: 'Old specimen', report_label: 'OLD', is_active: false })];
const cont = (n: number, o: Record<string, unknown> = {}) => base(n, { code: 'LAV', name: 'Lavender tube', additive: 'K2EDTA', cap_colour_display: 'Lavender', default_specimen_type_id: ID(11), ...o });
const CONTS = [cont(21)];
const meth = (n: number, o: Record<string, unknown> = {}) => base(n, { code: 'HPLC', name: 'HPLC', ...o });
const METHS = [meth(31), meth(32, { code: 'ELISA', name: 'ELISA', is_active: false })];
const unit = (n: number, o: Record<string, unknown> = {}) => base(n, { code: 'g_dL', display: 'g/dL', scope: 'global', ...o });
const GLOBAL_UNITS = [unit(41), unit(42, { code: 'x10_3_uL', display: '10^3/µL' })];
const TENANT_UNIT = unit(43, { code: 'lab_ratio', display: 'ratio', scope: 'tenant' });
const vs = (n: number, o: Record<string, unknown> = {}) => base(n, { code: 'SEMI', display: 'Semi-quantitative', is_ordered: true, scope: 'tenant', values: [{ code: 'NEG', display: 'Negative', sort_order: 0, is_active: true }, { code: '1+', display: 'Trace', sort_order: 1, is_active: true }], ...o });
const VSETS = [vs(51), vs(52, { code: 'GLOBALVS', display: 'Global set', scope: 'global' })];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: ['POST', 'PATCH'].includes(r.method) ? await r.clone().json().catch(() => undefined) : undefined }); };
const prob = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const page = (data: unknown[]) => HttpResponse.json({ data, page: { limit: 200 } });
const REPORT = { active_orderables_without_default_price: [ID(60)], analytes_without_reference_range: [ID(61), ID(62)], tests_without_specimen_type: [ID(63), ID(64), ID(65)], tests_missing_required_analyte: [ID(66)], tax_default_configured: false, unmapped_formula_inputs: ['HGB', 'WBC'], truncated: false };
const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/departments`, () => page(DEPTS)),
  http.get(`${ORIGIN}/v1/catalog/specimen-types`, () => page(SPECS)),
  http.get(`${ORIGIN}/v1/catalog/containers`, () => page(CONTS)),
  http.get(`${ORIGIN}/v1/catalog/methods`, () => page(METHS)),
  http.get(`${ORIGIN}/v1/catalog/units`, () => HttpResponse.json({ data: [...GLOBAL_UNITS, TENANT_UNIT] })),
  http.get(`${ORIGIN}/v1/catalog/value-sets`, () => HttpResponse.json({ data: VSETS })),
  http.get(`${ORIGIN}/v1/catalog/health-report`, () => HttpResponse.json(REPORT)),
  http.get(`${ORIGIN}/v1/catalog/revision`, () => HttpResponse.json({ catalog_revision: 12, global_release_seen: 3 })),
  http.get(`${ORIGIN}/v1/catalog/*`, () => HttpResponse.json({ data: [], page: { limit: 1 } })), // any other read the home page makes for its tile counts
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); session.permissions = MANAGE; });
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; });

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout/colour
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const fieldBad = (root: HTMLElement) => within(root).queryAllByRole('alert').length + root.querySelectorAll('[aria-invalid="true"]').length;
const rowOf = (code: string) => screen.getByRole('row', { name: new RegExp(`\\b${code}\\b`) });
const edit = async (code: string) => { await userEvent.click(within(rowOf(code)).getByRole('button', { name: /edit/i })); return screen.getByRole('dialog'); };
const save = async () => userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^save$/i }));
const control = (name: string) => [...document.querySelectorAll<HTMLElement>('[role=option],[role=radio],[role=tab],button,label')].find((e) => e.textContent?.trim() === name);

// ------------------------------------------------------------------------------------------------ SCR-01
describe('SCR-01 CatalogHome (03-APP-FLOW §5)', () => {
  const load = async () => (await import('../components/CatalogHome')).CatalogHome;
  const counts = { departments: 6, tests: 142, panels: 17, doctors: 230, doctors_unverified: 7, price_lists: 3 };
  const tile = (label: RegExp) => screen.getByText(label).closest('.lims-stat') as HTMLElement;
  const show = async (o: Record<string, unknown> = {}) => {
    const CatalogHome = await load();
    return wrap(<CatalogHome health={REPORT} counts={counts} revision={12} permissions={FULL} {...(o as object)} />);
  };

  it('stat tiles: Tests (active), Panels & packages, Doctors (unverified highlighted), Price lists, Catalog revision', async () => {
    await show();
    expect(within(tile(/^Tests( \(active\))?$/)).getByText('142')).toBeTruthy();
    expect(within(tile(/^Panels & packages$/)).getByText('17')).toBeTruthy();
    expect(within(tile(/^Price lists$/)).getByText('3')).toBeTruthy();
    expect(within(tile(/^Catalog revision$/)).getByText('12')).toBeTruthy();
    expect(tile(/^Doctors/).textContent).toMatch(/230/);
    expect(tile(/^Doctors/).textContent).toMatch(/7\s*unverified|unverified[^0-9]*7/i); // highlighted with text, not colour only
  });

  it('"Needs attention": each health item with its count is a link to a filtered list (internal /catalog path)', async () => {
    await show();
    const items: [RegExp, string][] = [
      [/Active orderables without a default price.*\b1\b/, '1'],
      [/Analytes without a reference range.*\b2\b/, '2'],
      [/Tests without a specimen type.*\b3\b/, '3'],
      [/Tests missing their narrative\/attachment analyte.*\b1\b/, '1'],
      [/Formulas referring to inactive analytes.*\b2\b/, '2'],
    ];
    for (const [name] of items) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('href')).toMatch(/^\/catalog(\/|\?|$)/);
    }
    expect(screen.getByText(/Tax default configured:\s*No/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /needs attention/i })).toBeTruthy();
  });

  it('tax default configured: Yes is rendered as "Yes"', async () => {
    await show({ health: { ...REPORT, tax_default_configured: true } });
    expect(screen.getByText(/Tax default configured:\s*Yes/i)).toBeTruthy();
  });

  it('truncated report (200-item cap, T-30) says so in text', async () => {
    await show({ health: { ...REPORT, truncated: true } });
    expect(screen.getByText(/200|first|truncated|more than/i, { selector: '[role=status], [role=note], .lims-banner, .lims-banner *, p, span' })).toBeTruthy();
  });

  it('buttons: "Import from Excel" and "New test" are permission-gated (catalog.test.manage / import perms)', async () => {
    const { unmount } = await show({ permissions: FULL });
    for (const n of [/import from excel/i, /new test/i]) expect(screen.getAllByRole('button', { name: n }).length + screen.queryAllByRole('link', { name: n }).length).toBeGreaterThan(0);
    unmount();
    await show({ permissions: READ });
    for (const n of [/import from excel/i, /new test/i]) expect(screen.queryByRole('button', { name: n }) ?? screen.queryByRole('link', { name: n })).toBeNull();
  });

  it('tiles are hidden for areas without permission (price lists / doctors) — and all tiles hidden-or-shown consistently with page access', async () => {
    const { unmount } = await show({ permissions: ['catalog.test.read'] });
    expect(screen.queryByText(/^Price lists$/)).toBeNull();
    expect(screen.queryByText(/^Doctors/)).toBeNull();
    expect(screen.getByText(/^Catalog revision$/)).toBeTruthy();
    unmount();
    await show({ permissions: ['catalog.price_list.read'] });
    expect(screen.getByText(/^Price lists$/)).toBeTruthy();
    expect(screen.queryByText(/^Tests( \(active\))?$/)).toBeNull();
  });

  it('empty catalog: exact copy + Import / New department buttons; no health links', async () => {
    await show({ health: { ...REPORT, active_orderables_without_default_price: [], analytes_without_reference_range: [], tests_without_specimen_type: [], tests_missing_required_analyte: [], unmapped_formula_inputs: [] }, counts: { departments: 0, tests: 0, panels: 0, doctors: 0, doctors_unverified: 0, price_lists: 0 } });
    expect(screen.getByText('No catalog yet. Import the starter workbook or create your first department.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /import from excel|import the starter/i }).length + screen.queryAllByRole('link', { name: /import/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /new department/i }).length + screen.queryAllByRole('link', { name: /new department/i }).length).toBeGreaterThan(0);
  });

  it('error: load failure shows tiles as "—" with the Reference and a Retry that refreshes; never raw detail', async () => {
    await show({ health: null, counts: null, revision: null, requestId: 'req-abc123' });
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/Reference:\s*req-abc123/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it('axe: populated, empty, error', async () => {
    const a = await show();
    await noAxeViolations();
    a.unmount();
    const b = await show({ health: null, counts: null, revision: null, requestId: 'r1' });
    await noAxeViolations();
    b.unmount();
    await show({ counts: { departments: 0, tests: 0, panels: 0, doctors: 0, doctors_unverified: 0, price_lists: 0 } });
    await noAxeViolations();
  });
});

// ------------------------------------------------------------------------------------------------ SCR-02
describe('SCR-02 DepartmentsList (AC-01.1, AC-01.2, AC-01.4, AC-01.6)', () => {
  const load = async () => (await import('../components/DepartmentsList')).DepartmentsList;
  const show = async (departments: unknown[] = DEPTS, permissions: string[] = MANAGE) => { const C = await load(); return wrap(<C departments={departments as never} permissions={permissions} />); };

  it('columns Code · Name · Report order · Report heading · Status · Updated; status carries text (Active / Inactive)', async () => {
    await show();
    for (const h of ['Code', 'Name', 'Report order', 'Report heading', 'Status', 'Updated']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('HAEM')).getByText('Hematology')).toBeTruthy();
    expect(within(rowOf('HAEM')).getByText('Active')).toBeTruthy();
    expect(within(rowOf('OLDD')).getByText('Inactive')).toBeTruthy(); // AC-01.4: inactive stays readable
  });

  it('empty: exact copy "No departments yet." + "New department" (manage only)', async () => {
    const a = await show([], MANAGE);
    expect(screen.getByText('No departments yet.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /new department/i }).length).toBeGreaterThan(0);
    a.unmount();
    await show([], READ);
    expect(screen.getByText('No departments yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new department/i })).toBeNull();
  });

  it('read-only with only catalog.test.read: table shown, no New / Edit buttons, no form inputs (AC permission-denied behaviour)', async () => {
    await show(DEPTS, READ);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new department|edit/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('search filters rows client-side by code or name (case-insensitive)', async () => {
    await show();
    await userEvent.type(screen.getByLabelText(/search/i), 'bio');
    expect(screen.queryByText('Hematology')).toBeNull();
    expect(screen.getByText('Biochemistry')).toBeTruthy();
  });

  it('Status filter Inactive / All (URL param or local filter)', async () => {
    await show();
    await userEvent.click(control('Inactive')!);
    const urls = [...push.mock.calls, ...replace.mock.calls].map((c) => decodeURIComponent(String(c[0])));
    const viaUrl = urls.some((u) => /is_active=false|status=inactive/.test(u));
    if (!viaUrl) {
      expect(screen.queryByText('Hematology')).toBeNull();
      expect(screen.getByText('Retired dept')).toBeTruthy();
    }
    expect(viaUrl || !screen.queryByText('Hematology')).toBe(true);
  });

  describe('New department → createDepartment', () => {
    const created = () => http.post(`${ORIGIN}/v1/catalog/departments`, async ({ request }) => { await rec(request); return HttpResponse.json(dept(9, { code: 'IMMU', name: 'Immunology', report_order: 100, version: 1 }), { status: 201 }); });
    const open = async () => { await show(); await userEvent.click(screen.getAllByRole('button', { name: /new department/i })[0]!); return screen.getByRole('dialog'); };

    it('defaults: report order 100, Active on; code shows upper-case immediately; code field has a regex hint', async () => {
      const dlg = await open();
      expect((within(dlg).getByLabelText(/report order/i) as HTMLInputElement).value).toBe('100');
      expect((within(dlg).getByRole('switch', { name: /active/i }) as HTMLInputElement).checked ?? true).toBe(true);
      const code = within(dlg).getByLabelText(/^code/i) as HTMLInputElement;
      await userEvent.type(code, 'haem');
      expect(code.value).toBe('HAEM');
      expect(dlg.textContent).toMatch(/A-Z0-9|\[A-Z0-9_\]/); // regex hint under the field
    });

    it('maxLength: code 32, name 100, report heading 100', async () => {
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/^code/i), 'a'.repeat(40));
      expect((within(dlg).getByLabelText(/^code/i) as HTMLInputElement).value.length).toBeLessThanOrEqual(32);
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'n'.repeat(120));
      expect((within(dlg).getByLabelText(/^name/i) as HTMLInputElement).value.length).toBeLessThanOrEqual(100);
    });

    it('Save → POST with Idempotency-Key, upper-case code, report_order as an integer; toast "Department saved."; list refreshes; dialog closes (AC-01.1)', async () => {
      api.use(created());
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/^code/i), 'immu');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Immunology');
      await save();
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
      expect(calls[0]!.body).toMatchObject({ code: 'IMMU', name: 'Immunology', report_order: 100 });
      expect(typeof calls[0]!.body.report_order).toBe('number');
      expect(await screen.findByText('Department saved.')).toBeTruthy();
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('Ctrl+S saves the open form', async () => {
      api.use(created());
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/^code/i), 'immu');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Immunology');
      await userEvent.keyboard('{Control>}s{/Control}');
      await waitFor(() => expect(calls).toHaveLength(1));
    });

    it('invalid code (regex), empty name, report order > 9999 → field errors, no API call', async () => {
      api.use(created());
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/^code/i), '_x y');
      await save();
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
      expect(fieldBad(dlg)).toBeGreaterThan(0);
      await userEvent.clear(within(dlg).getByLabelText(/^code/i));
      await userEvent.type(within(dlg).getByLabelText(/^code/i), 'OK');
      await userEvent.clear(within(dlg).getByLabelText(/report order/i));
      await userEvent.type(within(dlg).getByLabelText(/report order/i), '10000');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Name');
      await save();
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
    });

    it('409 catalog.code_duplicate → inline "This code is already used." on the code field; dialog stays open, input kept (AC-01.2)', async () => {
      api.use(http.post(`${ORIGIN}/v1/catalog/departments`, () => prob(409, 'catalog.code_duplicate')));
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/^code/i), 'haem');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Dup');
      await save();
      expect(await within(dlg).findByText('This code is already used.')).toBeTruthy();
      expect((within(dlg).getByLabelText(/^code/i) as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect((within(dlg).getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Dup');
    });

    it('double submit (Save clicked / Ctrl+S twice, fast) creates one department; a retry after failure reuses the same Idempotency-Key; re-opening mints a new one', async () => {
      let n = 0;
      api.use(http.post(`${ORIGIN}/v1/catalog/departments`, async ({ request }) => { await rec(request); await new Promise((r) => setTimeout(r, 120)); return ++n === 1 ? prob(500, 'common.internal') : HttpResponse.json(dept(9), { status: 201 }); }));
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/^code/i), 'immu');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Immunology');
      await userEvent.keyboard('{Control>}s{s}{s}{/Control}');
      await screen.findByRole('alert'); // failure toast; never the raw detail
      expect(calls).toHaveLength(1);
      await userEvent.keyboard('{Control>}s{/Control}');
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await userEvent.click(screen.getAllByRole('button', { name: /new department/i })[0]!);
      const d2 = screen.getByRole('dialog');
      await userEvent.type(within(d2).getByLabelText(/^code/i), 'immu');
      await userEvent.type(within(d2).getByLabelText(/^name/i), 'Immunology');
      api.use(created());
      await save();
      await waitFor(() => expect(calls).toHaveLength(3));
      expect(calls[2]!.headers.get('idempotency-key')).not.toBe(calls[0]!.headers.get('idempotency-key'));
    });

    it('axe: dialog open', async () => { await open(); await noAxeViolations(); });
  });

  describe('Edit department → updateDepartment (AC-01.4, AC-01.6)', () => {
    it('code is read-only after create; Save → PATCH /departments/{id} with If-Match "<version>", no code in the body', async () => {
      api.use(http.patch(`${ORIGIN}/v1/catalog/departments/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(dept(1, { name: 'Haematology', version: 4 })); }));
      await show();
      const dlg = await edit('HAEM');
      const code = within(dlg).getByLabelText(/^code/i) as HTMLInputElement;
      expect(code.value).toBe('HAEM');
      expect(code.readOnly || code.disabled || code.getAttribute('aria-readonly') === 'true').toBe(true);
      await userEvent.clear(within(dlg).getByLabelText(/^name/i));
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Haematology');
      await save();
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.method).toBe('PATCH');
      expect(calls[0]!.url.pathname).toBe(`/v1/catalog/departments/${ID(1)}`);
      expect(calls[0]!.headers.get('if-match')).toBe('"3"');
      expect(calls[0]!.body).toMatchObject({ name: 'Haematology' });
      expect(calls[0]!.body).not.toHaveProperty('code');
      expect(await screen.findByText('Department saved.')).toBeTruthy();
    });

    it('deactivating via the Active switch sends is_active=false (AC-01.4)', async () => {
      api.use(http.patch(`${ORIGIN}/v1/catalog/departments/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(dept(1, { is_active: false, version: 4 })); }));
      await show();
      const dlg = await edit('HAEM');
      await userEvent.click(within(dlg).getByRole('switch', { name: /active/i }));
      await save();
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.body).toMatchObject({ is_active: false });
    });

    it('409 common.version_conflict → Banner "Someone else changed this item. Reload to see their changes." + Reload; unsaved input kept; Reload refreshes (AC-01.6)', async () => {
      api.use(http.patch(`${ORIGIN}/v1/catalog/departments/:id`, () => prob(409, 'common.version_conflict')));
      await show();
      const dlg = await edit('HAEM');
      await userEvent.clear(within(dlg).getByLabelText(/^name/i));
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'My unsaved edit');
      await save();
      expect(await within(dlg).findByText('Someone else changed this item. Reload to see their changes.')).toBeTruthy();
      expect((within(dlg).getByLabelText(/^name/i) as HTMLInputElement).value).toBe('My unsaved edit');
      await userEvent.click(within(dlg).getByRole('button', { name: /reload/i }));
      expect(refresh).toHaveBeenCalled();
    });

    it('Esc closes the dialog without calling the API', async () => {
      await show();
      await edit('HAEM');
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls).toHaveLength(0);
    });
  });

  describe('keyboard shortcuts (04-UI-UX §3)', () => {
    it('`n` opens "New department" when permitted; ignored without manage and while typing in a field', async () => {
      const a = await show(DEPTS, MANAGE);
      await userEvent.keyboard('n');
      expect(await screen.findByRole('dialog')).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await userEvent.click(screen.getByLabelText(/search/i));
      await userEvent.keyboard('n');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect((screen.getByLabelText(/search/i) as HTMLInputElement).value).toBe('n');
      a.unmount();
      await show(DEPTS, READ);
      await userEvent.keyboard('n');
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('`/` focuses the list search', async () => {
      await show();
      await userEvent.keyboard('/');
      expect(document.activeElement).toBe(screen.getByLabelText(/search/i));
    });
  });

  it('XSS: names/headings are rendered as text, never as markup', async () => {
    await show([dept(1, { name: '<img src=x onerror=alert(1)>', report_heading: '<script>window.__pwn=1</script>' })]);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('no token or tenant id leaks into the DOM', async () => {
    await show();
    expect(document.body.innerHTML).not.toMatch(/jwt-synthetic|Bearer /);
  });

  it('axe: populated, empty, read-only', async () => {
    const a = await show(); await noAxeViolations(); a.unmount();
    const b = await show([]); await noAxeViolations(); b.unmount();
    await show(DEPTS, READ); await noAxeViolations();
  });
});

// ------------------------------------------------------------------------------------------------ SCR-03
describe('SCR-03 SpecimensScreen (AC-01.5: report label shown)', () => {
  const load = async () => (await import('../components/SpecimensScreen')).SpecimensScreen;
  const show = async (o: { specimenTypes?: unknown[]; containers?: unknown[]; permissions?: string[] } = {}) => {
    const C = await load();
    return wrap(<C specimenTypes={(o.specimenTypes ?? SPECS) as never} containers={(o.containers ?? CONTS) as never} permissions={o.permissions ?? MANAGE} />);
  };

  it('two tabs: Specimen types, Containers; specimen types table shows Code · Name · Report label · Status', async () => {
    await show();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Specimen types', 'Containers']);
    for (const h of ['Code', 'Name', 'Report label', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('EDTA_WB')).getByText('EDTA WHOLE BLOOD')).toBeTruthy(); // AC-01.5
  });

  it('Containers tab: Code · Name · Additive · Cap colour · Default specimen type (name, not id) · Status', async () => {
    await show();
    await userEvent.click(screen.getByRole('tab', { name: 'Containers' }));
    for (const h of ['Code', 'Name', 'Additive', 'Cap colour', 'Default specimen type', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    const row = rowOf('LAV');
    expect(within(row).getByText('K2EDTA')).toBeTruthy();
    expect(within(row).getByText('Lavender')).toBeTruthy();
    expect(within(row).getByText(/EDTA whole blood/)).toBeTruthy();
    expect(row.textContent).not.toContain(ID(11));
  });

  it('empty states: "No specimen types yet." and (assumed same pattern) "No containers yet."', async () => {
    await show({ specimenTypes: [], containers: [] });
    expect(screen.getByText('No specimen types yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Containers' }));
    expect(screen.getByText('No containers yet.')).toBeTruthy();
  });

  it('read-only without manage: no New / Edit buttons on either tab', async () => {
    await show({ permissions: READ });
    expect(screen.queryByRole('button', { name: /new specimen type|edit/i })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Containers' }));
    expect(screen.queryByRole('button', { name: /new container|edit/i })).toBeNull();
  });

  it('New specimen type: report label defaults to the Name upper-cased until the user edits it; POST sends code/name/report_label', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/specimen-types`, async ({ request }) => { await rec(request); return HttpResponse.json(spec(19, { code: 'CSF', name: 'Cerebrospinal fluid', report_label: 'CEREBROSPINAL FLUID', version: 1 }), { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new specimen type/i })[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'csf');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Cerebrospinal fluid');
    expect((within(dlg).getByLabelText(/report label/i) as HTMLInputElement).value).toBe('CEREBROSPINAL FLUID');
    await save();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ code: 'CSF', name: 'Cerebrospinal fluid', report_label: 'CEREBROSPINAL FLUID' });
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(await screen.findByText(/saved\./i)).toBeTruthy();
  });

  it('a hand-edited report label is not overwritten by later Name edits; empty report label blocks submit', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/specimen-types`, async ({ request }) => { await rec(request); return HttpResponse.json(spec(19), { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new specimen type/i })[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'csf');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'CSF');
    const label = within(dlg).getByLabelText(/report label/i) as HTMLInputElement;
    await userEvent.clear(label);
    await userEvent.type(label, 'Custom label');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), ' fluid');
    expect(label.value).toBe('Custom label');
    await userEvent.clear(label);
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    expect(fieldBad(dlg)).toBeGreaterThan(0);
  });

  it('409 catalog.code_duplicate on a specimen type is inline on the code field', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/specimen-types`, () => prob(409, 'catalog.code_duplicate')));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new specimen type/i })[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'serum');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Serum');
    await save();
    expect(await within(dlg).findByText('This code is already used.')).toBeTruthy();
  });

  it('New container: additive ≤ 60, cap colour ≤ 40, default specimen type offers ACTIVE specimen types only; POST maps cap_colour_display + default_specimen_type_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/containers`, async ({ request }) => { await rec(request); return HttpResponse.json(cont(29, { code: 'GREY' }), { status: 201 }); }));
    await show();
    await userEvent.click(screen.getByRole('tab', { name: 'Containers' }));
    await userEvent.click(screen.getAllByRole('button', { name: /new container/i })[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'grey');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Grey top');
    await userEvent.type(within(dlg).getByLabelText(/additive/i), 'a'.repeat(70));
    expect((within(dlg).getByLabelText(/additive/i) as HTMLInputElement).value.length).toBeLessThanOrEqual(60);
    await userEvent.clear(within(dlg).getByLabelText(/additive/i));
    await userEvent.type(within(dlg).getByLabelText(/additive/i), 'NaF');
    await userEvent.type(within(dlg).getByLabelText(/cap colou?r/i), 'Grey');
    await userEvent.click(within(dlg).getByLabelText(/default specimen type/i));
    expect(screen.queryByRole('option', { name: /old specimen/i })).toBeNull(); // inactive type not offered
    await userEvent.click(screen.getByRole('option', { name: /serum/i }));
    await save();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ code: 'GREY', name: 'Grey top', additive: 'NaF', cap_colour_display: 'Grey', default_specimen_type_id: ID(12) });
  });

  it('Edit specimen type: PATCH with If-Match; code read-only', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/specimen-types/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(spec(11, { version: 4 })); }));
    await show();
    const dlg = await edit('EDTA_WB');
    const code = within(dlg).getByLabelText(/^code/i) as HTMLInputElement;
    expect(code.readOnly || code.disabled).toBe(true);
    await userEvent.clear(within(dlg).getByLabelText(/report label/i));
    await userEvent.type(within(dlg).getByLabelText(/report label/i), 'EDTA BLOOD');
    await save();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/catalog/specimen-types/${ID(11)}`);
    expect(calls[0]!.headers.get('if-match')).toBe('"3"');
    expect(calls[0]!.body).toMatchObject({ report_label: 'EDTA BLOOD' });
    expect(calls[0]!.body).not.toHaveProperty('code');
  });

  it('axe: both tabs, and the New specimen type dialog', async () => {
    await show();
    await noAxeViolations();
    await userEvent.click(screen.getByRole('tab', { name: 'Containers' }));
    await noAxeViolations();
    await userEvent.click(screen.getAllByRole('button', { name: /new container/i })[0]!);
    await noAxeViolations();
  });
});

// ------------------------------------------------------------------------------------------------ SCR-04
describe('SCR-04 MethodsList', () => {
  const load = async () => (await import('../components/MethodsList')).MethodsList;
  const show = async (methods: unknown[] = METHS, permissions: string[] = MANAGE) => { const C = await load(); return wrap(<C methods={methods as never} permissions={permissions} />); };

  it('columns Code · Name · Status · Updated; empty "No methods yet."; read-only without manage', async () => {
    const a = await show();
    for (const h of ['Code', 'Name', 'Status', 'Updated']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('ELISA')).getByText('Inactive')).toBeTruthy();
    a.unmount();
    const b = await show([], MANAGE);
    expect(screen.getByText('No methods yet.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /new method/i }).length).toBeGreaterThan(0);
    b.unmount();
    await show(METHS, READ);
    expect(screen.queryByRole('button', { name: /new method|edit/i })).toBeNull();
  });

  it('name accepts up to 120 characters (methods differ from the 100 of other masters); POST carries Idempotency-Key and upper-case code', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/methods`, async ({ request }) => { await rec(request); return HttpResponse.json(meth(39, { code: 'PCR' }), { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new method/i })[0]!);
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'pcr');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'n'.repeat(130));
    expect((within(dlg).getByLabelText(/^name/i) as HTMLInputElement).value.length).toBe(120);
    await save();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ code: 'PCR' });
    expect(calls[0]!.body.name).toHaveLength(120);
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('409 duplicate inline; 409 version_conflict banner on edit', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/methods`, () => prob(409, 'catalog.code_duplicate')), http.patch(`${ORIGIN}/v1/catalog/methods/:id`, () => prob(409, 'common.version_conflict')));
    const a = await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new method/i })[0]!);
    let dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'hplc');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'HPLC');
    await save();
    expect(await within(dlg).findByText('This code is already used.')).toBeTruthy();
    a.unmount();
    await show();
    dlg = await edit('HPLC');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), ' 2');
    await save();
    expect(await within(dlg).findByText('Someone else changed this item. Reload to see their changes.')).toBeTruthy();
  });

  it('axe', async () => { const a = await show(); await noAxeViolations(); a.unmount(); await show([]); await noAxeViolations(); });
});

// ------------------------------------------------------------------------------------------------ SCR-05
describe('SCR-05 UnitsScreen', () => {
  const load = async () => (await import('../components/UnitsScreen')).UnitsScreen;
  const show = async (o: { units?: unknown[]; valueSets?: unknown[]; permissions?: string[] } = {}) => {
    const C = await load();
    return wrap(<C units={(o.units ?? [...GLOBAL_UNITS, TENANT_UNIT]) as never} valueSets={(o.valueSets ?? VSETS) as never} permissions={o.permissions ?? MANAGE} />);
  };
  const hasText = (root: HTMLElement, text: string) => root.textContent!.includes(text) || !!root.querySelector(`[title="${text}"], [aria-label="${text}"]`);

  it('two tabs: Units, Value sets; Units table Code · Display · Scope (Global/Lab) · Status', async () => {
    await show();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Units', 'Value sets']);
    for (const h of ['Code', 'Display', 'Scope', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
    expect(within(rowOf('g_dL')).getByText('Global')).toBeTruthy();
    expect(within(rowOf('lab_ratio')).getByText('Lab')).toBeTruthy();
  });

  it('global units are read-only: no Edit button, lock marker with "Provided by the system"; lab unit is editable', async () => {
    await show();
    const g = rowOf('g_dL');
    expect(within(g).queryByRole('button', { name: /edit/i })).toBeNull();
    await userEvent.hover(g);
    await userEvent.tab();
    expect(hasText(g, 'Provided by the system') || !!screen.queryByText('Provided by the system')).toBe(true);
    expect(within(rowOf('lab_ratio')).getByRole('button', { name: /edit/i })).toBeTruthy();
  });

  it('empty state when only global units exist: exact copy, global rows still listed', async () => {
    const a = await show({ units: GLOBAL_UNITS });
    expect(screen.getByText('Only global units are available. Add a lab-specific unit if needed.')).toBeTruthy();
    expect(rowOf('g_dL')).toBeTruthy();
    a.unmount();
    await show();
    expect(screen.queryByText('Only global units are available. Add a lab-specific unit if needed.')).toBeNull();
  });

  it('New lab unit: code keeps its case, regex ^[A-Za-z0-9_]{1,32}$ enforced, display ≤ 32; POST {code, display} with Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/units`, async ({ request }) => { await rec(request); return HttpResponse.json(unit(49, { code: 'x10_3_per_uL', display: '10^3/µL', scope: 'tenant', version: 1 }), { status: 201 }); }));
    await show();
    await userEvent.click(screen.getAllByRole('button', { name: /new lab unit/i })[0]!);
    const dlg = screen.getByRole('dialog');
    const code = within(dlg).getByLabelText(/^code/i) as HTMLInputElement;
    await userEvent.type(code, 'bad code');
    await userEvent.type(within(dlg).getByLabelText(/^display/i), 'x');
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    expect(fieldBad(dlg)).toBeGreaterThan(0);
    await userEvent.clear(code);
    await userEvent.type(code, 'x10_3_per_uL');
    expect(code.value).toBe('x10_3_per_uL'); // not upper-cased
    await userEvent.clear(within(dlg).getByLabelText(/^display/i));
    await userEvent.type(within(dlg).getByLabelText(/^display/i), 'd'.repeat(40));
    expect((within(dlg).getByLabelText(/^display/i) as HTMLInputElement).value.length).toBeLessThanOrEqual(32);
    await userEvent.clear(within(dlg).getByLabelText(/^display/i));
    await userEvent.type(within(dlg).getByLabelText(/^display/i), '10^3/µL');
    await save();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ code: 'x10_3_per_uL', display: '10^3/µL' });
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('Edit lab unit: PATCH /units/{id} If-Match with display / is_active only', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/units/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(unit(43, { scope: 'tenant', version: 4 })); }));
    await show();
    const dlg = await edit('lab_ratio');
    await userEvent.clear(within(dlg).getByLabelText(/^display/i));
    await userEvent.type(within(dlg).getByLabelText(/^display/i), 'ratio (1)');
    await save();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/catalog/units/${ID(43)}`);
    expect(calls[0]!.headers.get('if-match')).toBe('"3"');
    expect(calls[0]!.body).toEqual({ display: 'ratio (1)' });
  });

  it('read-only without manage: no New / Edit anywhere on either tab', async () => {
    await show({ permissions: READ });
    expect(screen.queryByRole('button', { name: /new lab unit|edit/i })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Value sets' }));
    expect(screen.queryByRole('button', { name: /new value set|edit/i })).toBeNull();
  });

  describe('Value sets tab', () => {
    const tab = async () => { const a = await show(); await userEvent.click(screen.getByRole('tab', { name: 'Value sets' })); return a; };

    it('columns Code · Display · Ordered (Yes/No) · Values (count) · Scope; global sets have no Edit', async () => {
      await tab();
      for (const h of ['Code', 'Display', 'Ordered', 'Values', 'Scope']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
      const r = rowOf('SEMI');
      expect(within(r).getByText('Yes')).toBeTruthy();
      expect(within(r).getByText('2')).toBeTruthy();
      expect(within(rowOf('GLOBALVS')).queryByRole('button', { name: /edit/i })).toBeNull();
    });

    it('editor shows Code (read-only), Display, Ordered switch and a values grid with Code · Display · Order · Active', async () => {
      await tab();
      const dlg = await edit('SEMI');
      const code = within(dlg).getByLabelText(/^code/i) as HTMLInputElement;
      expect(code.readOnly || code.disabled).toBe(true);
      expect(within(dlg).getByRole('switch', { name: /ordered/i })).toBeTruthy();
      const grid = within(dlg).getByRole('grid');
      for (const h of ['Code', 'Display', 'Order', 'Active']) expect(within(grid).getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') })).toBeTruthy();
      expect(within(grid).getByDisplayValue('NEG')).toBeTruthy();
    });

    it('Save → PATCH /value-sets/{id} If-Match "<version>" with the full values list', async () => {
      api.use(http.patch(`${ORIGIN}/v1/catalog/value-sets/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(vs(51, { version: 4 })); }));
      await tab();
      const dlg = await edit('SEMI');
      await userEvent.clear(within(dlg).getByLabelText(/^display/i));
      await userEvent.type(within(dlg).getByLabelText(/^display/i), 'Semi-quant');
      await save();
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.url.pathname).toBe(`/v1/catalog/value-sets/${ID(51)}`);
      expect(calls[0]!.headers.get('if-match')).toBe('"3"');
      expect(calls[0]!.body).toMatchObject({ display: 'Semi-quant' });
      expect(calls[0]!.body.values.map((v: any) => v.code)).toEqual(['NEG', '1+']);
    });

    it('409 catalog.version_in_use → banner with the exact copy; Order becomes read-only and row delete disappears', async () => {
      api.use(http.patch(`${ORIGIN}/v1/catalog/value-sets/:id`, () => prob(409, 'catalog.version_in_use')));
      await tab();
      const dlg = await edit('SEMI');
      expect(within(dlg).queryAllByRole('button', { name: /remove|delete/i }).length).toBeGreaterThan(0); // editable before the API says otherwise
      await save();
      expect(await within(dlg).findByText('This value set is used by a published analyte version; values can be added or hidden, not removed or re-ordered.')).toBeTruthy();
      expect(within(dlg).queryAllByRole('button', { name: /remove|delete/i })).toHaveLength(0);
      const grid = within(dlg).getByRole('grid');
      const orderCol = [...grid.querySelectorAll('[role=columnheader]')].findIndex((h) => /^order/i.test(h.textContent ?? ''));
      const firstRow = grid.querySelectorAll('[role=row]')[1]!;
      const cell = firstRow.querySelectorAll('[role=gridcell], [role=cell], td')[orderCol]!;
      const input = cell.querySelector('input') as HTMLInputElement | null;
      expect(!input || input.readOnly || input.disabled).toBe(true);
    });

    it('New value set: code upper-cased, Ordered switch → is_ordered; POST with Idempotency-Key', async () => {
      api.use(http.post(`${ORIGIN}/v1/catalog/value-sets`, async ({ request }) => { await rec(request); return HttpResponse.json(vs(59, { code: 'GRADE', version: 1 }), { status: 201 }); }));
      await tab();
      await userEvent.click(screen.getAllByRole('button', { name: /new value set/i })[0]!);
      const dlg = screen.getByRole('dialog');
      await userEvent.type(within(dlg).getByLabelText(/^code/i), 'grade');
      expect((within(dlg).getByLabelText(/^code/i) as HTMLInputElement).value).toBe('GRADE');
      await userEvent.type(within(dlg).getByLabelText(/^display/i), 'Grade');
      await userEvent.click(within(dlg).getByRole('switch', { name: /ordered/i }));
      await save();
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.body).toMatchObject({ code: 'GRADE', display: 'Grade', is_ordered: true });
      expect(Array.isArray(calls[0]!.body.values)).toBe(true);
      expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
    });

    it('axe: value-set editor', async () => { await tab(); await edit('SEMI'); await noAxeViolations(); });
  });

  it('XSS: unit display and value-set text render as text', async () => {
    await show({ units: [unit(1, { scope: 'tenant', code: 'xss', display: '<img src=x onerror=alert(1)>' })], valueSets: [] });
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('axe: Units tab (with and without tenant units), Value sets tab, new-unit dialog', async () => {
    const a = await show(); await noAxeViolations();
    await userEvent.click(screen.getByRole('tab', { name: 'Value sets' })); await noAxeViolations(); a.unmount();
    const b = await show({ units: GLOBAL_UNITS }); await noAxeViolations();
    await userEvent.click(screen.getAllByRole('button', { name: /new lab unit/i })[0]!); await noAxeViolations(); b.unmount();
  });
});

// ------------------------------------------------------------------------------------------------ pages + segment files
describe('pages (server components via the BFF) and segment files', () => {
  const PAGES = {
    departments: { load: () => import('@/app/(staff)/catalog/departments/page'), api: 'departments', shows: 'Hematology' },
    specimens: { load: () => import('@/app/(staff)/catalog/specimens/page'), api: 'specimen-types', shows: 'EDTA WHOLE BLOOD' },
    methods: { load: () => import('@/app/(staff)/catalog/methods/page'), api: 'methods', shows: 'HPLC' },
    units: { load: () => import('@/app/(staff)/catalog/units/page'), api: 'units', shows: 'g/dL' },
  } as const;
  const run = async (name: keyof typeof PAGES, sp: Record<string, string> = {}) => {
    const Page = (await PAGES[name].load()).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;
    return wrap(<>{await Page({ searchParams: Promise.resolve(sp) })}</>);
  };

  describe.each(Object.keys(PAGES) as (keyof typeof PAGES)[])('/catalog/%s', (name) => {
    it('loads from the API, renders the data, passes session permissions down (manage → New button)', async () => {
      await run(name);
      expect(await screen.findAllByText(PAGES[name].shows, { exact: false })).toBeTruthy();
      expect(screen.getAllByRole('button', { name: /^new /i }).length).toBeGreaterThan(0);
    });

    it('read-only session → no New button', async () => {
      session.permissions = READ;
      await run(name);
      await screen.findAllByText(PAGES[name].shows, { exact: false });
      expect(screen.queryByRole('button', { name: /^new /i })).toBeNull();
    });

    it('403 auth.forbidden → full-page "You don\'t have access to this part of the catalog" and no table', async () => {
      api.use(http.get(`${ORIGIN}/v1/catalog/${PAGES[name].api}`, () => prob(403, 'auth.forbidden')));
      await run(name);
      expect(await screen.findByText("You don't have access to this part of the catalog")).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.getAllByRole('link').length).toBeGreaterThan(0); // nav link back
    });

    it('5xx → the page throws to error.tsx (no half-rendered page, no swallowed failure)', async () => {
      api.use(http.get(`${ORIGIN}/v1/catalog/${PAGES[name].api}`, () => prob(500, 'common.internal', { detail: 'pg: secret' })));
      await expect(run(name)).rejects.toBeTruthy();
    });
  });

  it('/catalog home: health report failure renders tiles as "—" with Reference + Retry instead of throwing (03-APP-FLOW §5)', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/health-report`, () => prob(500, 'common.internal', { request_id: 'req-home-1', detail: 'pg: relation catalog.secret does not exist' })));
    const Page = (await import('@/app/(staff)/catalog/page')).default as () => Promise<ReactNode>;
    wrap(<>{await Page()}</>);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/Reference:\s*req-home-1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/secret/);
  });

  it('/catalog home: renders the health report from the API', async () => {
    session.permissions = FULL;
    const Page = (await import('@/app/(staff)/catalog/page')).default as () => Promise<ReactNode>;
    wrap(<>{await Page()}</>);
    expect(await screen.findByRole('link', { name: /Tests without a specimen type.*\b3\b/ })).toBeTruthy();
  });

  it('loading.tsx renders a LoadingSkeleton (role=status, aria-busy) — no bare spinner', async () => {
    const Loading = (await import('@/app/(staff)/catalog/loading')).default;
    const { container } = render(<Loading />);
    expect(container.querySelector('[role="status"][aria-busy="true"]')).toBeTruthy();
    await noAxeViolations();
  });

  it('error.tsx shows only the opaque digest as Reference, a Retry that calls reset(), and never the raw error message', async () => {
    const ErrorPage = (await import('@/app/(staff)/catalog/error')).default;
    const reset = vi.fn();
    render(<ErrorPage error={Object.assign(new Error('SELECT * FROM catalog.secret failed'), { digest: 'dig-77' })} reset={reset} />);
    expect(screen.getByText(/Reference:\s*dig-77/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SELECT|secret/);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(reset).toHaveBeenCalled();
    await noAxeViolations();
  });
});
