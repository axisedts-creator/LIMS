// @vitest-environment jsdom
// T0D-TESTMGMT-1 item (2) — Test Details: a two-pane screen (tests left with search, parameters of the selected test right).
// LD-318 / founder 2026-11-17 08:48 NPT. Synthetic data only. No route is added (rs-c2.static pins the route tree): the screen is
//   /catalog/tests?view=details[&test=<test id>]      (the plain /catalog/tests stays the Complete test list pinned by cattests1)
// CONTRACT pinned here (the writer follows it or disputes it with a reason):
//   left pane  : region named "Tests" with a heading "Tests", a search box named /search tests/i (display name, short name, code, name; tag via
//                GET /v1/catalog/tests/{id}.tags because OrderableSummary has no tags), one row per test (25 per page, Next link), the chosen row
//                marked aria-selected / aria-current. Choosing a test navigates to an address that keeps view=details and sets test=<id>.
//   right pane : region named "Parameters" with a heading "Parameters" and a table with the column headers Name, Sub heading, Short name
//                (drawn even with no test chosen or no parameters). Rows are in sort_order order. Row = analytes[]: name, report_subheading, code.
//   buttons    : New parameter (-> /catalog/tests/{id}?tab=analytes&analyte=new), Edit parameter (needs a chosen row; -> ...&analyte=<id>),
//                Add existing parameter to this test (dialog; POST /v1/catalog/tests/{id}/analytes copying code, name and result type),
//                Add space (POST analyte with result_type space), Remove (confirm dialog; PATCH is_active:false with If-Match, never DELETE),
//                Move up / Move down and Alt+ArrowUp / Alt+ArrowDown on a focused row (swap sort_order with the neighbour: PATCH both, If-Match).
//   permission : catalog.test.read sees everything; the mutating buttons need catalog.test.manage (absent or disabled for readers).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { A_HB, A_MCV, A_RBC, api, calls, callsTo, ID, lastAddress, loadTests, MANAGE, READ, reset, S, show, TM, testDetail } from './testmgmt1.harness';

const HB = testDetail(1, 'HB', 'Hemoglobin', { analytes: [A_MCV, A_HB, A_RBC] }); // API order is NOT display order
const CBC = testDetail(2, 'CBC', 'Complete blood count', { short_name: 'cbcx', display_name: 'Full blood picture, EDTA(CBC)', analytes: [] });
const GLU = testDetail(3, 'GLU', 'Glucose fasting', { department_id: ID(2), tags: ['diabetes', 'sugar'], analytes: [] });
const DIRECT = `/catalog/tests/${HB['id']}`;

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { reset(); loadTests(HB, CBC, GLU); });
afterEach(() => { cleanup(); api.resetHandlers(); });

const off = (name: RegExp) => { const b = screen.queryByRole('button', { name }); return !b || b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true'; };
const left = () => screen.getByRole('region', { name: /^tests$/i });
const right = () => screen.getByRole('region', { name: /^parameters$/i });
const open = async (search = `view=details&test=${HB['id']}`) => { const v = await show('tests', { search }); await within(left()).findByText(/Hemoglobin/); return v; };

describe('Test Details: empty panes show their headings (item 2, 8)', () => {
  it('no tests at all: both pane headings and the parameter column names are still drawn', async () => {
    loadTests();
    await show('tests', { search: 'view=details' });
    expect(await screen.findByRole('heading', { name: /^tests$/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^parameters$/i })).toBeTruthy();
    const heads = within(right()).getAllByRole('columnheader').map((h) => h.textContent?.trim().toLowerCase());
    expect(heads).toEqual(expect.arrayContaining(['name', 'sub heading', 'short name']));
  });
  it('tests exist but none is chosen: the right pane keeps its heading and columns and says what to do', async () => {
    await open('view=details');
    expect(within(right()).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(3);
    expect(within(right()).getAllByRole('row').length).toBeGreaterThanOrEqual(1); // header row (+ an empty-state row is fine)
    expect(right().textContent).toMatch(/select a test/i);
  });
  it('a chosen test without parameters still draws the headings and the columns', async () => {
    await open(`view=details&test=${CBC['id']}`);
    expect(within(right()).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(3);
    expect(right().textContent).toMatch(/no parameters/i);
  });
});

describe('Test Details: left pane (item 2)', () => {
  it('lists the tests with name and code, no axe violations', async () => {
    const view = await open('view=details');
    for (const t of ['Hemoglobin', 'Complete blood count', 'Glucose fasting']) expect(within(left()).getByText(new RegExp(t))).toBeTruthy();
    const r = await axe.run(view.container, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
  it.each([
    ['name', 'gluc', /Glucose fasting/, [/Hemoglobin/, /Complete blood/]],
    ['code', 'cbc', /Complete blood count/, [/Hemoglobin/, /Glucose/]],
    ['short name', 'cbcx', /Complete blood count/, [/Hemoglobin/, /Glucose/]],
    ['display name', 'full blood picture', /Complete blood count/, [/Hemoglobin/, /Glucose/]],
    ['tag (resolved through test detail)', 'diabetes', /Glucose fasting/, [/Hemoglobin/, /Complete blood/]],
  ])('search by %s narrows the list', async (_n, q, shown, hidden) => {
    await open('view=details');
    await userEvent.type(screen.getByRole('searchbox', { name: /search tests/i }), q);
    await waitFor(() => expect(within(left()).queryByText(hidden[0]!)).toBeNull());
    expect(within(left()).getByText(shown)).toBeTruthy();
    for (const h of hidden) expect(within(left()).queryByText(h)).toBeNull();
  });
  it('choosing a test keeps view=details and sets test=<id>', async () => {
    await open('view=details');
    await userEvent.click(within(left()).getByText(/Glucose fasting/));
    const u = lastAddress()!;
    expect(u.pathname).toBe('/catalog/tests');
    expect(u.searchParams.get('view')).toBe('details');
    expect(u.searchParams.get('test')).toBe(GLU['id']);
  });
  it('is light: 60 tests render 25 rows and a Next link (lists are paged)', async () => {
    loadTests(...Array.from({ length: 60 }, (_, i) => testDetail(200 + i, `C${String(i + 1).padStart(3, '0')}`, `Synthetic test ${i + 1}`)));
    await show('tests', { search: 'view=details' });
    await within(left()).findByText(/Synthetic test 1$/);
    expect(within(left()).getAllByRole('row').length + within(left()).queryAllByRole('listitem').length).toBeLessThanOrEqual(26 + 1);
    expect(screen.getAllByRole('link', { name: /next/i }).length + screen.queryAllByRole('button', { name: /next/i }).length).toBeGreaterThan(0);
  });
});

describe('Test Details: right pane (item 2)', () => {
  it('shows the parameters of the chosen test in sort order as name, sub heading and short name', async () => {
    await open();
    const rows = within(right()).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Haemoglobin.*Red cell indices.*HB/),
      expect.stringMatching(/Red blood cell count.*Red cell indices.*RBC/),
      expect.stringMatching(/Mean corpuscular volume.*MCV/),
    ]);
  });
  it('has the five parameter buttons plus Move up / Move down for a manager', async () => {
    await open();
    for (const n of [/^new parameter$/i, /^add existing parameter to this test$/i, /^add space$/i, /^remove$/i, /^edit parameter$/i]) expect(screen.queryByRole('button', { name: n }) ?? screen.queryByRole('link', { name: n }), String(n)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^move up$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^move down$/i })).toBeTruthy();
  });
  it('a reader cannot add, remove or reorder', async () => {
    TM.session.permissions = READ;
    await open();
    for (const n of [/^add existing parameter to this test$/i, /^add space$/i, /^remove$/i, /^move up$/i, /^move down$/i]) expect(off(n), String(n)).toBe(true);
  });
  it('New parameter opens the parameter form for this test', async () => {
    await open();
    const b = screen.queryByRole('button', { name: /^new parameter$/i });
    await userEvent.click(b ?? screen.getByRole('link', { name: /^new parameter$/i }));
    const u = lastAddress();
    expect(u?.pathname).toBe(DIRECT);
    expect(u?.searchParams.get('tab')).toBe('analytes');
    expect(u?.searchParams.get('analyte')).toBe('new');
  });
  it('Edit parameter needs a chosen row, then opens that parameter', async () => {
    await open();
    expect(off(/^edit parameter$/i)).toBe(true);
    await userEvent.click(within(right()).getByRole('row', { name: /Red blood cell count/ }));
    await userEvent.click((screen.queryByRole('button', { name: /^edit parameter$/i }) ?? screen.getByRole('link', { name: /^edit parameter$/i })));
    const u = lastAddress();
    expect(u?.pathname).toBe(DIRECT);
    expect(u?.searchParams.get('analyte')).toBe(A_RBC.id);
    expect(u?.searchParams.get('tab')).toBe('analytes');
  });
});

describe('Test Details: reorder, space, remove, add existing (item 2)', () => {
  // Review item 1: the new order is renumbered to (index+1)*10; only parameters whose sort_order differs are PATCHed (If-Match each).
  it('Move down renumbers to (index+1)*10: new order RBC, HB, MCV -> 10, 20, 30 (PATCH each changed one, If-Match, nothing else sent)', async () => {
    await open();
    await userEvent.click(within(right()).getByRole('row', { name: /Haemoglobin/ }));
    await userEvent.click(screen.getByRole('button', { name: /^move down$/i }));
    await waitFor(() => expect(callsTo('PATCH', /\/v1\/catalog\/analytes\//)).toHaveLength(3));
    const byId = Object.fromEntries(callsTo('PATCH', /\/v1\/catalog\/analytes\//).map((c) => [c.path.split('/').pop(), c]));
    expect(byId[A_RBC.id]!.body).toEqual({ sort_order: 10 });
    expect(byId[A_HB.id]!.body).toEqual({ sort_order: 20 });
    expect(byId[A_MCV.id]!.body).toEqual({ sort_order: 30 });
    expect(byId[A_HB.id]!.headers.get('if-match')).toMatch(/2/);
  });
  it('parameters that all sit at the API default sort_order 100 still swap: PATCH distinct (index+1)*10 values (review item 1)', async () => {
    const P = { ...A_HB, sort_order: 100 };
    const Q = { ...A_RBC, sort_order: 100 };
    loadTests(testDetail(1, 'HB', 'Hemoglobin', { analytes: [P, Q] }), CBC, GLU);
    await open();
    await userEvent.click(within(right()).getByRole('row', { name: /Haemoglobin/ }));
    await userEvent.click(screen.getByRole('button', { name: /^move down$/i }));
    await waitFor(() => expect(callsTo('PATCH', /\/v1\/catalog\/analytes\//)).toHaveLength(2));
    const byId = Object.fromEntries(callsTo('PATCH', /\/v1\/catalog\/analytes\//).map((c) => [c.path.split('/').pop(), c.body]));
    expect(byId[Q.id]).toEqual({ sort_order: 10 }); // now first
    expect(byId[P.id]).toEqual({ sort_order: 20 }); // now second
  });
  it('keyboard: Alt+ArrowUp on a focused row moves it up', async () => {
    await open();
    const row = within(right()).getByRole('row', { name: /Red blood cell count/ });
    await userEvent.click(row);
    row.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(callsTo('PATCH', /\/v1\/catalog\/analytes\//)).toHaveLength(3));
    const body = Object.fromEntries(callsTo('PATCH', /\/v1\/catalog\/analytes\//).map((c) => [c.path.split('/').pop(), c.body]));
    expect(body[A_RBC.id]).toEqual({ sort_order: 10 }); // RBC is now first
    expect(body[A_HB.id]).toEqual({ sort_order: 20 });
  });
  it('the first parameter cannot move up and the last cannot move down', async () => {
    await open();
    await userEvent.click(within(right()).getByRole('row', { name: /Haemoglobin/ }));
    expect(off(/^move up$/i)).toBe(true);
    await userEvent.click(within(right()).getByRole('row', { name: /Mean corpuscular volume/ }));
    expect(off(/^move down$/i)).toBe(true);
  });
  it('Add space creates a parameter of result type space (valid code and name)', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^add space$/i }));
    await waitFor(() => expect(callsTo('POST', /\/tests\/[^/]+\/analytes$/)).toHaveLength(1));
    const c = callsTo('POST', /\/tests\/[^/]+\/analytes$/)[0]!;
    expect(c.path).toBe(`/v1/catalog/tests/${HB['id']}/analytes`);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body.initial_version.result_type).toBe('space');
    expect(c.body.code).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    expect(c.body.name.length).toBeGreaterThan(0);
  });
  it('Remove asks first, then deactivates (PATCH is_active:false with If-Match); it never deletes', async () => {
    await open();
    await userEvent.click(within(right()).getByRole('row', { name: /Red blood cell count/ }));
    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    const dlg = await screen.findByRole('dialog');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0); // nothing sent before the confirmation
    await userEvent.click(within(dlg).getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(callsTo('PATCH', /\/analytes\//)).toHaveLength(1));
    const c = callsTo('PATCH', /\/analytes\//)[0]!;
    expect(c.path).toBe(`/v1/catalog/analytes/${A_RBC.id}`);
    expect(c.body).toEqual({ is_active: false });
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(calls.some((x) => x.method === 'DELETE')).toBe(false);
  });
  it('Remove can be cancelled without any request', async () => {
    await open();
    await userEvent.click(within(right()).getByRole('row', { name: /Red blood cell count/ }));
    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
  it('Add existing parameter to this test: pick a parameter of another test, it is added to this one', async () => {
    const other = testDetail(4, 'LFT', 'Liver panel', { analytes: [{ ...A_HB, id: ID(70), code: 'ALT', name: 'Alanine transaminase' }] });
    loadTests(HB, CBC, other);
    await open(`view=details&test=${CBC['id']}`);
    await userEvent.click(screen.getByRole('button', { name: /^add existing parameter to this test$/i }));
    const dlg = await screen.findByRole('dialog', { name: /add existing parameter/i });
    await userEvent.click(await within(dlg).findByRole('checkbox', { name: /Alanine transaminase/ }).catch(() => within(dlg).findByRole('option', { name: /Alanine transaminase/ })));
    await userEvent.click(within(dlg).getByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(callsTo('POST', /\/tests\/[^/]+\/analytes$/)).toHaveLength(1));
    const c = callsTo('POST', /\/tests\/[^/]+\/analytes$/)[0]!;
    expect(c.path).toBe(`/v1/catalog/tests/${CBC['id']}/analytes`);
    expect(c.body).toMatchObject({ code: 'ALT', name: 'Alanine transaminase', initial_version: { result_type: 'numeric' } });
  });
  it('a server rejection (duplicate code) is shown, the page keeps working', async () => {
    S.failNext = { method: 'POST', re: /\/analytes$/, status: 409, code: 'catalog.code_duplicate' };
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^add space$/i }));
    expect(await screen.findByText(/already used|duplicate/i)).toBeTruthy();
    expect(within(right()).getAllByRole('row').length).toBeGreaterThan(1);
  });
});
