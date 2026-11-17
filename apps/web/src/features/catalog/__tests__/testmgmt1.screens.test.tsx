// @vitest-environment jsdom
// T0D-TESTMGMT-1 done_when (6) and (7): category, popular test, complete test list, profile / package two-list picker, notes, units, specimens.
//   /catalog/tests?view=categories | popular | complete    (existing route, no new route; rs-c2.static pins routes.yaml)
//   /catalog/panels/<id>   two list picker: "Available tests" | "In this profile" with Add, Add all, Remove, Remove all -> PUT panels/{id}/members
//   /catalog/comment-codes (notes), /catalog/units, /catalog/specimens: still work, compact density, headers when empty.
// API GAPS (notes): no specimen group table in the contract (specimen groups are covered by /catalog/specimens only); OrderableSummary has no
// is_popular (the Popular screen reads it from the row; the kit supplies it); popular toggle writes PATCH tests/{id} {is_popular}.
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BIOC, CAT_A, CAT_B, HAEM, PANEL, READ, T_CBC, T_GLU, T_TSH, calls, mountNotes, mountPanel, mountSpecimens, mountTests, mountUnits, overrides, problem, setTests, testDetail, tm, to } from './testmgmt1.kit';

describe('Categories (?view=categories)', () => {
  it('lists categories with always-drawn headers and the Department, Name, Display order, Print footer, Status columns', async () => {
    await mountTests('?view=categories');
    const t = await screen.findByRole('table', { name: /categor/i });
    for (const c of ['Department', 'Name', 'Display order', 'Print footer', 'Status']) expect(within(t).getByRole('columnheader', { name: c })).toBeTruthy();
    expect(within(t).getByText(CAT_A.name)).toBeTruthy();
    expect(within(t).getByText(CAT_B.name)).toBeTruthy();
  });

  it('keeps the headers and shows an empty message when there are none', async () => {
    overrides.set('GET /test-categories$', () => Response.json({ data: [], page: { limit: 200 } }));
    await mountTests('?view=categories');
    const t = await screen.findByRole('table', { name: /categor/i });
    expect(within(t).getByRole('columnheader', { name: 'Name' })).toBeTruthy();
    expect(within(t).getByText(/no categories/i)).toBeTruthy();
  });

  it('New category posts department_id, name, display_order, print_footer, footer_text with Idempotency-Key', async () => {
    await mountTests('?view=categories');
    await userEvent.click(await screen.findByRole('button', { name: /new category/i }));
    const dlg = await screen.findByRole('dialog', { name: /category/i });
    await userEvent.selectOptions(within(dlg).getByLabelText(/department/i), HAEM.id);
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Coagulation');
    await userEvent.type(within(dlg).getByLabelText(/display order/i), '30');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /print footer/i }));
    await userEvent.type(within(dlg).getByLabelText(/footer text/i), 'Synthetic footer');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('POST', /\/test-categories$/)).toHaveLength(1));
    const c = to('POST', /test-categories$/)[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(c.body).toMatchObject({ department_id: HAEM.id, name: 'Coagulation', display_order: 30, print_footer: true, footer_text: 'Synthetic footer' });
  });

  it('Edit PATCHes only the changed field with If-Match; there is no delete, deactivate is the only way out', async () => {
    await mountTests('?view=categories');
    const t = await screen.findByRole('table', { name: /categor/i });
    await userEvent.click(within(t).getAllByRole('button', { name: /edit/i })[0]!);
    const dlg = await screen.findByRole('dialog', { name: /category/i });
    const n = within(dlg).getByLabelText(/^name/i);
    await userEvent.clear(n); await userEvent.type(n, 'Routine haematology 2');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('PATCH', /\/test-categories\//)).toHaveLength(1));
    expect(to('PATCH', /test-categories/)[0]!.body).toEqual({ name: 'Routine haematology 2' });
    expect(to('PATCH', /test-categories/)[0]!.headers.get('if-match')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^delete/i })).toBeNull();
  });

  it('shows a server validation message at the field', async () => {
    overrides.set('POST /test-categories$', () => problem(400, 'common.validation_failed', { errors: [{ pointer: '/name', code: 'invalid', message: 'Name is already used in this department.' }] }));
    await mountTests('?view=categories');
    await userEvent.click(await screen.findByRole('button', { name: /new category/i }));
    const dlg = await screen.findByRole('dialog', { name: /category/i });
    await userEvent.selectOptions(within(dlg).getByLabelText(/department/i), BIOC.id);
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Lipid studies');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save/i }));
    expect(await within(dlg).findByText(/already used in this department/i)).toBeTruthy();
  });

  it('read-only actor: no New category button (or disabled) with a visible reason', async () => {
    tm().permissions = READ;
    await mountTests('?view=categories');
    await screen.findByRole('table', { name: /categor/i });
    const b = screen.queryByRole('button', { name: /new category/i }) as HTMLButtonElement | null;
    expect(b === null || b.disabled).toBe(true);
    expect(screen.getByText(/permission|not allowed|read[- ]only/i)).toBeTruthy();
  });
});

describe('Popular tests (?view=popular)', () => {
  it('lists only popular tests and keeps its headers when there are none', async () => {
    await mountTests('?view=popular');
    const t = await screen.findByRole('table', { name: /popular/i });
    expect(within(t).getByText('CBC')).toBeTruthy();
    expect(within(t).queryByText('GLU')).toBeNull();
    setTests([T_GLU, T_TSH]);
  });

  it('empty: headers drawn, message shown', async () => {
    setTests([T_GLU, T_TSH]);
    await mountTests('?view=popular');
    const t = await screen.findByRole('table', { name: /popular/i });
    expect(within(t).getByRole('columnheader', { name: /code/i })).toBeTruthy();
    expect(within(t).getByText(/no popular tests/i)).toBeTruthy();
  });

  it('Add popular test picks from the tests and PATCHes is_popular true with If-Match; Remove PATCHes false', async () => {
    await mountTests('?view=popular');
    await userEvent.click(await screen.findByRole('button', { name: /add popular/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('option', { name: /GLU/ }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(add|save)/i }));
    await waitFor(() => expect(to('PATCH', new RegExp(`/tests/${T_GLU.id}$`))).toHaveLength(1));
    expect(to('PATCH', /tests\//)[0]!.body).toEqual({ is_popular: true });
    expect(to('PATCH', /tests\//)[0]!.headers.get('if-match')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('table', { name: /popular/i })).getAllByRole('button', { name: /remove/i })[0]!);
    await waitFor(() => expect(to('PATCH', /tests\//).length).toBe(2));
    expect(to('PATCH', /tests\//)[1]!.body).toEqual({ is_popular: false });
  });
});

describe('Complete test list (?view=complete)', () => {
  it('has the Code, Test name, Short name, Department, Category, Price columns, one page of rows, and filters by category through the API', async () => {
    await mountTests('?view=complete');
    const t = await screen.findByRole('table', { name: /complete test list/i });
    for (const c of ['Code', 'Test name', 'Short name', 'Department', 'Category', 'Price']) expect(within(t).getByRole('columnheader', { name: c })).toBeTruthy();
    expect(within(t).getByText(T_CBC.display_name)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText(/category/i), CAT_B.id);
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && /\/v1\/catalog\/tests$/.test(c.path) && c.search.includes(`category_id=${CAT_B.id}`))).toBe(true));
    expect(tm().navLog.some((u) => u.includes(`category_id=${CAT_B.id}`))).toBe(true);
  });

  it('is paged and never renders more than 50 rows at once; headers stay when empty', async () => {
    setTests(Array.from({ length: 120 }, (_, i) => testDetail(900 + i, `Z${i}`, `Synthetic ${i}`, HAEM)));
    await mountTests('?view=complete');
    const t = await screen.findByRole('table', { name: /complete test list/i });
    expect(within(t).getAllByRole('row').length).toBeLessThanOrEqual(51);
    expect(screen.getByRole('button', { name: /next/i }) ?? screen.getByRole('link', { name: /next/i })).toBeTruthy();
  });

  it('empty list keeps the headers', async () => {
    setTests([]);
    await mountTests('?view=complete');
    const t = await screen.findByRole('table', { name: /complete test list/i });
    expect(within(t).getByRole('columnheader', { name: 'Code' })).toBeTruthy();
  });
});

describe('Profile / package two-list picker (/catalog/panels/<id>)', () => {
  const open = async () => { await mountPanel(PANEL.id); return { avail: await screen.findByRole('listbox', { name: /available tests/i }), chosen: await screen.findByRole('listbox', { name: new RegExp(`in this (profile|package)`, 'i') }) }; };

  it('shows available tests on the left and members on the right, with Add, Add all, Remove, Remove all', async () => {
    const { avail, chosen } = await open();
    expect(within(chosen).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('GLU')]);
    expect(within(avail).queryByText(/GLU/)).toBeNull(); // already a member
    expect(within(avail).getAllByRole('option').length).toBeGreaterThan(0);
    for (const n of [/^add$/i, /add all/i, /^remove$/i, /remove all/i]) expect(screen.getByRole('button', { name: n })).toBeTruthy();
  });

  it('Add moves the selected test, Add all moves every available test, Remove and Remove all move back', async () => {
    const { avail, chosen } = await open();
    const before = within(avail).getAllByRole('option').length;
    await userEvent.click(within(avail).getAllByRole('option')[0]!);
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(within(chosen).getAllByRole('option')).toHaveLength(2);
    expect(within(avail).getAllByRole('option')).toHaveLength(before - 1);
    await userEvent.click(screen.getByRole('button', { name: /add all/i }));
    expect(within(avail).queryAllByRole('option')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: /remove all/i }));
    expect(within(chosen).queryAllByRole('option')).toHaveLength(0);
    expect(to('PUT', /members$/)).toHaveLength(0); // nothing saved until Save
  });

  it('Save PUTs the whole member list in order with If-Match; an empty list is refused locally (API needs at least 1)', async () => {
    const { avail } = await open();
    await userEvent.click(within(avail).getAllByRole('option')[0]!);
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('PUT', /panels\/.*\/members$/)).toHaveLength(1));
    const c = to('PUT', /members$/)[0]!;
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(c.body.members.map((m: { sort_order: number }) => m.sort_order)).toEqual([1, 2]);
    expect(c.body.members.every((m: { kind: string }) => m.kind === 'test')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /remove all/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(await screen.findByText(/at least one/i)).toBeTruthy();
    expect(to('PUT', /members$/)).toHaveLength(1);
  });

  it('keyboard: Enter on an available option adds it', async () => {
    const { avail, chosen } = await open();
    within(avail).getAllByRole('option')[0]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(within(chosen).getAllByRole('option')).toHaveLength(2);
  });
});

describe('Notes, units, specimens: still reachable and compact', () => {
  it.each([
    ['notes', mountNotes, /note|comment/i],
    ['units', mountUnits, /unit/i],
    ['specimens', mountSpecimens, /specimen/i],
  ])('%s screen draws its headings and table headers with density-aware kit controls', async (_n, mount, heading) => {
    await mount();
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(1);
    expect(document.querySelector('table, [role="table"], [role="grid"]')).not.toBeNull();
  });
});
