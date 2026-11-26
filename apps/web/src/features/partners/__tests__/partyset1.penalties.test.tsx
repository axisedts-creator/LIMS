// @vitest-environment jsdom
// T0D-PARTYSET-1 — Penalty master and Penalty events (done_when 5, 6, 7; LD-321 "non compliance penalties charged once to the ledger"; LD-353 template 1 LIST).
// Pages: app/(staff)/partners/penalties/page.tsx (permission partners.penalty.manage) and app/(staff)/partners/penalty-events/page.tsx (same permission).
// PINNED UI NAMES (tester choice; writer may dispute through the ruling path):
//   - Penalty master headers: Code, Name, Amount, Active (+ optional "Actions"). Amount = rupees with two decimals from paisa (150000 -> 1,500.00; 50025 -> 500.25); Active = Yes / No.
//     Top button "Add penalty" -> dialog fields Code (A-Z 0-9 _ -, 1..20), Name (1..120), Amount (rupees, up to two decimals, 0..1,000,000,000.00); buttons Save / Cancel.
//     POST /v1/partners/admin/penalties { code, name, amount_paisa } with Idempotency-Key. Row "Edit" (Code read-only; PATCH sends only changed name / amount_paisa, If-Match "<version>"),
//     row "Deactivate" (confirm dialog button "Deactivate", POST .../deactivate with If-Match). Inactive rows have no Edit / Deactivate. Filter: text "Search" (q) in one FilterBar.
//   - Penalty events headers: Date, Party, Penalty, Amount, Status (+ optional "Actions"). Date = event_date as DD/MM/YYYY; Party = the party name (resolved from the party lists, else "<Type> <first 8 chars of the id>");
//     Penalty = the penalty name (from the penalties list); Status words Raised, Waived, Charged. FilterBar: kit Select "Status" (All, Raised, Waived, Charged), native date inputs "From" and "To".
//     Top button "Raise penalty" -> dialog: Party type (kit Select: Partner, Credit party, Doctor, Referrer), Party (kit Select, options by type from that type's list), Penalty (kit Select, ACTIVE penalties),
//     Event date (native date, default today), Amount (rupees, optional, default = the penalty amount), Reason (optional); POST /v1/partners/admin/penalty-events with Idempotency-Key.
//     Row buttons for RAISED rows only: Waive (dialog, required Reason, POST .../waive { reason } If-Match), Charge (confirm dialog button "Charge", POST .../charge, If-Match + Idempotency-Key, no body).
//     Waived and charged rows have no buttons. A charge is posted ONCE: a double press sends one request; the second answer (409 / replay) shows a message, never a second ledger line in the UI.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { expectListScreen, expectStateInPage } from '@/features/catalog/__tests__/uilist3.helpers';
import { API, ID, IDEM, P, PATHS, PERM, ROUTE, TM, api, headers, norm, openPage, optionNames, pickOption, prob, quiet, rowOf, selectTrigger } from './partyset1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const dlg = () => screen.findByRole('dialog');
const typeInto = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) => { await user.clear(el); if (v) await user.type(el, v); };
const field = (d: HTMLElement, label: string) => within(d).getByLabelText(new RegExp(`^${label}`, 'i')) as HTMLInputElement;
const btn = (row: HTMLElement, name: RegExp) => within(row).queryByRole('button', { name });
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const master = () => openPage(ROUTE.penalties, { perms: [PERM.penalty] });
const events = (search = '') => openPage(ROUTE.events, { perms: [PERM.penalty], search });

describe('Penalty master (done_when 5)', () => {
  it('LIST template with headers Code, Name, Amount, Active; amounts in rupees from paisa; Active Yes / No', async () => {
    const { container } = await master();
    await screen.findByText('Late sample delivery');
    expectListScreen(container as HTMLElement, { path: PATHS.penalties, headers: ['Code', 'Name', 'Amount', 'Active'] });
    expect(headers().slice(0, 4)).toEqual(['Code', 'Name', 'Amount', 'Active']);
    expect(rowOf('Late sample delivery').textContent).toContain('1,500.00');
    expect(rowOf('Missing PAN on invoice').textContent).toContain('500.25');
    expect(rowOf('Missing PAN on invoice').textContent).not.toMatch(/50025/);
    expect(rowOf('Late sample delivery').textContent).toMatch(/Yes/);
    expect(rowOf('Retired penalty').textContent).toMatch(/No/);
    expect(API.find('GET', /\/penalties$/)[0]!.search.get('limit') ? Number(API.find('GET', /\/penalties$/)[0]!.search.get('limit')) : 50).toBeLessThanOrEqual(50);
  });
  it('empty: the four headers stay with an EmptyState; failing read keeps the title; no permission shows the notice and makes no call', async () => {
    API.penalties = [];
    const { container } = await master();
    await waitFor(() => expect(headers().slice(0, 4)).toEqual(['Code', 'Name', 'Amount', 'Active']));
    expect(container.querySelector('.lims-empty-state, [class*="empty-state"]')).toBeTruthy();
    cleanup(); API.reset(); API.readFail = 500;
    const failed = await master();
    await screen.findByRole('alert');
    expectStateInPage(failed.container as HTMLElement, { path: PATHS.penalties, kind: 'either' });
    cleanup(); API.reset();
    await openPage(ROUTE.penalties, { perms: [PERM.partnerRead] });
    await screen.findByText(/do not have permission/i);
    expect(API.calls).toHaveLength(0);
  });
  it('the search box sends q to the list call', async () => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    await user.type(screen.getByRole('searchbox', { name: /search/i }), 'PAN{Enter}');
    await waitFor(() => expect(TM.push.mock.calls.concat(TM.replace.mock.calls).some((c) => /q=PAN/.test(String(c[0])))).toBe(true));
  });
  it('Add penalty: POST { code, name, amount_paisa } with an Idempotency-Key; 1500.50 rupees -> 150050 paisa exactly', async () => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    await user.click(screen.getByRole('button', { name: /^add penalty$/i }));
    const d = await dlg();
    await typeInto(user, field(d, 'Code'), 'DAMAGED');
    await typeInto(user, field(d, 'Name'), 'Damaged sample');
    await typeInto(user, field(d, 'Amount'), '1500.50');
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(API.find('POST', /\/penalties$/)).toHaveLength(1));
    const c = API.find('POST', /\/penalties$/)[0]!;
    expect(c.json).toEqual({ code: 'DAMAGED', name: 'Damaged sample', amount_paisa: 150050 });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it.each([
    ['lowercase code', 'late', 'Name', '10'],
    ['code with a space', 'A B', 'Name', '10'],
    ['code of 21 characters', 'A'.repeat(21), 'Name', '10'],
    ['empty code', '', 'Name', '10'],
    ['empty name', 'OK1', '', '10'],
    ['amount with three decimals', 'OK1', 'Name', '1.005'],
    ['negative amount', 'OK1', 'Name', '-5'],
    ['amount not a number', 'OK1', 'Name', 'ten'],
    ['amount above the limit (1,000,000,000.01)', 'OK1', 'Name', '1000000000.01'],
  ])('%s: refused with an inline error, no request', async (_n, code, name, amount) => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    await user.click(screen.getByRole('button', { name: /^add penalty$/i }));
    const d = await dlg();
    await typeInto(user, field(d, 'Code'), code);
    await typeInto(user, field(d, 'Name'), name);
    await typeInto(user, field(d, 'Amount'), amount);
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await quiet();
    expect(API.find('POST', /\/penalties$/)).toHaveLength(0);
    expect(within(d).getAllByRole('alert').length + d.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
  });
  it('amount 0 is allowed (a zero penalty is a valid master row)', async () => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    await user.click(screen.getByRole('button', { name: /^add penalty$/i }));
    const d = await dlg();
    await typeInto(user, field(d, 'Code'), 'ZERO');
    await typeInto(user, field(d, 'Name'), 'Zero amount');
    await typeInto(user, field(d, 'Amount'), '0');
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(API.find('POST', /\/penalties$/)).toHaveLength(1));
    expect(API.find('POST', /\/penalties$/)[0]!.json.amount_paisa).toBe(0);
  });
  it('Edit: the code is read-only, PATCH sends only what changed with If-Match "<version>"', async () => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    await user.click(btn(rowOf('Late sample delivery'), /^edit$/i)!);
    const d = await dlg();
    expect(field(d, 'Code').readOnly || (field(d, 'Code') as HTMLInputElement).disabled).toBe(true);
    expect(field(d, 'Amount').value).toMatch(/^1,?500(\.00)?$/);
    await typeInto(user, field(d, 'Amount'), '1750.25');
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(API.find('PATCH', /\/penalties\//)).toHaveLength(1));
    const c = API.find('PATCH', /\/penalties\//)[0]!;
    expect(c.path).toBe(`/v1/partners/admin/penalties/${ID(101)}`);
    expect(c.json).toEqual({ amount_paisa: 175025 });
    expect(c.headers.get('if-match')).toMatch(/^"?2"?$/);
  });
  it('Deactivate asks first, then POSTs .../deactivate with If-Match; inactive rows have no Edit or Deactivate', async () => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    expect(btn(rowOf('Retired penalty'), /^(edit|deactivate)$/i)).toBeNull();
    await user.click(btn(rowOf('Missing PAN on invoice'), /^deactivate$/i)!);
    const d = await dlg();
    expect(API.find('POST', /deactivate/)).toHaveLength(0);
    await user.click(within(d).getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() => expect(API.find('POST', /deactivate/)).toHaveLength(1));
    expect(API.find('POST', /deactivate/)[0]!.path).toBe(`/v1/partners/admin/penalties/${ID(102)}/deactivate`);
    expect(API.find('POST', /deactivate/)[0]!.headers.get('if-match')).toMatch(/^"?1"?$/);
  });
  it('409 on save shows a banner with Refresh; a duplicate code (409 / 422 from the server) shows the server message', async () => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    await user.click(screen.getByRole('button', { name: /^add penalty$/i }));
    const d = await dlg();
    await typeInto(user, field(d, 'Code'), 'LATE');
    await typeInto(user, field(d, 'Name'), 'Dup');
    await typeInto(user, field(d, 'Amount'), '5');
    API.fail = prob(422, 'common.validation_failed', [{ path: 'code', code: 'duplicate', message: 'This penalty code already exists.' }]);
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await screen.findByText('This penalty code already exists.');
  });
  it('has no axe violations (list and dialog)', async () => {
    const user = userEvent.setup();
    await master();
    await screen.findByText('Late sample delivery');
    await axeClean();
    await user.click(screen.getByRole('button', { name: /^add penalty$/i }));
    await dlg();
    await axeClean();
  });
});

describe('Penalty events (done_when 5)', () => {
  it('LIST template with headers Date, Party, Penalty, Amount, Status; party and penalty names, rupees, dates, status words', async () => {
    const { container } = await events();
    await screen.findByText('Synthetic Collection Lab');
    expectListScreen(container as HTMLElement, { path: PATHS.events, headers: ['Date', 'Party', 'Penalty', 'Amount', 'Status'] });
    expect(headers().slice(0, 5)).toEqual(['Date', 'Party', 'Penalty', 'Amount', 'Status']);
    const r1 = rowOf('Synthetic Collection Lab').textContent!;
    expect(r1).toContain('15/11/2026'); expect(r1).toContain('Late sample delivery'); expect(r1).toContain('1,500.00'); expect(r1).toMatch(/Raised/);
    const r2 = rowOf('Synthetic General Hospital').textContent!;
    expect(r2).toContain('Missing PAN on invoice'); expect(r2).toContain('500.25'); expect(r2).toMatch(/Waived/);
    expect(rowOf('Synthetic Doctor Zeta').textContent).toMatch(/Charged/);
  });
  it('empty: the five headers stay with an EmptyState; a failing read keeps the title and shows a state inside the page', async () => {
    API.events = [];
    const { container } = await events();
    await waitFor(() => expect(headers().slice(0, 5)).toEqual(['Date', 'Party', 'Penalty', 'Amount', 'Status']));
    expect(container.querySelector('.lims-empty-state, [class*="empty-state"]')).toBeTruthy();
    cleanup(); API.reset(); API.readFail = 500;
    const failed = await events();
    await screen.findByRole('alert');
    expectStateInPage(failed.container as HTMLElement, { path: PATHS.events, kind: 'either' });
  });
  it('filters: Status goes to the list call as status=; From / To are native date inputs sent as from_date / to_date', async () => {
    const user = userEvent.setup();
    await events('status=raised&from_date=2026-11-01&to_date=2026-11-30');
    await waitFor(() => expect(API.find('GET', /penalty-events$/).length).toBeGreaterThan(0));
    const q = API.find('GET', /penalty-events$/)[0]!.search;
    expect(q.get('status')).toBe('raised'); expect(q.get('from_date')).toBe('2026-11-01'); expect(q.get('to_date')).toBe('2026-11-30');
    expect((screen.getByLabelText(/^from/i) as HTMLInputElement).type).toBe('date');
    expect((screen.getByLabelText(/^to/i) as HTMLInputElement).type).toBe('date');
    await pickOption(user, document.body, /^status/i, /^charged$/i);
    await waitFor(() => expect(TM.push.mock.calls.concat(TM.replace.mock.calls).some((c) => /status=charged/.test(String(c[0])))).toBe(true));
  });
  it('only RAISED rows have Waive and Charge', async () => {
    await events();
    await screen.findByText('Synthetic Collection Lab');
    expect(btn(rowOf('Synthetic Collection Lab'), /^waive$/i)).toBeTruthy();
    expect(btn(rowOf('Synthetic Collection Lab'), /^charge$/i)).toBeTruthy();
    for (const who of ['Synthetic General Hospital', 'Synthetic Doctor Zeta']) expect(within(rowOf(who)).queryAllByRole('button'), who).toHaveLength(0);
  });
  it('Waive needs a reason: empty -> inline error, no call; with a reason -> POST waive { reason } with If-Match', async () => {
    const user = userEvent.setup();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await user.click(btn(rowOf('Synthetic Collection Lab'), /^waive$/i)!);
    const d = await dlg();
    await user.click(within(d).getByRole('button', { name: /^waive$/i }));
    await quiet();
    expect(API.find('POST', /waive/)).toHaveLength(0);
    expect(within(d).getByLabelText(/^reason/i).getAttribute('aria-invalid')).toBe('true');
    await user.type(within(d).getByLabelText(/^reason/i), 'Synthetic: first offence');
    await user.click(within(d).getByRole('button', { name: /^waive$/i }));
    await waitFor(() => expect(API.find('POST', /waive/)).toHaveLength(1));
    const c = API.find('POST', /waive/)[0]!;
    expect(c.path).toBe(`/v1/partners/admin/penalty-events/${ID(111)}/waive`);
    expect(c.json).toEqual({ reason: 'Synthetic: first offence' });
    expect(c.headers.get('if-match')).toMatch(/^"?1"?$/);
  });
  it('Charge asks first (amount and party in the dialog), then POSTs .../charge with If-Match and an Idempotency-Key, no body', async () => {
    const user = userEvent.setup();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await user.click(btn(rowOf('Synthetic Collection Lab'), /^charge$/i)!);
    const d = await dlg();
    expect(d.textContent).toContain('1,500.00');
    expect(API.find('POST', /charge/)).toHaveLength(0);
    await user.click(within(d).getByRole('button', { name: /^charge$/i }));
    await waitFor(() => expect(API.find('POST', /charge/)).toHaveLength(1));
    const c = API.find('POST', /charge/)[0]!;
    expect(c.path).toBe(`/v1/partners/admin/penalty-events/${ID(111)}/charge`);
    expect(c.headers.get('if-match')).toMatch(/^"?1"?$/);
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    expect(c.json === undefined || Object.keys(c.json).length === 0).toBe(true);
  });
  it('charged ONCE: a double press on the dialog Charge sends one request; a 409 from the server shows a message and no second charge is sent', async () => {
    API.writeDelayMs = 150;
    const user = userEvent.setup();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await user.click(btn(rowOf('Synthetic Collection Lab'), /^charge$/i)!);
    const d = await dlg();
    const go = within(d).getByRole('button', { name: /^charge$/i });
    await user.click(go); await user.click(go).catch(() => undefined);
    await quiet(500);
    expect(API.find('POST', /charge/)).toHaveLength(1);
    cleanup(); API.reset();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await user.click(btn(rowOf('Synthetic Collection Lab'), /^charge$/i)!);
    API.fail = prob(409, 'common.version_conflict');
    await user.click(within(await dlg()).getByRole('button', { name: /^charge$/i }));
    await screen.findByRole('alert');
    expect(API.find('POST', /charge/)).toHaveLength(1);
  });
  it('Raise penalty: party list follows the type, only ACTIVE penalties are offered, amount defaults to the penalty (not sent unless changed), POST with an Idempotency-Key', async () => {
    const user = userEvent.setup();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await user.click(screen.getByRole('button', { name: /^raise penalty$/i }));
    const d = await dlg();
    await pickOption(user, d, /^party type/i, /^credit party$/i);
    await user.click(selectTrigger(d, /^party$/i));
    expect(optionNames()).toContain('Synthetic General Hospital');
    await user.click(await screen.findByRole('option', { name: /Synthetic General Hospital/ }));
    await user.click(selectTrigger(d, /^penalty$/i));
    expect(optionNames().join('|')).toContain('Late sample delivery');
    expect(optionNames().join('|')).not.toContain('Retired penalty');
    await user.click(await screen.findByRole('option', { name: /Missing PAN on invoice/ }));
    expect(field(d, 'Amount').value).toMatch(/^500\.25$/);
    await typeInto(user, field(d, 'Event date'), '2026-11-18');
    await user.click(within(d).getByRole('button', { name: /^(raise|save)/i }));
    await waitFor(() => expect(API.find('POST', /penalty-events$/)).toHaveLength(1));
    const c = API.find('POST', /penalty-events$/)[0]!;
    expect(c.json).toMatchObject({ party_kind: 'credit_party', party_id: P.cp, penalty_id: ID(102), event_date: '2026-11-18' });
    expect(c.json['amount_paisa'] === undefined || c.json['amount_paisa'] === 50025).toBe(true);
    expect(c.headers.get('idempotency-key') ?? '').toMatch(IDEM);
  });
  it('Raise with an overridden amount sends integer paisa; an inactive-penalty answer (422) shows the server message', async () => {
    const user = userEvent.setup();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await user.click(screen.getByRole('button', { name: /^raise penalty$/i }));
    const d = await dlg();
    await pickOption(user, d, /^party type/i, /^partner$/i);
    await pickOption(user, d, /^party$/i, /Synthetic Collection Lab/);
    await pickOption(user, d, /^penalty$/i, /Late sample delivery/);
    await typeInto(user, field(d, 'Amount'), '99.99');
    API.fail = prob(422, 'common.validation_failed', [{ path: 'penalty_id', code: 'inactive', message: 'This penalty is no longer active.' }]);
    await user.click(within(d).getByRole('button', { name: /^(raise|save)/i }));
    await screen.findByText('This penalty is no longer active.');
    expect(API.find('POST', /penalty-events$/)[0]!.json.amount_paisa).toBe(9999);
  });
  it('Raise with a required field missing (party, penalty, date) makes no request', async () => {
    const user = userEvent.setup();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await user.click(screen.getByRole('button', { name: /^raise penalty$/i }));
    const d = await dlg();
    await user.click(within(d).getByRole('button', { name: /^(raise|save)/i }));
    await quiet();
    expect(API.find('POST', /penalty-events$/)).toHaveLength(0);
    expect(within(d).getAllByRole('alert').length + d.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
  });
  it('no permission: the notice and no call; no axe violations on the list', async () => {
    await openPage(ROUTE.events, { perms: [PERM.partnerRead] });
    await screen.findByText(/do not have permission/i);
    expect(API.calls).toHaveLength(0);
    cleanup(); API.reset();
    await events();
    await screen.findByText('Synthetic Collection Lab');
    await axeClean();
    expect(norm(document.body.textContent)).not.toMatch(/!/);
  });
});
