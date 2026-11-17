// @vitest-environment jsdom
// T0D-TESTMGMT-1 items (6) and (7) — category, popular test, complete test list, notes, profile and package (two list picker), light and keyboard usable.
// No route is added and nav.manifest.ts gets NO new entry: nav-complete.catalog.test.ts pins 15 entries and exactly one entry under /catalog/tests.
// The test management views live on /catalog/tests behind a tab strip. CONTRACT:
//   tab strip  : role=tablist named /test management/i; tabs "Test details" (?view=details), "Complete test list" (no view param), "Categories" (?view=categories),
//                "Popular tests" (?view=popular); the shown tab is aria-selected. Tabs are links or tab buttons that navigate (router.push/replace).
//   categories : table columns Name, Department, Display order, Print footer, Footer text, Status (drawn when empty). Button "New category" -> role=dialog
//                (Name*, Department*, Display order, Print footer, Footer text) -> POST /v1/catalog/test-categories. Deactivate -> PATCH {is_active:false} with
//                If-Match (never DELETE). 409 catalog.code_duplicate shown inline. Needs catalog.test.manage.
//   popular    : table columns Code, Name, Short name (drawn when empty); rows = tests whose GET /v1/catalog/tests/{id}.is_popular is true; an "Add popular
//                test" picker -> PATCH {is_popular:true}; row button "Remove" -> PATCH {is_popular:false}; both with If-Match.
//   complete   : the plain list keeps its first five columns (cattests1) and ADDS Short name, Category, Price (default_price_paisa as NPR with 2 decimals).
//   notes      : /catalog/comment-codes New comment code dialog gains Type (result_type), Default template (is_default_template), Text format (plain|markdown).
//   profile    : /catalog/panels/{id} Members editor = two list picker: listbox "Available tests" and listbox "Selected tests" with buttons Add, Add all,
//                Remove, Remove all, then Save members -> PUT /v1/catalog/panels/{id}/members {members:[{kind, orderable_id, sort_order}]} with If-Match.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { api, BIOC, calls, callsTo, CAT1, CAT2, HAEM, ID, lastAddress, loadTests, MANAGE, READ, reset, S, show, TM, testDetail } from './testmgmt1.harness';

const HB = testDetail(1, 'HB', 'Hemoglobin', { is_popular: true, short_name: 'Hb' });
const CBC = testDetail(2, 'CBC', 'Complete blood count', { is_popular: false, short_name: 'CBC' });
const GLU = testDetail(3, 'GLU', 'Glucose fasting', { department_id: BIOC.id, is_popular: true, short_name: 'Glu', category_id: CAT2.id });

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { reset(); loadTests(HB, CBC, GLU); });
afterEach(() => { cleanup(); api.resetHandlers(); });

const heads = (root: HTMLElement | Document = document.body) => within(root as HTMLElement).getAllByRole('columnheader').map((h) => h.textContent?.trim());
const off = (b: HTMLElement | null) => !b || b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true';
const noAxe = async () => { const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }); expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]); };

describe('tab strip on /catalog/tests (item 6)', () => {
  it('has the four tabs, the plain list is the Complete test list', async () => {
    await show('tests');
    const tl = await screen.findByRole('tablist', { name: /test management/i });
    expect(within(tl).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Test details', 'Complete test list', 'Categories', 'Popular tests']);
    expect(within(tl).getByRole('tab', { name: 'Complete test list' }).getAttribute('aria-selected')).toBe('true');
  });
  it.each([['Test details', 'details'], ['Categories', 'categories'], ['Popular tests', 'popular']])('%s tab navigates to view=%s', async (name, view) => {
    await show('tests');
    await userEvent.click(await screen.findByRole('tab', { name }));
    expect(lastAddress()?.pathname).toBe('/catalog/tests');
    expect(lastAddress()?.searchParams.get('view')).toBe(view);
  });
  it('the shown view is the selected tab', async () => {
    await show('tests', { search: 'view=categories' });
    expect((await screen.findByRole('tab', { name: 'Categories' })).getAttribute('aria-selected')).toBe('true');
  });
});

describe('Test Category (item 6)', () => {
  it('draws its column names with no category, and lists categories with department and footer', async () => {
    S.categories = [];
    await show('tests', { search: 'view=categories' });
    expect((await screen.findAllByRole('columnheader')).length).toBeGreaterThanOrEqual(6);
    expect(heads().slice(0, 6)).toEqual(['Name', 'Department', 'Display order', 'Print footer', 'Footer text', 'Status']);
    cleanup();
    S.categories = [CAT1, CAT2];
    await show('tests', { search: 'view=categories' });
    expect(await screen.findByText('Lipid studies')).toBeTruthy();
    const row = screen.getByText('Lipid studies').closest('tr')!;
    expect(row.textContent).toMatch(/Biochemistry/);
    expect(row.textContent).toMatch(/Fasting sample advised\./);
    expect(row.textContent).toMatch(/yes|on|print/i);
    await noAxe();
  });
  it('New category creates with POST /v1/catalog/test-categories (Idempotency-Key, department id, numbers as numbers)', async () => {
    await show('tests', { search: 'view=categories' });
    await userEvent.click(await screen.findByRole('button', { name: /^new category$/i }));
    const dlg = await screen.findByRole('dialog', { name: /new category/i });
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Hormones');
    await userEvent.click(within(dlg).getByLabelText(/^department/i));
    await userEvent.click(await screen.findByRole('option', { name: /biochemistry/i }));
    await userEvent.type(within(dlg).getByLabelText(/^display order/i), '30');
    await userEvent.click(within(dlg).getByLabelText(/^print footer/i));
    await userEvent.type(within(dlg).getByLabelText(/^footer text/i), 'Morning sample.');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(save|create)/i }));
    await waitFor(() => expect(callsTo('POST', /test-categories$/)).toHaveLength(1));
    const c = callsTo('POST', /test-categories$/)[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body).toEqual({ department_id: BIOC.id, name: 'Hormones', display_order: 30, print_footer: true, footer_text: 'Morning sample.' });
  });
  it('a duplicate name (409) is shown inline and the dialog stays open', async () => {
    S.failNext = { method: 'POST', re: /test-categories$/, status: 409, code: 'catalog.code_duplicate' };
    await show('tests', { search: 'view=categories' });
    await userEvent.click(await screen.findByRole('button', { name: /^new category$/i }));
    const dlg = await screen.findByRole('dialog', { name: /new category/i });
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Lipid studies');
    await userEvent.click(within(dlg).getByLabelText(/^department/i));
    await userEvent.click(await screen.findByRole('option', { name: /biochemistry/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(save|create)/i }));
    await waitFor(() => expect(dlg.textContent).toMatch(/already/i));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('Deactivate sends PATCH is_active:false with If-Match; a category is never deleted', async () => {
    await show('tests', { search: 'view=categories' });
    const row = (await screen.findByText('Lipid studies')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /deactivate/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /^deactivate/i }));
    await waitFor(() => expect(callsTo('PATCH', /test-categories\//)).toHaveLength(1));
    const c = callsTo('PATCH', /test-categories\//)[0]!;
    expect(c.path).toBe(`/v1/catalog/test-categories/${CAT2.id}`);
    expect(c.body).toEqual({ is_active: false });
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(calls.some((x) => x.method === 'DELETE')).toBe(false);
  });
  it('a reader sees the categories but cannot add or deactivate', async () => {
    TM.session.permissions = READ;
    await show('tests', { search: 'view=categories' });
    await screen.findByText('Lipid studies');
    expect(off(screen.queryByRole('button', { name: /^new category$/i }))).toBe(true);
    expect(screen.queryAllByRole('button', { name: /deactivate/i }).every(off)).toBe(true);
  });
});

describe('Popular test (item 6)', () => {
  it('lists only popular tests with code, name and short name; columns drawn when none', async () => {
    await show('tests', { search: 'view=popular' });
    expect(await screen.findByText('Hemoglobin')).toBeTruthy();
    expect(screen.getByText('Glucose fasting')).toBeTruthy();
    expect(screen.queryByText('Complete blood count')).toBeNull();
    expect(heads().slice(0, 3)).toEqual(['Code', 'Name', 'Short name']);
    cleanup();
    loadTests(CBC);
    await show('tests', { search: 'view=popular' });
    await waitFor(() => expect(heads().slice(0, 3)).toEqual(['Code', 'Name', 'Short name']));
  });
  it('Add popular test picks a test and PATCHes is_popular:true with If-Match; Remove PATCHes false', async () => {
    await show('tests', { search: 'view=popular' });
    await screen.findByText('Hemoglobin');
    await userEvent.click(screen.getByLabelText(/^add popular test/i));
    await userEvent.click(await screen.findByRole('option', { name: /Complete blood count/ }));
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(callsTo('PATCH', /\/v1\/catalog\/tests\//)).toHaveLength(1));
    expect(callsTo('PATCH', /\/v1\/catalog\/tests\//)[0]).toMatchObject({ path: `/v1/catalog/tests/${CBC['id']}`, body: { is_popular: true } });
    expect(callsTo('PATCH', /\/v1\/catalog\/tests\//)[0]!.headers.get('if-match')).toBeTruthy();
    const row = screen.getByText('Hemoglobin').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /^remove/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /^remove/i }));
    await waitFor(() => expect(callsTo('PATCH', /\/v1\/catalog\/tests\//)).toHaveLength(2));
    expect(callsTo('PATCH', /\/v1\/catalog\/tests\//)[1]!.body).toEqual({ is_popular: false });
  });
});

describe('Complete test list (item 6)', () => {
  it('keeps the first five columns and adds Short name, Category and Price (NPR, 2 decimals)', async () => {
    await show('tests');
    await screen.findByText('Hemoglobin');
    const h = heads(screen.getByRole('table'));
    expect(h.slice(0, 5)).toEqual(['Code', 'Name', 'Department', 'Workflow type', 'Status']);
    for (const c of ['Short name', 'Category', 'Price']) expect(h, c).toContain(c);
    const row = screen.getByText('Hemoglobin').closest('tr')!;
    expect(row.textContent).toMatch(/Hb/);
    expect(row.textContent).toMatch(/Routine haematology/);
    expect(row.textContent).toMatch(/250\.00/);
  });
});

describe('Notes (item 6)', () => {
  it('New comment code has Type, Default template and Text format; the request carries them', async () => {
    await show('comment-codes');
    await userEvent.click(await screen.findByRole('button', { name: /^new comment code$/i }));
    const dlg = await screen.findByRole('dialog');
    for (const re of [/^type/i, /^default template/i, /^(text )?format/i]) expect(within(dlg).getByLabelText(re), String(re)).toBeTruthy();
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'FAST');
    await userEvent.type(within(dlg).getByLabelText(/^text/i), 'Fasting sample required.');
    await userEvent.click(within(dlg).getByLabelText(/^type/i));
    await userEvent.click(await screen.findByRole('option', { name: /^numeric$/i }));
    await userEvent.click(within(dlg).getByLabelText(/^default template/i));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(save|create)/i }));
    await waitFor(() => expect(callsTo('POST', /comment-codes$/)).toHaveLength(1));
    expect(callsTo('POST', /comment-codes$/)[0]!.body).toMatchObject({ code: 'FAST', text: 'Fasting sample required.', result_type: 'numeric', is_default_template: true });
  });
  it('raw HTML in a note is refused by the server and the message is shown (the page does not render it)', async () => {
    S.failNext = { method: 'POST', re: /comment-codes$/, status: 422, code: 'common.validation_failed', errors: [{ path: '/text', code: 'html_not_allowed', message: 'Raw HTML is not allowed' }] };
    await show('comment-codes');
    await userEvent.click(await screen.findByRole('button', { name: /^new comment code$/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'XSS');
    await userEvent.type(within(dlg).getByLabelText(/^text/i), '<script>alert(1)</script>');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(save|create)/i }));
    expect(await within(dlg).findByText('Raw HTML is not allowed')).toBeTruthy();
    expect(document.body.querySelector('script')).toBeNull();
  });
});

describe('Profile and package: two list picker (item 6)', () => {
  const PANEL = ID(400);
  const setup = (members: { kind: 'test'; orderable_id: string; sort_order: number }[]) => {
    S.panelDetail[PANEL] = { id: PANEL, code: 'ANAEMIA', name: 'Anaemia profile', panel_kind: 'clinical', is_orderable: true, is_active: true, version: 6, members };
    S.panels = [];
  };
  const open = async () => { await show('panel', { params: { panel_id: PANEL } }); return screen.findByRole('listbox', { name: /^available tests/i }); };
  const avail = () => within(screen.getByRole('listbox', { name: /^available tests/i })).queryAllByRole('option').map((o) => o.textContent);
  const chosen = () => within(screen.getByRole('listbox', { name: /^selected tests/i })).queryAllByRole('option').map((o) => o.textContent);
  const btn = (n: RegExp) => screen.getByRole('button', { name: n });

  it('shows Available tests and Selected tests (headings drawn even when empty) and the four buttons', async () => {
    setup([]);
    await open();
    expect(chosen()).toEqual([]);
    expect(avail().length).toBe(3);
    for (const n of [/^add$/i, /^add all$/i, /^remove$/i, /^remove all$/i]) expect(btn(n)).toBeTruthy();
  });
  it('Add moves the chosen option, Add all moves everything, Remove and Remove all move back', async () => {
    setup([]);
    await open();
    await userEvent.click(within(screen.getByRole('listbox', { name: /^available tests/i })).getByRole('option', { name: /Glucose fasting/ }));
    await userEvent.click(btn(/^add$/i));
    expect(chosen().join('|')).toMatch(/Glucose fasting/);
    expect(avail().join('|')).not.toMatch(/Glucose fasting/);
    await userEvent.click(btn(/^add all$/i));
    expect(avail()).toEqual([]);
    expect(chosen()).toHaveLength(3);
    await userEvent.click(within(screen.getByRole('listbox', { name: /^selected tests/i })).getByRole('option', { name: /Hemoglobin/ }));
    await userEvent.click(btn(/^remove$/i));
    expect(avail().join('|')).toMatch(/Hemoglobin/);
    await userEvent.click(btn(/^remove all$/i));
    expect(chosen()).toEqual([]);
    expect(avail()).toHaveLength(3);
  });
  it('Save members sends PUT members in the chosen order with If-Match', async () => {
    setup([{ kind: 'test', orderable_id: String(HB['id']), sort_order: 0 }]);
    await open();
    await userEvent.click(within(screen.getByRole('listbox', { name: /^available tests/i })).getByRole('option', { name: /Glucose fasting/ }));
    await userEvent.click(btn(/^add$/i));
    await userEvent.click(btn(/^save members$/i));
    await waitFor(() => expect(callsTo('PUT', /panels\/[^/]+\/members$/)).toHaveLength(1));
    const c = callsTo('PUT', /panels\/[^/]+\/members$/)[0]!;
    expect(c.path).toBe(`/v1/catalog/panels/${PANEL}/members`);
    expect(c.headers.get('if-match')).toMatch(/6/);
    expect(c.body.members).toEqual([{ kind: 'test', orderable_id: HB['id'], sort_order: 0 }, { kind: 'test', orderable_id: GLU['id'], sort_order: 1 }]);
  });
  it('a reader cannot move anything', async () => {
    TM.session.permissions = READ;
    setup([]);
    await open();
    for (const n of [/^add$/i, /^add all$/i, /^remove$/i, /^remove all$/i]) expect(off(screen.queryByRole('button', { name: n })), String(n)).toBe(true);
  });
  it('keyboard: Enter on an option moves it (listbox options are focusable)', async () => {
    setup([]);
    await open();
    const o = within(screen.getByRole('listbox', { name: /^available tests/i })).getByRole('option', { name: /Hemoglobin/ });
    o.focus();
    await userEvent.keyboard('{Enter}');
    expect(chosen().join('|')).toMatch(/Hemoglobin/);
  });
});

describe('light on low end PCs, no new heavy library (item 7)', () => {
  it('apps/web/package.json adds no grid, UI-kit, date or utility mega library', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    const banned = /^(ag-grid.*|@ag-grid.*|handsontable|@mui\/.*|antd|@mantine\/.*|moment|lodash|@tanstack\/react-table|react-table|react-data-grid|xlsx|exceljs|chart\.js|recharts)$/;
    expect(Object.keys(pkg.dependencies ?? {}).filter((d) => banned.test(d))).toEqual([]); // xlsx belongs to the import task, not to this one
  });
  it('the list screens page their data: 60 tests render at most 25 rows on the Complete test list', async () => {
    loadTests(...Array.from({ length: 60 }, (_, i) => testDetail(200 + i, `C${String(i + 1).padStart(3, '0')}`, `Synthetic test ${i + 1}`)));
    await show('tests');
    await screen.findByText('Synthetic test 1');
    expect(within(screen.getByRole('table')).getAllByRole('row').length).toBeLessThanOrEqual(26);
  });
});
void HAEM; void MANAGE;
