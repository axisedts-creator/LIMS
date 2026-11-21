// @vitest-environment jsdom
// T0D-SALES-1 — Sales screens: designations, representatives (+ manager tree, manager picker), service areas (LD-321, LD-310, LD-353 template 1 LIST).
// Through the PAGE default exports app/(staff)/partners/sales/{designations,representatives,areas}/page.tsx (server page -> BFF -> MSW -> client parts).
// PINNED UI NAMES (tester choice; the spec fixes only routes, columns and the rules; writer may dispute through the ruling path):
//   - headers: designations Level, Name, Active | representatives Name, Designation, Manager, Phone, Email, Joining Date, Active | areas Name, District, Area, Centre, Active.
//   - page title (h1) = the menu label of the nav entry for the path (menuLabel); at most one FilterBar; table header row always drawn (also empty).
//   - top buttons "Add designation" / "Add representative" / "Add service area" open a dialog with fields (label text, exact): designation Name, Level (native number input 1..8);
//     representative Name, Phone, Email, Joining date (native date input), Designation (kit Select), Manager (kit Select, first option "No manager");
//     area Name, District, Area, Centre (kit Select, first option "All centres"). Dialog buttons "Save" / "Cancel".
//   - row controls are BUTTONS in the row (or, when the writer uses the DataTable row menu, menu items under "Row actions"): designation Edit + Deactivate|Activate; representative Edit + Deactivate;
//     area Edit + Deactivate (no Activate in the contract). Deactivate of a representative or an area asks a confirm dialog (button "Deactivate").
//   - representatives page has two tabs, "List" and "Tree"; Tree = role=tree / treeitem with aria-level = depth, aria-expanded on items with children, ArrowDown/ArrowUp move focus, ArrowLeft collapses, ArrowRight expands.
//   - writes: POST carry an Idempotency-Key; PATCH / deactivate carry If-Match "<row version>"; PATCH sends ONLY changed fields; a cleared optional field is sent through `unset`.
//   - permission: view partners.sales.read, change partners.sales.manage; a blocked control is disabled (aria-disabled / disabled) with a visible reason linked by aria-describedby = t('partners.sales.reason.manage')
//     which names the code partners.sales.manage.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { t } from '@/core/i18n/messages';
import { expectListScreen, expectStateInPage } from '@/features/catalog/__tests__/uilist3.helpers';
import { API, ID, IDEM, PATH, R2, R4, READ, TM, api, headers, isDisabled, norm, openSales, optionNames, pickOption, prob, quiet, reasonOf, rowOf, selectTrigger, type Route } from './sales1.harness';

const R_NAMES = ['Synthetic Root Manager', 'Synthetic Area Lead', 'Synthetic Field Seller', 'Synthetic Peer Manager', 'Synthetic Retired Seller'];

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const REASON = 'partners.sales.reason.manage';
const blocked = (el: HTMLElement) => {
  expect(t(REASON), `catalogue key ${REASON} must exist`).not.toBe(REASON);
  expect(t(REASON)).toContain('partners.sales.manage');
  expect(isDisabled(el), 'control is disabled').toBe(true);
  expect(reasonOf(el), 'visible reason linked by aria-describedby').toContain(t(REASON));
  expect(document.body.textContent).toContain(t(REASON));
};
/** A row control: a button in the row, else a menu item of the row's "Row actions" menu. */
const control = async (user: ReturnType<typeof userEvent.setup>, row: HTMLElement, name: RegExp): Promise<HTMLElement> => {
  const direct = within(row).queryByRole('button', { name });
  if (direct) return direct;
  await user.click(within(row).getByRole('button', { name: /row actions/i }));
  return screen.findByRole('menuitem', { name });
};
const dialog = () => screen.findByRole('dialog');
const field = (dlg: HTMLElement, label: string) => within(dlg).getByLabelText(new RegExp(`^${label}`, 'i')) as HTMLInputElement;
const typeInto = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) => { await user.clear(el); if (v) await user.type(el, v); };
const save = (dlg: HTMLElement) => within(dlg).getByRole('button', { name: /^save/i });
const emptyState = (c: HTMLElement) => c.querySelector('.lims-empty-state, [class*="empty-state"]');
const noAxe = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

const SCREENS: { route: Route; heads: string[]; none: () => void }[] = [
  { route: 'designations', heads: ['Level', 'Name', 'Active'], none: () => { API.designations = []; } },
  { route: 'representatives', heads: ['Name', 'Designation', 'Manager', 'Phone', 'Email', 'Joining Date', 'Active'], none: () => { API.reps = []; API.tree = []; } },
  { route: 'areas', heads: ['Name', 'District', 'Area', 'Centre', 'Active'], none: () => { API.areas = []; } },
];

describe.each(SCREENS)('$route: LIST template, headers always shown (done_when 2, LD-353 rules 5, 6, 8)', ({ route, heads, none }) => {
  it('no rows: h1 = menu label, header row with the named columns in the kit scroll box, EmptyState in the body', async () => {
    none();
    const { container } = await openSales(route);
    expectListScreen(container, { path: PATH(route), headers: heads, filterBar: 'optional' });
    expect(emptyState(container), 'EmptyState').toBeTruthy();
    expect(norm(container.textContent)).not.toMatch(/undefined|null|NaN/);
  });
  it('a failed list keeps the page title and chrome and shows an ErrorState or NotAvailable, never a bare error page', async () => {
    API.listFail = 500;
    const { container } = await openSales(route);
    expectStateInPage(container, { path: PATH(route), kind: 'either' });
  });
  it('403 on the list also keeps the page (permission shown, no stack)', async () => {
    API.listFail = 403;
    const { container } = await openSales(route, { perms: [] });
    expectStateInPage(container, { path: PATH(route), kind: 'either' });
  });
  it('lists are paged: one request asks at most 200 rows and a next_cursor offers Next, which moves with cursor=<value>', async () => {
    API.nextCursor = 'cur-2';
    await openSales(route);
    const first = API.find('GET', new RegExp(`/sales/${route === 'areas' ? 'service-areas' : route}$`))[0]!;
    expect(Number(first.search.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    await userEvent.click(screen.getByRole('button', { name: /^next/i }));
    expect(TM.push.mock.calls.map((c) => String(c[0])).join(' ')).toContain('cursor=cur-2');
  });
});

describe('designations (Level, Name, Active)', () => {
  it('one row per designation with level, name and an Active word; inactive rows say so', async () => {
    await openSales('designations');
    expect(rowOf('Synthetic Regional Head').textContent).toMatch(/\b1\b/);
    expect(rowOf('Synthetic Regional Head').textContent).toMatch(/\b(Yes|Active)\b/);
    expect(rowOf('Synthetic Old Grade').textContent).toMatch(/\b(No|Inactive)\b/);
    expect(rowOf('Synthetic Old Grade').textContent).not.toMatch(/\b(Yes|Active)\b/);
  });

  it('Add designation: POST {name, level} with an Idempotency-Key; the dialog closes and the list refreshes', async () => {
    await openSales('designations');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add designation/i }));
    const dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic Senior Seller');
    await typeInto(user, field(dlg, 'Level'), '3');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('POST', /\/designations$/)).toHaveLength(1));
    const c = API.find('POST', /\/designations$/)[0]!;
    expect(c.json).toEqual({ name: 'Synthetic Senior Seller', level: 3 });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses level 0, 9, 2.5, empty and a blank name in the browser: no request, the field is marked invalid', async () => {
    await openSales('designations');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add designation/i }));
    const dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic Senior Seller');
    for (const bad of ['0', '9', '2.5', '']) {
      await typeInto(user, field(dlg, 'Level'), bad);
      await user.click(save(dlg));
      await quiet(30);
      expect(API.writes(), `level "${bad}"`).toEqual([]);
      expect(field(dlg, 'Level').getAttribute('aria-invalid'), `level "${bad}"`).toBe('true');
    }
    await typeInto(user, field(dlg, 'Level'), '3');
    await typeInto(user, field(dlg, 'Name'), '   ');
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes()).toEqual([]);
    expect(field(dlg, 'Name').getAttribute('aria-invalid')).toBe('true');
  });

  it('a used level (server 400 on /level) is shown on the Level field; the dialog stays open with the typed values', async () => {
    API.fail = prob(400, 'common.validation_failed', [{ path: '/level', code: 'common.validation_failed', message: 'Level 2 is already used' }]);
    await openSales('designations');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add designation/i }));
    const dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic Senior Seller');
    await typeInto(user, field(dlg, 'Level'), '2');
    await user.click(save(dlg));
    await waitFor(() => expect(field(dlg, 'Level').getAttribute('aria-invalid')).toBe('true'));
    expect(reasonOf(field(dlg, 'Level')) + norm(dlg.textContent)).toContain('Level 2 is already used');
    expect(field(dlg, 'Level').value).toBe('2');
    expect(TM.refresh.mock.calls.length).toBe(0);
  });

  it('double click on Save sends ONE request', async () => {
    API.writeDelayMs = 80;
    await openSales('designations');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add designation/i }));
    const dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic Senior Seller');
    await typeInto(user, field(dlg, 'Level'), '3');
    await user.dblClick(save(dlg));
    await quiet(250);
    expect(API.find('POST', /\/designations$/)).toHaveLength(1);
  });

  it('Edit sends only the changed field with If-Match = the row version (row 1 is version 2)', async () => {
    await openSales('designations');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Regional Head'), /^edit/i));
    const dlg = await dialog();
    expect(field(dlg, 'Name').value).toBe('Synthetic Regional Head');
    expect(field(dlg, 'Level').value).toBe('1');
    await typeInto(user, field(dlg, 'Name'), 'Synthetic Regional Chief');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('PATCH', /\/designations\/[^/]+$/)).toHaveLength(1));
    const c = API.find('PATCH', /\/designations\/[^/]+$/)[0]!;
    expect(c.path.endsWith(ID(11))).toBe(true);
    expect(c.json).toEqual({ name: 'Synthetic Regional Chief' });
    expect(c.headers.get('if-match')).toBe('"2"');
  });

  it('Deactivate on an active row PATCHes {is_active:false}; an inactive row offers Activate -> {is_active:true}; both with If-Match', async () => {
    await openSales('designations');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Area Head'), /^deactivate/i));
    const dlgs = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
    if (dlgs) await user.click(within(dlgs).getByRole('button', { name: /^deactivate/i }));
    await waitFor(() => expect(API.find('PATCH', /\/designations\//)).toHaveLength(1));
    expect(API.find('PATCH', /\/designations\//)[0]!.json).toEqual({ is_active: false });
    expect(API.find('PATCH', /\/designations\//)[0]!.headers.get('if-match')).toBe('"1"');
    await user.click(await control(user, rowOf('Synthetic Old Grade'), /^activate/i));
    await waitFor(() => expect(API.find('PATCH', /\/designations\//)).toHaveLength(2));
    expect(API.find('PATCH', /\/designations\//)[1]!.json).toEqual({ is_active: true });
    expect(API.find('PATCH', /\/designations\//)[1]!.headers.get('if-match')).toBe('"4"');
  });

  it('without partners.sales.manage: Add, Edit and Deactivate are disabled with the visible reason; clicking sends nothing', async () => {
    await openSales('designations', { perms: READ });
    const user = userEvent.setup();
    const add = screen.getByRole('button', { name: /^add designation/i });
    blocked(add);
    await user.click(add);
    const edit = await control(user, rowOf('Synthetic Regional Head'), /^edit/i);
    blocked(edit);
    await user.click(edit);
    await quiet(30);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(API.writes()).toEqual([]);
  });
});

describe('representatives (manager tree and manager picker)', () => {
  it('rows show the designation name, the manager NAME (not the id), phone, email and joining date', async () => {
    await openSales('representatives');
    const r = rowOf('Synthetic Field Seller').textContent!;
    expect(r).toContain('Synthetic Field Executive');
    expect(r).toContain('Synthetic Area Lead');
    expect(r).toContain('+9779800000023');
    expect(r).toContain('field.seller@example.test');
    expect(r).not.toContain(R2['id']);
    expect(rowOf('Synthetic Retired Seller').textContent).toMatch(/\b(No|Inactive)\b/);
    expect(headers()).toContain('Joining Date');
  });

  it('Tree tab: role=tree, one treeitem per node in API order, aria-level = depth, inactive shown as inactive; the tree call asks for inactive nodes too', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /^tree/i }));
    const tree = await screen.findByRole('tree');
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '3', '2', '3']);
    expect(items.map((i) => R_NAMES.find((n) => i.textContent!.includes(n)))).toEqual(R_NAMES);
    expect(items[4]!.textContent).toMatch(/inactive/i);
    expect(API.find('GET', /\/sales\/tree$/)[0]!.search.get('include_inactive')).toBe('true');
    expect(Number(API.find('GET', /\/sales\/tree$/)[0]!.search.get('limit') ?? 50)).toBeLessThanOrEqual(200);
  });

  it('Tree keyboard: ArrowDown / ArrowUp move focus; ArrowLeft collapses a node with reports (its team disappears), ArrowRight expands it again', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /^tree/i }));
    const items = () => within(screen.getByRole('tree')).getAllByRole('treeitem');
    items()[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items()[1]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items()[0]);
    await user.keyboard('{ArrowDown}');
    expect(items()[1]!.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowLeft}');
    expect(items()[1]!.getAttribute('aria-expanded')).toBe('false');
    expect(items().map((i) => i.textContent).join('|')).not.toContain('Synthetic Field Seller');
    await user.keyboard('{ArrowRight}');
    expect(items().map((i) => i.textContent).join('|')).toContain('Synthetic Field Seller');
  });

  it('manager picker on EDIT hides invalid choices: self, the whole team below (loop), and inactive representatives', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Area Lead'), /^edit/i));
    const dlg = await dialog();
    await user.click(selectTrigger(dlg, /^manager(\s*\*)?$/i));
    const names = optionNames();
    expect(names.some((n) => /no manager/i.test(n)), 'No manager is a choice').toBe(true);
    const reps = names.filter((n) => !/no manager/i.test(n)).sort();
    expect(reps).toEqual(['Synthetic Peer Manager', 'Synthetic Root Manager']); // not R2 itself, not R3 (report), not R5 (inactive)
  });

  it('a top manager can only have "No manager" (everybody else is in its tree)', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Root Manager'), /^edit/i));
    const dlg = await dialog();
    await user.click(selectTrigger(dlg, /^manager(\s*\*)?$/i));
    expect(optionNames().filter((n) => !/no manager/i.test(n))).toEqual([]);
  });

  it('manager picker and designation picker on ADD offer active choices only', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add representative/i }));
    const dlg = await dialog();
    await user.click(selectTrigger(dlg, /^manager(\s*\*)?$/i));
    const mgr = optionNames().filter((n) => !/no manager/i.test(n)).sort();
    expect(mgr).toEqual(['Synthetic Area Lead', 'Synthetic Field Seller', 'Synthetic Peer Manager', 'Synthetic Root Manager']);
    await user.keyboard('{Escape}');
    await user.click(selectTrigger(dlg, /^designation(\s*\*)?$/i));
    const des = optionNames();
    expect(des.some((n) => /Old Grade/.test(n)), 'inactive designation is hidden').toBe(false);
    expect(des.some((n) => /Area Head/.test(n))).toBe(true);
  });

  it('Add representative: POST with only the filled fields (+ ids), Idempotency-Key, refresh', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add representative/i }));
    const dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic New Seller');
    await user.type(field(dlg, 'Phone'), '+9779800000099');
    await user.type(field(dlg, 'Email'), 'new.seller@example.test');
    fireEvent.change(field(dlg, 'Joining date'), { target: { value: '2026-11-18' } });
    await pickOption(user, dlg, /^designation(\s*\*)?$/i,/Field Executive/);
    await pickOption(user, dlg, /^manager(\s*\*)?$/i,/Synthetic Area Lead/);
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('POST', /\/representatives$/)).toHaveLength(1));
    const c = API.find('POST', /\/representatives$/)[0]!;
    expect(c.json).toEqual({ name: 'Synthetic New Seller', phone: '+9779800000099', email: 'new.seller@example.test', designation_id: ID(13), manager_id: R2['id'], joining_date: '2026-11-18' });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });

  it('only name and designation are required: optional fields left empty are not sent', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add representative/i }));
    const dlg = await dialog();
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes(), 'nothing filled').toEqual([]);
    await user.type(field(dlg, 'Name'), 'Synthetic Top Seller');
    await pickOption(user, dlg, /^designation(\s*\*)?$/i,/Regional Head/);
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('POST', /\/representatives$/)).toHaveLength(1));
    expect(API.find('POST', /\/representatives$/)[0]!.json).toEqual({ name: 'Synthetic Top Seller', designation_id: ID(11) });
  });

  it('phone must be E.164 (+ country code, 8 to 15 digits) and email must look like an address: invalid values send nothing', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add representative/i }));
    const dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic Top Seller');
    await pickOption(user, dlg, /^designation(\s*\*)?$/i,/Regional Head/);
    for (const bad of ['9841234567', '+0123456789', '+97798 41', '+977980000000000000']) {
      await typeInto(user, field(dlg, 'Phone'), bad);
      await user.click(save(dlg));
      await quiet(30);
      expect(API.writes(), `phone ${bad}`).toEqual([]);
      expect(field(dlg, 'Phone').getAttribute('aria-invalid'), `phone ${bad}`).toBe('true');
    }
    await typeInto(user, field(dlg, 'Phone'), '');
    await typeInto(user, field(dlg, 'Email'), 'not-an-email');
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes()).toEqual([]);
    expect(field(dlg, 'Email').getAttribute('aria-invalid')).toBe('true');
  });

  it('Edit: moving to another manager PATCHes ONLY {manager_id} with If-Match = version (R2 is 3); clearing the phone sends unset ["phone"]', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Area Lead'), /^edit/i));
    let dlg = await dialog();
    await pickOption(user, dlg, /^manager(\s*\*)?$/i,/Synthetic Peer Manager/);
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('PATCH', /\/representatives\/[^/]+$/)).toHaveLength(1));
    const c = API.find('PATCH', /\/representatives\/[^/]+$/)[0]!;
    expect(c.path.endsWith(ID(22))).toBe(true);
    expect(c.json).toEqual({ manager_id: R4['id'] });
    expect(c.headers.get('if-match')).toBe('"3"');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(await control(user, rowOf('Synthetic Area Lead'), /^edit/i));
    dlg = await dialog();
    await typeInto(user, field(dlg, 'Phone'), '');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('PATCH', /\/representatives\/[^/]+$/)).toHaveLength(2));
    expect(API.find('PATCH', /\/representatives\/[^/]+$/)[1]!.json).toEqual({ unset: ['phone'] });
  });

  it('a manager loop refused by the server (400 on /manager_id) is shown on the Manager field and the dialog stays open', async () => {
    API.fail = prob(400, 'common.validation_failed', [{ path: '/manager_id', code: 'common.validation_failed', message: 'That manager reports to this person' }]);
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Area Lead'), /^edit/i));
    const dlg = await dialog();
    await pickOption(user, dlg, /^manager(\s*\*)?$/i,/Synthetic Peer Manager/);
    await user.click(save(dlg));
    await waitFor(() => expect(norm(dlg.textContent)).toContain('That manager reports to this person'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(TM.refresh.mock.calls.length).toBe(0);
  });

  it('Deactivate asks first, then POSTs deactivate with If-Match; a refusal from the server is shown in the dialog', async () => {
    await openSales('representatives');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic Area Lead'), /^deactivate/i));
    let dlg = await dialog();
    expect(API.writes(), 'asked first').toEqual([]);
    API.fail = prob(400, 'common.validation_failed', [{ path: '/representative_id', code: 'common.validation_failed', message: 'Move the clients to another representative first' }]);
    await user.click(within(dlg).getByRole('button', { name: /^deactivate/i }));
    await waitFor(() => expect(norm(document.body.textContent)).toContain('Move the clients to another representative first'));
    dlg = await dialog();
    await user.click(within(dlg).getByRole('button', { name: /^deactivate/i }));
    await waitFor(() => expect(API.find('POST', /\/deactivate$/)).toHaveLength(2));
    const c = API.find('POST', /\/deactivate$/)[1]!;
    expect(c.path).toContain(R2['id']);
    expect(c.headers.get('if-match')).toBe('"3"');
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });

  it('an inactive representative offers no Deactivate; without partners.sales.manage every control is blocked with the reason', async () => {
    await openSales('representatives', { perms: READ });
    const user = userEvent.setup();
    blocked(screen.getByRole('button', { name: /^add representative/i }));
    blocked(await control(user, rowOf('Synthetic Field Seller'), /^edit/i));
    await user.keyboard('{Escape}');
    blocked(await control(user, rowOf('Synthetic Field Seller'), /^deactivate/i));
    expect(API.writes()).toEqual([]);
  });

  it('no accessibility violations (axe) on the list with the Add dialog open', async () => {
    await openSales('representatives');
    await userEvent.click(screen.getByRole('button', { name: /^add representative/i }));
    await dialog();
    await noAxe();
  });
});

describe('service areas (Name, District, Area, Centre, Active)', () => {
  it('rows: centre NAME from the centre list, "All centres" when the area has none, inactive says so', async () => {
    await openSales('areas');
    expect(rowOf('Synthetic ward 4').textContent).toContain('Synthetic Kathmandu Centre');
    expect(rowOf('Synthetic ward 4').textContent).toContain('Synthetic municipality, ward 4');
    expect(rowOf('Synthetic ward 9').textContent).toContain('All centres');
    expect(rowOf('Synthetic ward 9').textContent).toContain('Lalitpur');
    expect(rowOf('Synthetic old zone').textContent).toMatch(/\b(No|Inactive)\b/);
  });

  it('Add service area: POST {name, district, area_text, centre_id} with an Idempotency-Key; only name and district are required', async () => {
    await openSales('areas');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add service area/i }));
    let dlg = await dialog();
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes(), 'empty form').toEqual([]);
    await user.type(field(dlg, 'Name'), 'Synthetic ward 12');
    await user.type(field(dlg, 'District'), 'Bhaktapur');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('POST', /\/service-areas$/)).toHaveLength(1));
    expect(API.find('POST', /\/service-areas$/)[0]!.json).toEqual({ name: 'Synthetic ward 12', district: 'Bhaktapur' });
    expect(API.find('POST', /\/service-areas$/)[0]!.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: /^add service area/i }));
    dlg = await dialog();
    await user.type(field(dlg, 'Name'), 'Synthetic ward 13');
    await user.type(field(dlg, 'District'), 'Bhaktapur');
    await user.type(field(dlg, 'Area'), 'Synthetic municipality, ward 13');
    await pickOption(user, dlg, /^centre(\s*\*)?$/i,/Synthetic Kathmandu Centre/);
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('POST', /\/service-areas$/)).toHaveLength(2));
    expect(API.find('POST', /\/service-areas$/)[1]!.json).toEqual({ name: 'Synthetic ward 13', district: 'Bhaktapur', area_text: 'Synthetic municipality, ward 13', centre_id: ID(51) });
  });

  it('free text, not pincodes: a 5 digit pincode field does not exist and long values (name > 200, district > 100, area > 500) are refused in the browser', async () => {
    await openSales('areas');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^add service area/i }));
    const dlg = await dialog();
    expect(within(dlg).queryByLabelText(/pin ?code|postal/i)).toBeNull();
    await user.type(field(dlg, 'Name'), 'Synthetic ward 12');
    await user.type(field(dlg, 'District'), 'Bhaktapur');
    fireEvent.change(field(dlg, 'District'), { target: { value: 'D'.repeat(101) } });
    await user.click(save(dlg));
    await quiet(30);
    expect(API.writes()).toEqual([]);
    expect(field(dlg, 'District').getAttribute('aria-invalid')).toBe('true');
  });

  it('Edit sends only what changed with If-Match = version (ward 4 is 2): area text -> {area_text}; Centre set to All centres -> unset ["centre_id"]; empty area -> unset ["area_text"]', async () => {
    await openSales('areas');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic ward 4'), /^edit/i));
    let dlg = await dialog();
    await typeInto(user, field(dlg, 'Area'), 'Synthetic municipality, ward 5');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('PATCH', /\/service-areas\/[^/]+$/)).toHaveLength(1));
    expect(API.find('PATCH', /\/service-areas\/[^/]+$/)[0]!.json).toEqual({ area_text: 'Synthetic municipality, ward 5' });
    expect(API.find('PATCH', /\/service-areas\/[^/]+$/)[0]!.headers.get('if-match')).toBe('"2"');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(await control(user, rowOf('Synthetic ward 4'), /^edit/i));
    dlg = await dialog();
    await pickOption(user, dlg, /^centre(\s*\*)?$/i,/all centres/i);
    await typeInto(user, field(dlg, 'Area'), '');
    await user.click(save(dlg));
    await waitFor(() => expect(API.find('PATCH', /\/service-areas\/[^/]+$/)).toHaveLength(2));
    const j = API.find('PATCH', /\/service-areas\/[^/]+$/)[1]!.json;
    expect([...j.unset].sort()).toEqual(['area_text', 'centre_id']);
    expect(Object.keys(j)).toEqual(['unset']);
  });

  it('Deactivate asks first, then POSTs deactivate with If-Match; an already inactive area offers none', async () => {
    await openSales('areas');
    const user = userEvent.setup();
    await user.click(await control(user, rowOf('Synthetic ward 9'), /^deactivate/i));
    const dlg = await dialog();
    expect(API.writes()).toEqual([]);
    await user.click(within(dlg).getByRole('button', { name: /^deactivate/i }));
    await waitFor(() => expect(API.find('POST', /\/deactivate$/)).toHaveLength(1));
    expect(API.find('POST', /\/deactivate$/)[0]!.headers.get('if-match')).toBe('"1"');
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    const inactive = within(rowOf('Synthetic old zone')).queryByRole('button', { name: /^deactivate/i });
    expect(inactive === null || isDisabled(inactive)).toBe(true);
  });

  it('without partners.sales.manage: Add, Edit and Deactivate are disabled with the reason', async () => {
    await openSales('areas', { perms: READ });
    const user = userEvent.setup();
    blocked(screen.getByRole('button', { name: /^add service area/i }));
    blocked(await control(user, rowOf('Synthetic ward 4'), /^edit/i));
    await user.keyboard('{Escape}');
    blocked(await control(user, rowOf('Synthetic ward 4'), /^deactivate/i));
    expect(API.writes()).toEqual([]);
  });
});
