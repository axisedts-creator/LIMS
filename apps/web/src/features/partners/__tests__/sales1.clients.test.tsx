// @vitest-environment jsdom
// T0D-SALES-1 — Sales client list /partners/sales/clients with Assign and Unassign (LD-321, LD-353 template 1 LIST). Through the PAGE default export.
// PINNED (tester choice; writer may dispute through the ruling path):
//   - columns: Party, Type, Outstanding, Last Bill Date, Representative. Type words: Credit party, Partner, Doctor, Referrer. Money = outstanding_paisa shown as rupees with two decimals (12,500.75), never raw paisa.
//   - the contract lists clients PER representative (listRepresentativeClients), so with no filter the page reads the representatives and asks ONE clients call per representative (active and inactive:
//     an inactive representative keeps its open assignments until they are moved) and merges the rows, the Representative column naming each one. ?representative_id=<id> asks that one only; ?party_kind=<kind> is
//     passed to every call. A representative whose call fails does not blank the page: the other rows stay and a role=alert note says some clients could not be loaded.
//   - one FilterBar: Representative (kit Select) and Type (kit Select); choosing one moves with router.replace to ?representative_id= / ?party_kind=.
//   - "Assign client" (page action) opens a dialog: Party type (Credit party | Partner | Doctor | Referrer), Party (options follow the type), Representative (ACTIVE representatives only),
//     Effective from (native date, required), Effective to (native date, optional, not before from). POST /assignments {party_kind, party_id, representative_id, effective_from[, effective_to]} + Idempotency-Key.
//   - row button "Unassign" opens a confirm dialog with an optional "Last day" date (not before the assignment start) and the button "Unassign"; POST /assignments/{assignment_id}/unassign, body {effective_to} only if
//     a date was typed. If-Match: the client row carries NO assignment version (RepresentativeClient has none), so the screen sends "1" (an assignment is only ever changed by unassign: GAP for the lead / CR).
//   - blocked buttons: disabled + visible reason t('partners.sales.reason.manage') linked by aria-describedby.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@/core/i18n/messages';
import { expectListScreen, expectStateInPage } from '@/features/catalog/__tests__/uilist3.helpers';
import { API, CLIENT_A, ID, IDEM, PARTY, PATH, R2, R3, R4, READ, TM, api, headers, isDisabled, norm, openSales, optionNames, pickOption, prob, quiet, reasonOf, rowOf, selectTrigger } from './sales1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const HEADS = ['Party', 'Type', 'Outstanding', 'Last Bill Date', 'Representative'];
const clientCalls = () => API.find('GET', /\/representatives\/[^/]+\/clients$/);
const dialog = () => screen.findByRole('dialog');
const picker = selectTrigger;
const assignBtn = () => screen.getByRole('button', { name: /^assign client/i });
const REASON = 'partners.sales.reason.manage';
const blocked = (el: HTMLElement) => {
  expect(t(REASON)).not.toBe(REASON);
  expect(isDisabled(el)).toBe(true);
  expect(reasonOf(el)).toContain(t(REASON));
};

describe('clients list: headers, rows, money (done_when 2)', () => {
  it('no rows: h1 = menu label, one FilterBar, the five headers and an EmptyState', async () => {
    API.clients = {};
    const { container } = await openSales('clients');
    expectListScreen(container, { path: PATH('clients'), headers: HEADS, filterBar: 1 });
    expect(container.querySelector('.lims-empty-state, [class*="empty-state"]')).toBeTruthy();
  });

  it('no representatives at all: the same chrome, no clients calls', async () => {
    API.reps = []; API.clients = {};
    const { container } = await openSales('clients');
    expectListScreen(container, { path: PATH('clients'), headers: HEADS, filterBar: 1 });
    expect(clientCalls()).toEqual([]);
  });

  it('no filter: one clients call per representative (inactive included), merged rows, Representative column names the seller', async () => {
    await openSales('clients');
    expect(clientCalls().map((c) => c.path.split('/').at(-2)).sort()).toEqual([R2['id'], R3['id'], ID(21), ID(24), ID(25)].sort());
    expect(rowOf('Synthetic General Hospital').textContent).toContain('Synthetic Area Lead');
    expect(rowOf('Synthetic Collection Lab').textContent).toContain('Synthetic Field Seller');
    expect(rowOf('Synthetic Doctor Zeta').textContent).toContain('Synthetic Field Seller');
    expect(headers()).toEqual(expect.arrayContaining(HEADS));
  });

  it('Type words and rupees from paisa: 1250075 -> 12,500.75; -50000 -> 500.00 (a credit, not raw paisa); 0 -> 0.00; no bill yet -> a dash, never "Invalid Date"', async () => {
    await openSales('clients');
    expect(rowOf('Synthetic General Hospital').textContent).toMatch(/Credit party/);
    expect(rowOf('Synthetic Collection Lab').textContent).toMatch(/Partner/);
    expect(rowOf('Synthetic Doctor Zeta').textContent).toMatch(/Doctor/);
    expect(rowOf('Synthetic General Hospital').textContent).toMatch(/12,500\.75/);
    expect(rowOf('Synthetic General Hospital').textContent).not.toMatch(/1250075|12500\.75/);
    expect(rowOf('Synthetic Collection Lab').textContent).toMatch(/500\.00/);
    expect(rowOf('Synthetic Doctor Zeta').textContent).toMatch(/\b0\.00\b/);
    expect(rowOf('Synthetic Doctor Zeta').textContent).toMatch(/—|-|never|no bill/i);
    expect(norm(document.body.textContent)).not.toMatch(/Invalid Date|undefined|NaN|null/);
    const money = rowOf('Synthetic General Hospital').textContent!.match(/12,500\.75/)!;
    expect(money).toBeTruthy();
  });

  it('one representative failing keeps the other rows and shows a note (role=alert); the page does not turn into an error page', async () => {
    API.clientsFail = new Set([String(R3['id'])]);
    const { container } = await openSales('clients');
    expect(rowOf('Synthetic General Hospital')).toBeTruthy();
    expect(screen.queryByText('Synthetic Collection Lab')).toBeNull();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('the representative list failing (500) keeps the page title and filters with an ErrorState', async () => {
    API.listFail = 500;
    const { container } = await openSales('clients');
    expectStateInPage(container, { path: PATH('clients'), kind: 'either' });
  });
});

describe('filters', () => {
  it('?representative_id=<id> asks only that representative and lists only its clients', async () => {
    await openSales('clients', { search: `representative_id=${R2['id']}` });
    expect(clientCalls()).toHaveLength(1);
    expect(clientCalls()[0]!.path).toContain(R2['id']);
    expect(screen.queryByText('Synthetic Collection Lab')).toBeNull();
    expect(rowOf('Synthetic General Hospital')).toBeTruthy();
  });

  it('?party_kind=partner is passed to every clients call; a bad kind is ignored (not sent)', async () => {
    await openSales('clients', { search: 'party_kind=partner' });
    expect(clientCalls().length).toBeGreaterThan(0);
    for (const c of clientCalls()) expect(c.search.get('party_kind')).toBe('partner');
    cleanup(); API.calls.length = 0;
    await openSales('clients', { search: 'party_kind=%27%3Bdrop' });
    for (const c of clientCalls()) expect(c.search.get('party_kind')).toBeNull();
  });

  it('a malformed ?representative_id is ignored (no path built from it)', async () => {
    await openSales('clients', { search: 'representative_id=../../etc' });
    for (const c of clientCalls()) expect(c.path).not.toContain('..');
    expect(clientCalls().length).toBe(5);
  });

  it('choosing a representative in the FilterBar moves to ?representative_id=<id>', async () => {
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(selectTrigger(document.body, /^representative(\s*\*)?$/i));
    await user.click(await screen.findByRole('option', { name: /Synthetic Area Lead/ }));
    await waitFor(() => expect(TM.replace.mock.calls.map((c) => String(c[0])).join(' ')).toContain(`representative_id=${R2['id']}`));
  });
});

describe('Assign client', () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement) => {
    await pickOption(user, dlg, /^party type(\s*\*)?$/i, /^credit party/i);
    await pickOption(user, dlg, /^party(\s*\*)?$/i, /Synthetic General Hospital/);
    await pickOption(user, dlg, /^representative(\s*\*)?$/i, /Synthetic Peer Manager/);
    fireEvent.change(within(dlg).getByLabelText(/^effective from/i), { target: { value: '2026-11-20' } });
  };

  it('POST /assignments {party_kind, party_id, representative_id, effective_from} with an Idempotency-Key; closes and refreshes', async () => {
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(assignBtn());
    const dlg = await dialog();
    await fill(user, dlg);
    await user.click(within(dlg).getByRole('button', { name: /^save|^assign/i }));
    await waitFor(() => expect(API.find('POST', /\/assignments$/)).toHaveLength(1));
    const c = API.find('POST', /\/assignments$/)[0]!;
    expect(c.json).toEqual({ party_kind: 'credit_party', party_id: PARTY.cp, representative_id: R4['id'], effective_from: '2026-11-20' });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the Party choices follow the Party type (doctor -> doctors only), and the Representative picker hides inactive representatives', async () => {
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(assignBtn());
    const dlg = await dialog();
    await pickOption(user, dlg, /^party type(\s*\*)?$/i, /^doctor/i);
    await user.click(picker(dlg, /^party(\s*\*)?$/i));
    expect(optionNames().join('|')).toContain('Synthetic Doctor Zeta');
    expect(optionNames().join('|')).not.toContain('Synthetic General Hospital');
    await user.keyboard('{Escape}');
    await user.click(picker(dlg, /^representative(\s*\*)?$/i));
    const reps = optionNames();
    expect(reps).toEqual(expect.arrayContaining(['Synthetic Root Manager', 'Synthetic Peer Manager']));
    expect(reps.join('|')).not.toContain('Synthetic Retired Seller');
  });

  it('Effective to is optional and sent only when typed; before Effective from it is refused in the browser (no request)', async () => {
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(assignBtn());
    const dlg = await dialog();
    await fill(user, dlg);
    fireEvent.change(within(dlg).getByLabelText(/^effective to/i), { target: { value: '2026-11-01' } });
    await user.click(within(dlg).getByRole('button', { name: /^save|^assign/i }));
    await quiet(40);
    expect(API.writes()).toEqual([]);
    expect(within(dlg).getByLabelText(/^effective to/i).getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(within(dlg).getByLabelText(/^effective to/i), { target: { value: '2026-12-31' } });
    await user.click(within(dlg).getByRole('button', { name: /^save|^assign/i }));
    await waitFor(() => expect(API.find('POST', /\/assignments$/)).toHaveLength(1));
    expect(API.find('POST', /\/assignments$/)[0]!.json).toMatchObject({ effective_from: '2026-11-20', effective_to: '2026-12-31' });
  });

  it('missing party type, party, representative or start date: no request, the empty field is marked invalid', async () => {
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(assignBtn());
    const dlg = await dialog();
    await user.click(within(dlg).getByRole('button', { name: /^save|^assign/i }));
    await quiet(40);
    expect(API.writes()).toEqual([]);
    expect(within(dlg).getByLabelText(/^effective from/i).getAttribute('aria-invalid')).toBe('true');
  });

  it('an overlapping assignment refused by the server (400 on /effective_from) is shown in the dialog; it stays open and nothing refreshes', async () => {
    API.fail = prob(400, 'common.validation_failed', [{ path: '/effective_from', code: 'common.validation_failed', message: 'Overlaps an existing assignment of this client to this representative' }]);
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(assignBtn());
    const dlg = await dialog();
    await fill(user, dlg);
    await user.click(within(dlg).getByRole('button', { name: /^save|^assign/i }));
    await waitFor(() => expect(norm(dlg.textContent)).toContain('Overlaps an existing assignment'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(TM.refresh.mock.calls.length).toBe(0);
  });

  it('double click on Save sends ONE request', async () => {
    API.writeDelayMs = 80;
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(assignBtn());
    const dlg = await dialog();
    await fill(user, dlg);
    await user.dblClick(within(dlg).getByRole('button', { name: /^save|^assign/i }));
    await quiet(250);
    expect(API.find('POST', /\/assignments$/)).toHaveLength(1);
  });
});

describe('Unassign', () => {
  const unassignBtn = (who: string) => within(rowOf(who)).getByRole('button', { name: /^unassign/i });

  it('asks first; confirming POSTs /assignments/<id>/unassign with If-Match "1" and no body date; refreshes', async () => {
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(unassignBtn('Synthetic General Hospital'));
    const dlg = await dialog();
    expect(API.writes(), 'asked first').toEqual([]);
    await user.click(within(dlg).getByRole('button', { name: /^unassign/i }));
    await waitFor(() => expect(API.find('POST', /\/unassign$/)).toHaveLength(1));
    const c = API.find('POST', /\/unassign$/)[0]!;
    expect(c.path).toContain(CLIENT_A['assignment_id']);
    expect(c.headers.get('if-match')).toBe('"1"');
    expect(c.json === undefined || Object.keys(c.json).length === 0).toBe(true);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a typed Last day is sent as effective_to; one before the assignment start (2026-05-01) is refused in the browser', async () => {
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(unassignBtn('Synthetic General Hospital'));
    const dlg = await dialog();
    fireEvent.change(within(dlg).getByLabelText(/^last day/i), { target: { value: '2026-04-01' } });
    await user.click(within(dlg).getByRole('button', { name: /^unassign/i }));
    await quiet(40);
    expect(API.writes()).toEqual([]);
    expect(within(dlg).getByLabelText(/^last day/i).getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(within(dlg).getByLabelText(/^last day/i), { target: { value: '2026-12-31' } });
    await user.click(within(dlg).getByRole('button', { name: /^unassign/i }));
    await waitFor(() => expect(API.find('POST', /\/unassign$/)).toHaveLength(1));
    expect(API.find('POST', /\/unassign$/)[0]!.json).toEqual({ effective_to: '2026-12-31' });
  });

  it('a stale or refused unassign (409 version_conflict) is shown as a plain sentence in the dialog, no raw code, no refresh', async () => {
    API.fail = prob(409, 'common.version_conflict');
    await openSales('clients');
    const user = userEvent.setup();
    await user.click(unassignBtn('Synthetic General Hospital'));
    const dlg = await dialog();
    await user.click(within(dlg).getByRole('button', { name: /^unassign/i }));
    await waitFor(() => expect(within(dlg).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(norm(document.body.textContent)).not.toMatch(/common\.version_conflict|urn:lims/);
    expect(TM.refresh.mock.calls.length).toBe(0);
  });
});

describe('permissions (partners.sales.manage)', () => {
  it('read only: Assign client and every Unassign are disabled with the visible reason; clicking sends nothing, opens nothing', async () => {
    await openSales('clients', { perms: READ });
    const user = userEvent.setup();
    blocked(assignBtn());
    blocked(within(rowOf('Synthetic General Hospital')).getByRole('button', { name: /^unassign/i }));
    await user.click(assignBtn());
    await user.click(within(rowOf('Synthetic General Hospital')).getByRole('button', { name: /^unassign/i }));
    await quiet(30);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(API.writes()).toEqual([]);
    expect(document.body.textContent).toContain(t(REASON));
  });
});
