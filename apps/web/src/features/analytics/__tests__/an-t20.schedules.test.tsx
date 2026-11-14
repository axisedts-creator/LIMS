// @vitest-environment jsdom
// AN-T20 — S6 Scheduled reports: list schedules/page.tsx, editor schedules/new/page.tsx + schedules/[schedule_id]/page.tsx (04-UI-UX §8; US-18.1/.3/.6 UI side,
// 07-SECURITY name CHECK / link-only note). Create/edit conflict handling = task "tests" line.
// ASSUMED contract:
//   * every page is a default async server component `Page({ searchParams?, params? })`; each checks the session permission `analytics.schedule.manage` BEFORE any API call
//     (notFound() otherwise). List reads GET /v1/analytics/schedules; editor reads GET /v1/analytics/filter-options (recipients, centres) and, for edit,
//     GET /v1/analytics/schedules/{id} (ScheduleDetailDto incl. `runs`; 404 -> notFound()).
//   * list = kit DataTable (role=grid, name /schedule/i): Name · Reports · Frequency · Period · Recipients · Next send · Status · (actions). Edit = link to
//     /analytics/schedules/<id>; Deactivate = button (active rows only) -> ConfirmDialog "Stop sending this report?" -> POST /schedules/<id>/deactivate with If-Match "<version>" and body {}.
//   * editor = kit Form: Name textbox (maxLength 80); Reports checkbox group (only codes the session may read: dashboard.read -> the MIS reports, collections.read -> Collections,
//     referral_report.read -> Referral business report; default Dashboard + Income; ≤ 10); Frequency radios Daily / Weekly / Monthly (A.D.) / Monthly (B.S.); Weekday select only when Weekly
//     (default Sunday = ISO 7); Send time (Nepal time) default 07:00; Period default "Previous day"; Centres; Recipients Combobox (multi, display names only, default = the signed-in membership
//     `actor.membershipId`); submit button /save|create/i and Ctrl+Enter. Server actions post: create = POST /schedules (Idempotency-Key), edit = PUT /schedules/<id> (If-Match "<version>");
//     success = router.push/replace('/analytics/schedules…'); failures stay on the form and show role=alert.
//   * edit page run log: grid /run log/i with columns Slot time · Period (…), ≤ 20 rows from `runs` (sent/skipped/omitted are not in ReportRunSummary: not asserted).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  FILTER_OPTIONS, MEMBER_2, OWNER_M, PERIOD, SCHED_ID, TOKEN, api, axeClean, bodyOf, calls, callsTo, gridNamed, headersOf, json, lastNav, norm, pageText, problem, resetApi, router, routes, rowTexts, scheduleDto, show, showOrThrown,
} from './an-t20.harness';

vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock);

const LIST_PAGE = 'schedules/page';
const NEW_PAGE = 'schedules/new/page';
const EDIT_PAGE = 'schedules/[schedule_id]/page';
const S = '/v1/analytics/schedules';
const ONE = `${S}/${SCHED_ID}`;
const MANAGE = ['analytics.schedule.manage', 'analytics.dashboard.read'];
const NAME_ERR = 'Names cannot contain email addresses, phone numbers or web addresses';
const detail = (over: Record<string, unknown> = {}) => ({ ...scheduleDto(), runs: [], ...over });
const runs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `01a1a98a-ac40-7000-8000-0000000003${String(i).padStart(2, '0')}`, created_at: `2026-11-${String(10 - (i % 9)).padStart(2, '0')}T01:15:00.000Z`, period: { ...PERIOD, label_ad: `Period ${i + 1} AD`, label_bs: `Period ${i + 1} BS` } }));

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetApi(MANAGE);
  routes[`GET ${S}`] = json({ data: [scheduleDto()], page: { limit: 20 } });
  routes[`GET ${ONE}`] = json(detail());
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const posts = () => callsTo('POST', S);
const puts = () => callsTo('PUT', ONE);
const nameBox = () => screen.getByRole('textbox', { name: /^name/i }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: /^(save|create)/i });
const checks = () => screen.getAllByRole('checkbox').filter((c) => !/combine|all centres/i.test(c.getAttribute('aria-label') ?? ''));
const reportBox = (re: RegExp) => screen.getByRole('checkbox', { name: re }) as HTMLInputElement;
async function fill(name = 'Daily MIS') {
  await userEvent.clear(nameBox());
  await userEvent.type(nameBox(), name);
  // The real ShellSession has no membership id yet (CR AN-T20), so the creator default chip is absent. Tests that are not about that default
  // pick the owner explicitly so they stay independent of it; once the CR lands the chip is already there and nothing is added.
  if (!screen.queryByRole('button', { name: /remove.*synthetic owner/i })) {
    await userEvent.type(screen.getByRole('combobox', { name: /recipients/i }), 'Synthetic Owner');
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic Owner/ }));
  }
}

describe('access (US-18; E1-style)', () => {
  it.each([[LIST_PAGE, {}], [NEW_PAGE, {}], [EDIT_PAGE, { schedule_id: SCHED_ID }]])('%s without analytics.schedule.manage: notFound() and NO API call', async (page, params) => {
    resetApi(['analytics.dashboard.read', 'analytics.data.export']);
    expect(await showOrThrown(page, { params })).toMatch(/NEXT_NOT_FOUND/);
    expect(calls).toHaveLength(0);
  });

  it('edit page: API 404 -> notFound(); malformed id makes no API call', async () => {
    routes[`GET ${ONE}`] = () => problem('common.not_found', 404);
    expect(await showOrThrown(EDIT_PAGE, { params: { schedule_id: SCHED_ID } })).toMatch(/NEXT_NOT_FOUND/);
    calls.length = 0;
    expect(await showOrThrown(EDIT_PAGE, { params: { schedule_id: '../x' } })).toMatch(/NEXT_NOT_FOUND/);
    expect(calls).toHaveLength(0);
  });

  it('list: sends the Bearer token and keeps it out of the DOM; 5xx rejects', async () => {
    const { container } = await show(LIST_PAGE);
    expect(callsTo('GET', S)[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(container.innerHTML).not.toContain(TOKEN);
    cleanup();
    routes[`GET ${S}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(LIST_PAGE)).toBeTruthy();
  });
});

describe('list (§8)', () => {
  const three = [
    scheduleDto(),
    scheduleDto({ id: '01a1a98a-ac40-7000-8000-000000000041', name: 'Weekly review', report_codes: ['income'], frequency: 'weekly', weekday: 7, send_time_local: '08:00', period_rule: 'previous_7_days', recipient_membership_ids: [OWNER_M] }),
    scheduleDto({ id: '01a1a98a-ac40-7000-8000-000000000042', name: 'Month close', report_codes: ['income', 'volume'], frequency: 'monthly_bs', send_time_local: '07:00', period_rule: 'previous_bs_month', is_active: false }),
  ];
  beforeEach(() => { routes[`GET ${S}`] = json({ data: three, page: { limit: 20 } }); });

  it('columns and per-row texts: name, report count + first two names, frequency, period, recipients, next send, status', async () => {
    await show(LIST_PAGE);
    const g = gridNamed(/schedule/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Name', 'Reports', 'Frequency', 'Period', 'Recipients', 'Next send', 'Status']));
    const [daily, weekly, monthly] = rowTexts(g);
    expect(daily).toContain('Daily MIS');
    expect(daily).toContain('3');
    expect(daily).toContain('Dashboard');
    expect(daily).toContain('Income');
    expect(daily).not.toContain('Volume'); // only the first two names
    expect(daily).toContain('Daily at 07:00');
    expect(daily).toContain('Previous day');
    expect(daily).toContain('Active');
    expect(daily).toContain('07:00'); // next_run_at 01:15Z = 07:00 Nepal time
    expect(weekly).toContain('Weekly on Sunday at 08:00'); // ISO weekday 7
    expect(weekly).toContain('Previous 7 days');
    expect(monthly).toContain('Monthly (B.S.) on day 1 at 07:00');
    expect(monthly).toContain('Previous B.S. month');
    expect(monthly).toContain('Inactive');
  });

  it('Edit links to /analytics/schedules/<id>; Deactivate exists only on active rows; New schedule links to /analytics/schedules/new', async () => {
    await show(LIST_PAGE);
    const rows = within(gridNamed(/schedule/i)).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByRole('link', { name: /edit/i }).getAttribute('href')).toBe(`/analytics/schedules/${SCHED_ID}`);
    expect(within(rows[0]!).getByRole('button', { name: /deactivate/i })).toBeTruthy();
    expect(within(rows[2]!).queryByRole('button', { name: /deactivate/i })).toBeNull();
    expect(screen.getByRole('link', { name: /new schedule|add schedule|create schedule/i }).getAttribute('href')).toBe('/analytics/schedules/new');
  });

  it('Deactivate -> ConfirmDialog "Stop sending this report?" -> POST …/deactivate with If-Match "<version>" and {} -> refresh', async () => {
    routes[`POST ${ONE}/deactivate`] = json(scheduleDto({ is_active: false, version: 4 }));
    await show(LIST_PAGE);
    await userEvent.click(within(within(gridNamed(/schedule/i)).getAllByRole('row')[1]!).getByRole('button', { name: /deactivate/i }));
    const d = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(d.textContent).toContain('Stop sending this report?');
    expect(callsTo('POST', `${ONE}/deactivate`)).toHaveLength(0); // nothing before confirming
    await userEvent.click(within(d).getAllByRole('button').find((b) => !/cancel/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(callsTo('POST', `${ONE}/deactivate`)).toHaveLength(1));
    const c = callsTo('POST', `${ONE}/deactivate`)[0]!;
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(bodyOf(c)).toEqual({});
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('Cancel in the ConfirmDialog sends nothing', async () => {
    await show(LIST_PAGE);
    await userEvent.click(within(within(gridNamed(/schedule/i)).getAllByRole('row')[1]!).getByRole('button', { name: /deactivate/i }));
    const d = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(d).getByRole('button', { name: /cancel/i }));
    expect(callsTo('POST', `${ONE}/deactivate`)).toHaveLength(0);
  });

  it('Deactivate 409 common.version_conflict: an alert (changed by someone else), no refresh-as-success', async () => {
    routes[`POST ${ONE}/deactivate`] = () => problem('common.version_conflict', 409);
    await show(LIST_PAGE);
    await userEvent.click(within(within(gridNamed(/schedule/i)).getAllByRole('row')[1]!).getByRole('button', { name: /deactivate/i }));
    const d = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(d).getAllByRole('button').find((b) => !/cancel/i.test(b.textContent ?? ''))!);
    expect((await screen.findAllByRole('alert')).map((a) => norm(a.textContent)).join(' ')).toMatch(/changed|conflict|reload|latest/i);
  });

  it('empty list: EmptyState and the New schedule link still present; a11y clean', async () => {
    routes[`GET ${S}`] = json({ data: [], page: { limit: 20 } });
    await show(LIST_PAGE);
    expect(screen.getByRole('link', { name: /new schedule|add schedule|create schedule/i })).toBeTruthy();
    await axeClean();
    cleanup();
    routes[`GET ${S}`] = json({ data: three, page: { limit: 20 } });
    await show(LIST_PAGE);
    await axeClean();
  });
});

describe('editor — fields and defaults (§8)', () => {
  it('new: defaults Dashboard + Income, Daily, no Weekday control, empty name, link-only note, creator as recipient', async () => {
    await show(NEW_PAGE);
    expect(nameBox().value).toBe('');
    expect(nameBox().maxLength).toBe(80);
    expect(reportBox(/dashboard/i).checked).toBe(true);
    expect(reportBox(/^income/i).checked).toBe(true);
    expect(checks().filter((c) => (c as HTMLInputElement).checked)).toHaveLength(2);
    expect((screen.getByRole('radio', { name: /^daily$/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText(/weekday/i)).toBeNull();
    expect(pageText()).toContain('Recipients get an email with a link only. They must sign in to see the figures.');
    expect(pageText()).toContain('Synthetic Owner'); // default recipient chip = the creator
    expect(pageText()).toContain('07:00');
    expect(pageText()).toContain('Previous day');
    await axeClean();
  });

  it('Weekly shows the Weekday control (default Sunday); Monthly hides it again', async () => {
    await show(NEW_PAGE);
    await userEvent.click(screen.getByRole('radio', { name: /weekly/i }));
    expect(screen.getByLabelText(/weekday/i)).toBeTruthy();
    expect(pageText()).toContain('Sunday');
    await userEvent.click(screen.getByRole('radio', { name: /monthly \(b\.s\.\)/i }));
    expect(screen.queryByLabelText(/weekday/i)).toBeNull();
  });

  it('report choices are limited to what the user may read (no Collections / Referral without their permissions)', async () => {
    await show(NEW_PAGE);
    expect(screen.queryByRole('checkbox', { name: /collections/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /referral/i })).toBeNull();
    cleanup();
    resetApi([...MANAGE, 'analytics.collections.read', 'analytics.referral_report.read']);
    await show(NEW_PAGE);
    expect(screen.getByRole('checkbox', { name: /collections/i })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /referral/i })).toBeTruthy();
  });

  it('never offers more than 10 reports: after ticking everything the request carries ≤ 10 codes (or none is sent)', async () => {
    resetApi([...MANAGE, 'analytics.collections.read', 'analytics.referral_report.read']);
    routes[`POST ${S}`] = json(scheduleDto(), 201);
    await show(NEW_PAGE);
    await fill();
    for (const c of checks()) if (!(c as HTMLInputElement).checked && !(c as HTMLInputElement).disabled) await userEvent.click(c);
    await userEvent.click(save());
    await new Promise((r) => setTimeout(r, 200));
    for (const p of posts()) expect(bodyOf(p).report_codes.length).toBeLessThanOrEqual(10);
  });

  it('edit: prefills name, ticked reports, frequency/weekday, recipients by display name and the run log (≤ 20 rows)', async () => {
    routes[`GET ${ONE}`] = json(detail({ name: 'Weekly review', report_codes: ['income', 'volume'], frequency: 'weekly', weekday: 1, send_time_local: '08:30', period_rule: 'previous_7_days', recipient_membership_ids: [OWNER_M, MEMBER_2], runs: runs(25).slice(0, 20) }));
    await show(EDIT_PAGE, { params: { schedule_id: SCHED_ID } });
    expect(nameBox().value).toBe('Weekly review');
    expect(reportBox(/^income/i).checked).toBe(true);
    expect(reportBox(/volume/i).checked).toBe(true);
    expect(reportBox(/dashboard/i).checked).toBe(false);
    expect((screen.getByRole('radio', { name: /weekly/i }) as HTMLInputElement).checked).toBe(true);
    expect(pageText()).toContain('Monday'); // ISO weekday 1
    expect(pageText()).toContain('08:30');
    expect(pageText()).toContain('Previous 7 days');
    expect(pageText()).toContain('Synthetic Manager Two');
    const g = gridNamed(/run log/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Slot time', 'Period']));
    expect(rowTexts(g)).toHaveLength(20);
    expect(rowTexts(g)[0]).toContain('Period 1 AD');
    await axeClean();
  });

  it('edit: never shows more than 20 run-log rows even if the API sends more', async () => {
    routes[`GET ${ONE}`] = json(detail({ runs: runs(25) }));
    await show(EDIT_PAGE, { params: { schedule_id: SCHED_ID } });
    expect(rowTexts(gridNamed(/run log/i)).length).toBeLessThanOrEqual(20);
  });
});

describe('editor — validation (server rule mirrored, 08 A5.4)', () => {
  beforeEach(() => { routes[`POST ${S}`] = json(scheduleDto(), 201); });

  it.each(['mail me a@b.com', 'Call 9800000000', 'Report 1234567', 'see http://x.example', 'visit www.example.com'])('blocks the name %j with the copy and sends nothing', async (name) => {
    await show(NEW_PAGE);
    await fill(name);
    await userEvent.click(save());
    expect(pageText()).toContain(NAME_ERR);
    expect(posts()).toHaveLength(0);
  });

  it('accepts a name with up to 6 digits', async () => {
    await show(NEW_PAGE);
    await fill('Daily MIS 123456');
    await userEvent.click(save());
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it('empty name, no report ticked, or no recipient: nothing is sent', async () => {
    await show(NEW_PAGE);
    await userEvent.click(save());
    expect(posts()).toHaveLength(0);
    await fill();
    for (const c of checks()) if ((c as HTMLInputElement).checked) await userEvent.click(c);
    await userEvent.click(save());
    expect(posts()).toHaveLength(0);
    await userEvent.click(reportBox(/dashboard/i));
    await userEvent.click(screen.getByRole('button', { name: /remove.*synthetic owner/i }));
    await userEvent.click(save());
    expect(posts()).toHaveLength(0);
    expect(screen.queryAllByRole('alert').length + screen.queryAllByText(/required|at least|choose|select/i).length).toBeGreaterThan(0);
  });
});

describe('editor — create (US-18.1)', () => {
  beforeEach(() => { routes[`POST ${S}`] = json(scheduleDto(), 201); });

  it('Save posts the ScheduleInput once with an Idempotency-Key and the session token, then returns to the list', async () => {
    await show(NEW_PAGE);
    await fill('Daily MIS');
    await userEvent.click(save());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const c = posts()[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const b = bodyOf(c);
    expect(b).toMatchObject({ name: 'Daily MIS', report_codes: ['dashboard', 'income'], frequency: 'daily', send_time_local: '07:00', period_rule: 'previous_business_day', recipient_membership_ids: [OWNER_M] });
    expect(typeof b.scope.all_centres).toBe('boolean');
    expect(b).not.toHaveProperty('weekday');
    expect(Object.keys(b).sort()).toEqual(['frequency', 'name', 'period_rule', 'recipient_membership_ids', 'report_codes', 'scope', 'send_time_local']);
    await waitFor(() => expect(lastNav() ?? '').toMatch(/^\/analytics\/schedules/));
  });

  it('Weekly sends weekday 7 (Sunday, ISO); Monthly (B.S.) sends monthly_bs and no weekday', async () => {
    await show(NEW_PAGE);
    await fill();
    await userEvent.click(screen.getByRole('radio', { name: /weekly/i }));
    await userEvent.click(save());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toMatchObject({ frequency: 'weekly', weekday: 7 });
    cleanup();
    calls.length = 0;
    await show(NEW_PAGE);
    await fill();
    await userEvent.click(screen.getByRole('radio', { name: /monthly \(b\.s\.\)/i }));
    await userEvent.click(save());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toMatchObject({ frequency: 'monthly_bs' });
    expect(bodyOf(posts()[0])).not.toHaveProperty('weekday');
  });

  it('adds a recipient chosen from the filter-options recipients (membership id, display name only)', async () => {
    await show(NEW_PAGE);
    await fill();
    await userEvent.type(screen.getByRole('combobox', { name: /recipients/i }), 'Synthetic Manager');
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic Manager Two/ }));
    await userEvent.click(save());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0]).recipient_membership_ids).toEqual(expect.arrayContaining([OWNER_M, MEMBER_2]));
    expect(pageText()).not.toMatch(/@/);
  });

  it('Ctrl+Enter submits the form', async () => {
    await show(NEW_PAGE);
    await fill();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it('a double click sends ONE request (button busy while posting)', async () => {
    routes[`POST ${S}`] = async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(scheduleDto(), { status: 201 }); };
    await show(NEW_PAGE);
    await fill();
    const u = userEvent.setup();
    await u.dblClick(save());
    await new Promise((r) => setTimeout(r, 400));
    expect(posts()).toHaveLength(1);
  });

  it('422 analytics.recipient_ineligible -> "… cannot receive this report" alert; stays on the form, nothing navigates', async () => {
    routes[`POST ${S}`] = () => problem('analytics.recipient_ineligible', 422);
    await show(NEW_PAGE);
    await fill();
    await userEvent.click(save());
    expect((await screen.findAllByText(/cannot receive this report/i)).length).toBeGreaterThan(0);
    expect(lastNav()).toBeUndefined();
    expect(nameBox().value).toBe('Daily MIS');
  });

  it.each([
    ['common.idempotency_key_reused', 409],
    ['common.idempotency_in_progress', 409],
    ['common.validation_failed', 400],
    ['analytics.report_unknown', 422],
    ['common.internal', 500],
  ])('create conflict/failure %s (%i): role=alert, entered values kept, no navigation, no raw code shown', async (code, status) => {
    routes[`POST ${S}`] = () => problem(code, status, { errors: [{ path: '', code: 'common.validation_failed' }] });
    await show(NEW_PAGE);
    await fill('Keep me');
    await userEvent.click(save());
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
    expect(pageText()).not.toContain(code);
    expect(lastNav()).toBeUndefined();
    expect(nameBox().value).toBe('Keep me');
  });
});

describe('editor — edit and version conflict (US-18; task "schedule create/edit conflict")', () => {
  const open = async () => { await show(EDIT_PAGE, { params: { schedule_id: SCHED_ID } }); };

  it('Save PUTs the ScheduleInput with If-Match "<version>" (no id/version/owner fields) and returns to the list', async () => {
    routes[`PUT ${ONE}`] = json(scheduleDto({ version: 4, name: 'Daily MIS v2' }));
    await open();
    await fill('Daily MIS v2');
    await userEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const c = puts()[0]!;
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const b = bodyOf(c);
    expect(b).toMatchObject({ name: 'Daily MIS v2', report_codes: ['dashboard', 'income', 'volume'], frequency: 'daily', recipient_membership_ids: [OWNER_M, MEMBER_2] });
    for (const k of ['id', 'version', 'owner_membership_id', 'is_active', 'next_run_at', 'created_at', 'runs', 'last_run']) expect(b).not.toHaveProperty(k);
    await waitFor(() => expect(lastNav() ?? '').toMatch(/^\/analytics\/schedules/));
  });

  it('409 common.version_conflict: a "changed by someone else" alert, the user\'s edits stay in the form, no navigation, no second write', async () => {
    routes[`PUT ${ONE}`] = () => problem('common.version_conflict', 409);
    await open();
    await fill('My unsaved edit');
    await userEvent.click(save());
    const alert = (await screen.findAllByRole('alert')).map((a) => norm(a.textContent)).join(' ');
    expect(alert).toMatch(/changed|conflict|reload|latest/i);
    expect(pageText()).not.toContain('common.version_conflict');
    expect(nameBox().value).toBe('My unsaved edit');
    expect(lastNav()).toBeUndefined();
    expect(puts()).toHaveLength(1); // no silent retry that would overwrite the other person's change
  });

  it('after a conflict the user can reload the latest version (Reload -> router.refresh)', async () => {
    routes[`PUT ${ONE}`] = () => problem('common.version_conflict', 409);
    await open();
    await userEvent.click(save());
    await screen.findAllByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: /reload|refresh|latest/i }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('428 common.precondition_required is shown as a failure (never a silent success)', async () => {
    routes[`PUT ${ONE}`] = () => problem('common.precondition_required', 428);
    await open();
    await userEvent.click(save());
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(lastNav()).toBeUndefined();
  });

  it('a 404 on save (deleted meanwhile) shows an alert and does not navigate as if saved', async () => {
    routes[`PUT ${ONE}`] = () => problem('common.not_found', 404);
    await open();
    await userEvent.click(save());
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(lastNav()).toBeUndefined();
  });
});

describe('recipient names are plain text (REQ-SEC-088)', () => {
  it('a hostile display name never becomes markup', async () => {
    const H = '<img src=x onerror=alert(1)>';
    routes['GET /v1/analytics/filter-options'] = json({ ...FILTER_OPTIONS, recipients: [{ membership_id: OWNER_M, display_name: 'Synthetic Owner' }, { membership_id: MEMBER_2, display_name: H }] });
    const { container } = await show(NEW_PAGE);
    // LD-89: pick the recipient explicitly; do not rely on the creator chip (membershipId is optional on the session).
    await userEvent.type(screen.getByRole('combobox', { name: /recipients/i }), '<img');
    await userEvent.click(await screen.findByRole('option'));
    expect(container.querySelector('img')).toBeNull();
    expect(pageText()).toContain(H);
  });
});
