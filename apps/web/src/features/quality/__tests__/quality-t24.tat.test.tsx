// @vitest-environment jsdom
// C9.T-24 — TAT alerts `/quality/tat-alerts` (04-UI-UX §1.1 badge, §2.10; 03-APP-FLOW §4; 02-TRD #48/#50; AC-14.6, AC-14.7, AC-14.8; 07-SECURITY TAT row: ack needs quality.tat_alert.ack, append-only; LD-140).
// ASSUMED contract (spec silent on seams; writer must follow):
//   * app/(staff)/quality/tat-alerts/page.tsx = default async server component `Page({ searchParams })`; PageHeader (helpKey) + FilterBar + DataTable (role grid, name /tat alerts/i).
//   * No `quality.tat_alert.read` -> EmptyState "You don't have access to this page", NO API call. 403 common.feature_disabled -> "The QC module is not switched on for your lab yet."; 5xx rejects (error.tsx).
//   * Read: GET #48 with default `acknowledged=false` and `sort=-alert_level_rank` (level desc; the API breaks ties by % of target). URL filters level (csv), acknowledged, segment, department_id, centre_id, priority are
//     whitelisted and passed through; any other key or invalid value is dropped. Centre scoping is server-side (RLS `__tenant_centre`): the page never sends a centre the user did not pick and never filters rows itself (AC-14.7).
//   * Badge (04-UI-UX §1.1): server module features/quality/server/tat-badge.ts exports `getTatAlertBadge(): Promise<string | undefined>` = count of rows of GET #48 `level=breached,escalated&acknowledged=false&limit=50`,
//     "50+" when the page is full, undefined when 0 or when the user lacks quality.tat_alert.read (no call) or the call fails. The nav (core, not T-24) is wired to it later.
//   * "Acknowledge" button per row + dialog (role dialog) with a "Note" TextArea (optional, <=500). Writes are server actions -> serverFetch: POST #50 with If-Match "<version>" + Idempotency-Key, body {} or {note}.
//     Success -> dialog closes, toast, router.refresh(). Buttons only with `quality.tat_alert.ack`. Row shortcut `A` opens the same dialog. "Open specimen" = <a href="/lab/specimens/<specimen_id>"> built by buildRoute(staff.lab.specimen).
//   * AC-14.8: every row names its segment: short label ("Within lab" / "Total") in the Segment cell and the API's full `segment_label` in a tooltip (title / aria-label / tooltip role).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import {
  CENTRE_1, PERM_TAT_ACK, PERM_TAT_READ, SPEC_1, TAT, TAT_1, TAT_2, TAT_3, TAT_4, TOTAL, WITHIN_LAB, anyDlg, api, axeClean, bodyOf, calls, callsTo, dataRows, dlg, field, fill, gridNamed, headersOf, hrefs,
  json, norm, pageText, problem, resetApi, routes, router, show, showOrThrown, tatAlert, tatPage, user,
} from './quality-t24.harness';

vi.mock('next/navigation', async () => (await import('./quality-t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t24.harness')).sessionMock);

const PAGE = 'tat-alerts/page';
const DENIED = /You don't have access to this page/;
const ACK = (id: string) => `${TAT}/${id}/acknowledge`;
const grid = () => gridNamed(/tat alerts/i);
const rowOf = (code: string) => dataRows(grid()).find((r) => norm(r.textContent).includes(code))!;

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(PERM_TAT_ACK));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('access and honest states', () => {
  it('without quality.tat_alert.read: permission-denied state and NO API call', async () => {
    resetApi([]);
    await show(PAGE);
    expect(pageText()).toMatch(DENIED);
    expect(calls).toHaveLength(0);
  });
  it('403 common.feature_disabled -> "The QC module is not switched on for your lab yet."', async () => {
    routes[`GET ${TAT}`] = () => problem('common.feature_disabled', 403);
    await show(PAGE);
    expect(pageText()).toContain('The QC module is not switched on for your lab yet.');
  });
  it('5xx rejects (error.tsx); the Bearer token is sent but never rendered', async () => {
    const { container } = await show(PAGE);
    expect(callsTo('GET', TAT)[0]!.headers.get('authorization')).toMatch(/^Bearer \S+/);
    expect(container.innerHTML).not.toContain('jwt-synthetic');
    cleanup();
    routes[`GET ${TAT}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE)).toBeTruthy();
  });
  it('empty -> "No open TAT alerts."', async () => {
    routes[`GET ${TAT}`] = json(tatPage([]));
    await show(PAGE);
    expect(pageText()).toContain('No open TAT alerts.');
  });
});

describe('query (#48) — defaults and whitelist', () => {
  it('default: acknowledged=false, sort=-alert_level_rank, only GETs on render', async () => {
    await show(PAGE);
    const q = callsTo('GET', TAT)[0]!.url.searchParams;
    expect(q.get('acknowledged')).toBe('false');
    expect(q.get('sort')).toBe('-alert_level_rank');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('valid URL filters are passed through; unknown keys are dropped', async () => {
    await show(PAGE, { searchParams: { level: 'breached,escalated', acknowledged: 'true', segment: 'total', priority: 'urgent', centre_id: CENTRE_1, evil: '1' } });
    const q = callsTo('GET', TAT)[0]!.url.searchParams;
    expect(q.get('level')).toBe('breached,escalated');
    expect(q.get('acknowledged')).toBe('true');
    expect(q.get('segment')).toBe('total');
    expect(q.get('priority')).toBe('urgent');
    expect(q.get('centre_id')).toBe(CENTRE_1);
    expect(q.has('evil')).toBe(false);
  });
  it('invalid values are dropped, never forwarded (no injection into the API query)', async () => {
    await show(PAGE, { searchParams: { level: "breached,none,'; DROP TABLE", segment: 'both', priority: 'asap', acknowledged: 'maybe', sort: 'tenant_id', centre_id: 'not-a-uuid', department_id: '1 OR 1=1' } });
    const q = callsTo('GET', TAT)[0]!.url.searchParams;
    expect(q.get('level') ?? 'breached').toBe('breached');
    expect(q.has('segment')).toBe(false);
    expect(q.has('priority')).toBe(false);
    expect(q.get('acknowledged')).toBe('false');
    expect(q.get('sort')).toBe('-alert_level_rank');
    expect(q.has('centre_id')).toBe(false);
    expect(q.has('department_id')).toBe(false);
  });
  it('AC-14.7: renders exactly the rows the API returned (centre scoping is RLS on the server; the page adds no centre filter of its own)', async () => {
    routes[`GET ${TAT}`] = json(tatPage([tatAlert({ test_code: 'GLU' })]));
    await show(PAGE);
    expect(dataRows(grid())).toHaveLength(1);
    expect(callsTo('GET', TAT)[0]!.url.searchParams.has('centre_id')).toBe(false);
  });
});

describe('list (04-UI-UX §2.10)', () => {
  it('columns', async () => {
    await show(PAGE);
    expect(headersOf(grid())).toEqual(expect.arrayContaining(['Level', 'Test', 'Department', 'Priority', 'Centre', 'Segment', 'Started', 'Elapsed / target', '% of target', 'Acknowledged']));
    expect(dataRows(grid())).toHaveLength(4);
  });
  it('level shows its WORD with the chip (Escalated / Breached / Warning), never colour alone', async () => {
    await show(PAGE);
    expect(norm(rowOf('GLU').textContent)).toMatch(/Breached/);
    expect(norm(rowOf('TSH').textContent)).toMatch(/Escalated/);
    expect(norm(rowOf('CRE').textContent)).toMatch(/Warning/);
  });
  it('elapsed / target reads "4 h 12 min / 4 h" and the % of target is shown', async () => {
    await show(PAGE);
    expect(norm(rowOf('GLU').textContent)).toContain('4 h 12 min / 4 h');
    expect(norm(rowOf('GLU').textContent)).toMatch(/105\s?%/);
    expect(norm(rowOf('CRE').textContent)).toContain('1 h 36 min / 2 h');
  });
  it('urgent rows carry an "Urgent" badge, routine rows do not', async () => {
    await show(PAGE);
    expect(norm(rowOf('GLU').textContent)).toMatch(/Urgent/);
    expect(norm(rowOf('TSH').textContent)).not.toMatch(/Urgent/);
  });
  it('shows no patient identifiers (C9 pages carry none)', async () => {
    await show(PAGE);
    expect(pageText()).not.toMatch(/patient name|barcode|registration no/i);
  });
  it('"Open specimen" is a real link to /lab/specimens/<specimen_id>; absent when the alert has no specimen', async () => {
    await show(PAGE);
    expect(hrefs()).toContain(`/lab/specimens/${SPEC_1}`);
    expect(within(rowOf('TSH')).queryByRole('link', { name: /open specimen/i })).toBeNull();
  });
  it('axe clean', async () => { await show(PAGE); await axeClean(); });
});

describe('AC-14.8 — every TAT figure names its segment', () => {
  it('each row has a Segment cell with the short label', async () => {
    await show(PAGE);
    expect(norm(rowOf('GLU').textContent)).toMatch(/Within lab/);
    expect(norm(rowOf('TSH').textContent)).toMatch(/Total/);
  });
  it('the full definition from segment_label is available (tooltip / title) for both segments', async () => {
    await show(PAGE);
    const u = user();
    await u.hover(within(rowOf('GLU')).getByText(/Within lab/));
    await waitFor(() => expect(pageText()).toContain(WITHIN_LAB));
    await u.unhover(within(rowOf('GLU')).getByText(/Within lab/));
    await u.hover(within(rowOf('TSH')).getByText(/^Total/));
    await waitFor(() => expect(pageText()).toContain(TOTAL));
  });
  it('the page header or filter bar offers the two segments as words (filter "Segment")', async () => {
    await show(PAGE);
    expect(screen.queryByRole('button', { name: /segment/i }) ?? screen.queryByLabelText(/segment/i)).not.toBeNull();
  });
});

describe('AC-14.6 — acknowledged-by/at and re-raise', () => {
  it('an acknowledged alert shows who and when (DateText DD/MM/YYYY), unacknowledged shows "—"', async () => {
    routes[`GET ${TAT}`] = json(tatPage([tatAlert({ tat_item_id: TAT_4, test_code: 'NAK', alert_level: 'warning', acknowledged_level: 'warning', acknowledged_at: '2026-11-14T03:10:00.000Z', acknowledged_by_display: 'Synthetic Supervisor' }), tatAlert()]));
    await show(PAGE);
    expect(norm(rowOf('NAK').textContent)).toMatch(/Synthetic Supervisor/);
    expect(norm(rowOf('NAK').textContent)).toMatch(/14\/11\/2026/);
    expect(norm(rowOf('GLU').textContent)).toContain('—');
  });
  it('a higher level than the acknowledged one shows "New level since acknowledgement"; an equal level does not', async () => {
    routes[`GET ${TAT}`] = json(tatPage([
      tatAlert({ tat_item_id: TAT_4, test_code: 'NAK', alert_level: 'breached', acknowledged_level: 'warning', acknowledged_at: '2026-11-14T03:10:00.000Z', acknowledged_by_display: 'Synthetic Supervisor' }),
      tatAlert({ tat_item_id: TAT_3, test_code: 'CRE', alert_level: 'warning', acknowledged_level: 'warning', acknowledged_at: '2026-11-14T03:10:00.000Z', acknowledged_by_display: 'Synthetic Supervisor' }),
    ]));
    await show(PAGE, { searchParams: { acknowledged: 'true' } });
    expect(norm(rowOf('NAK').textContent)).toMatch(/New level since acknowledgement/);
    expect(norm(rowOf('CRE').textContent)).not.toMatch(/New level since acknowledgement/);
  });
  it('without quality.tat_alert.ack there is no Acknowledge button and no shortcut dialog', async () => {
    resetApi(PERM_TAT_READ);
    await show(PAGE);
    expect(screen.queryAllByRole('button', { name: /acknowledge/i })).toHaveLength(0);
    (rowOf('GLU') as HTMLElement).focus();
    await user().keyboard('a');
    expect(anyDlg()).toBeNull();
  });
  it('Acknowledge opens a dialog with an optional "Note"; submitting empty POSTs {} with If-Match "<version>" and an Idempotency-Key, then closes, toasts, refreshes', async () => {
    routes[`POST ${ACK(TAT_1)}`] = json(tatAlert({ acknowledged_level: 'breached', acknowledged_at: '2026-11-14T04:01:00.000Z', acknowledged_by_display: 'Synthetic Supervisor', version: 6 }));
    await show(PAGE);
    await user().click(within(rowOf('GLU')).getByRole('button', { name: /acknowledge/i }));
    expect(dlg()).toBeTruthy();
    expect(field(/^note/i).tagName).toBe('TEXTAREA');
    await user().click(within(dlg()).getByRole('button', { name: /^acknowledge/i }));
    await waitFor(() => expect(callsTo('POST', ACK(TAT_1))).toHaveLength(1));
    const c = callsTo('POST', ACK(TAT_1))[0]!;
    expect(c.headers.get('if-match')).toBe('"5"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(bodyOf(c)).toEqual({});
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(anyDlg()).toBeNull();
  });
  it('a note is trimmed and sent as {note}', async () => {
    routes[`POST ${ACK(TAT_1)}`] = json(tatAlert());
    await show(PAGE);
    await user().click(within(rowOf('GLU')).getByRole('button', { name: /acknowledge/i }));
    await fill(/^note/i, '  analyser queue backlog, re-run in progress  ');
    await user().click(within(dlg()).getByRole('button', { name: /^acknowledge/i }));
    await waitFor(() => expect(callsTo('POST', ACK(TAT_1))).toHaveLength(1));
    expect(bodyOf(callsTo('POST', ACK(TAT_1))[0])).toEqual({ note: 'analyser queue backlog, re-run in progress' });
  });
  // Ruling C9.T-24: kit TextArea has native maxlength=500, so a 501 paste is cut to 500 and the POST is valid (as T-21, LD-178).
  it('a 501-character paste is cut to 500 by the kit TextArea; exactly one POST with a 500-char note', async () => {
    routes[`POST ${ACK(TAT_1)}`] = json(tatAlert());
    await show(PAGE);
    await user().click(within(rowOf('GLU')).getByRole('button', { name: /acknowledge/i }));
    await user().click(field(/^note/i));
    await user().paste('x'.repeat(501));
    await user().click(within(dlg()).getByRole('button', { name: /^acknowledge/i }));
    await waitFor(() => expect(callsTo('POST', ACK(TAT_1))).toHaveLength(1));
    expect((bodyOf(callsTo('POST', ACK(TAT_1))[0]).note as string).length).toBe(500);
  });
  it('409 common.immutable_record (clock stopped meanwhile): the dialog shows an error, nothing is refreshed as success', async () => {
    routes[`POST ${ACK(TAT_1)}`] = () => problem('common.immutable_record', 409);
    await show(PAGE);
    await user().click(within(rowOf('GLU')).getByRole('button', { name: /acknowledge/i }));
    await user().click(within(dlg()).getByRole('button', { name: /^acknowledge/i }));
    await waitFor(() => expect(callsTo('POST', ACK(TAT_1))).toHaveLength(1));
    await waitFor(() => expect(within(dlg()).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('409 common.version_conflict: error shown, dialog stays open', async () => {
    routes[`POST ${ACK(TAT_1)}`] = () => problem('common.version_conflict', 409);
    await show(PAGE);
    await user().click(within(rowOf('GLU')).getByRole('button', { name: /acknowledge/i }));
    await user().click(within(dlg()).getByRole('button', { name: /^acknowledge/i }));
    await waitFor(() => expect(within(dlg()).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(anyDlg()).not.toBeNull();
  });
  it('403 auth.forbidden: error shown, never a success toast', async () => {
    routes[`POST ${ACK(TAT_1)}`] = () => problem('auth.forbidden', 403);
    await show(PAGE);
    await user().click(within(rowOf('GLU')).getByRole('button', { name: /acknowledge/i }));
    await user().click(within(dlg()).getByRole('button', { name: /^acknowledge/i }));
    await waitFor(() => expect(within(dlg()).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('keyboard-only: focus the row, press A -> the Acknowledge dialog opens for that row (02-TRD §14 "keyboard-only: acknowledge TAT alert")', async () => {
    routes[`POST ${ACK(TAT_2)}`] = json(tatAlert({ tat_item_id: TAT_2 }));
    await show(PAGE);
    (rowOf('TSH') as HTMLElement).focus();
    const u = user();
    await u.keyboard('a');
    expect(dlg()).toBeTruthy();
    await u.keyboard('{Enter}');
    await waitFor(() => expect(callsTo('POST', ACK(TAT_2))).toHaveLength(1));
    expect(callsTo('POST', ACK(TAT_2))[0]!.headers.get('if-match')).toBe('"2"');
  });
  it('the dialog traps focus and Escape closes it without a request', async () => {
    await show(PAGE);
    await user().click(within(rowOf('GLU')).getByRole('button', { name: /acknowledge/i }));
    await user().keyboard('{Escape}');
    await waitFor(() => expect(anyDlg()).toBeNull());
    expect(callsTo('POST', ACK(TAT_1))).toHaveLength(0);
  });
});

describe('nav badge (04-UI-UX §1.1)', () => {
  const badge = async () => ((await import(/* @vite-ignore */ `../server/${'tat-badge'}`)) as { getTatAlertBadge: () => Promise<string | undefined> }).getTatAlertBadge();
  const rows = (n: number) => Array.from({ length: n }, (_, i) => tatAlert({ tat_item_id: `01a1a98a-ac40-7000-8000-0000000d${String(i).padStart(4, '0')}` }));
  it('asks #48 for breached+escalated, unacknowledged, limit 50 and returns the row count', async () => {
    routes[`GET ${TAT}`] = json(tatPage(rows(3)));
    expect(await badge()).toBe('3');
    const q = callsTo('GET', TAT)[0]!.url.searchParams;
    expect(q.get('level')).toBe('breached,escalated');
    expect(q.get('acknowledged')).toBe('false');
    expect(q.get('limit')).toBe('50');
  });
  it('a full page shows "50+"', async () => {
    routes[`GET ${TAT}`] = json(tatPage(rows(50)));
    expect(await badge()).toBe('50+');
  });
  it('no rows -> no badge', async () => {
    routes[`GET ${TAT}`] = json(tatPage([]));
    expect(await badge()).toBeUndefined();
  });
  it('without quality.tat_alert.read: no badge and NO API call', async () => {
    resetApi([]);
    expect(await badge()).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
  it('API failure never breaks the nav: no badge, no throw', async () => {
    routes[`GET ${TAT}`] = () => HttpResponse.json({ code: 'common.internal' }, { status: 500 });
    expect(await badge()).toBeUndefined();
  });
});
