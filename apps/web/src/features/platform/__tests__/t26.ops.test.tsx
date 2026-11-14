// @vitest-environment jsdom
// C2.T26 — PL-4 IRD Annex tracker, PL-5 Support sessions, PL-6 Dead letters, PL-7 Platform staff, PL-8 Sign-in events
// (04-UI-UX §7; AC-E3.1..E3.5, AC-E4.1/E4.4/E4.6 UI side, US-E5, AC-E6 UI side, 03-APP-FLOW §2.4/§2.5, 07-SECURITY E-6, P-7).
// ASSUMED contract (same conventions as t26.tenants.test.tsx header, plus):
//   * searchParams use the API parameter names (state, platform_rows, tenant_id, task_identifier, dead_at_from/to, occurred_at_from/to, event_type).
//   * PL-4 matrix = kit DataTable named /ird/i, columns Tenant · Annex 1 · Annex 2 · Annex 3 · Annex 7; each cell is a button whose accessible name contains the tenant code, the annex
//     label and the status text; the Annex 1 cell shows the platform record (no tenant_id) for every tenant. Click opens a record panel (role=dialog or complementary).
//   * PL-5/PL-6/PL-7 dialogs are role=dialog; fields are found by label text given in each test.
//   * Spec gaps recorded in .orchestra/notes/C2.T26-tests.md (no contract list for IRD documents; no MFA column source; "No tenant" filter has no API param) — not asserted.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  AN_2, DL_1, P, SESS_1, STAFF_1, SUPER, SUPPORT, T_ALPHA, T_BETA, T_GAMMA, annex, api, apiCalls, authEvent, axeClean, bodyOf, callsTo, deadLetter, dialog, gridNamed, headersOf,
  page, pageText, problem, resetApi, router, routes, rowTexts, show, showOrThrown, staffDto, supportSession, tenantDto,
} from './t26.harness';

vi.mock('next/navigation', async () => (await import('./t26.harness')).navigationMock);
vi.mock('next/cache', async () => (await import('./t26.harness')).cacheMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t26.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(SUPER));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const TENANTS = [tenantDto(T_ALPHA, 'alpha', 'active'), tenantDto(T_BETA, 'beta', 'active'), tenantDto(T_GAMMA, 'gamma', 'provisioning')];
const refused = (msg: string | undefined) => msg === undefined ? /no access|don.t have access|platform access only|not allowed|permission/i.test(pageText()) : true;
const reloaded = () => router.refresh.mock.calls.length + router.push.mock.calls.length + router.replace.mock.calls.length > 0;
const RELOAD_COPY = 'This record was changed by someone else. Reload to see the latest version.';

// ============================================================================ PL-4
describe('PL-4 IRD Annex tracker (AC-E3.1..E3.5)', () => {
  const ANN = `${P}/ird-annexes`;
  const RECORDS = [
    annex(1, T_ALPHA, 'annex_2', 'completed', { reference_no: 'REF-A2', completed_on: '2026-10-20', submitted_on: '2026-10-10' }),
    annex(2, T_ALPHA, 'annex_3', 'submitted', { submitted_on: '2026-11-01', version: 4 }),
    annex(3, T_ALPHA, 'annex_7', 'not_started'),
    annex(4, T_BETA, 'annex_2', 'in_preparation', { version: 7 }), annex(5, T_BETA, 'annex_3', 'not_started'), annex(6, T_BETA, 'annex_7', 'rejected'),
    annex(7, undefined, 'annex_1', 'completed', { software_version: '1.0.0' }),
  ];
  beforeEach(() => {
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${ANN}`] = () => HttpResponse.json({ data: RECORDS });
  });
  const cell = (tenant: string, annexLabel: string) => screen.getByRole('button', { name: new RegExp(`${tenant}.*${annexLabel}`, 'i') });
  const panel = () => screen.queryByRole('dialog') ?? screen.getByRole('complementary');

  it('matrix: a row per tenant, columns Annex 1 (platform), 2, 3, 7, each cell a status text chip; persistent B6 tracking-only banner (AC-E3.5)', async () => {
    await show('ird/page');
    const g = gridNamed(/ird/i);
    expect(headersOf(g).join('|')).toMatch(/Annex 1.*Annex 2.*Annex 3.*Annex 7/);
    const rows = rowTexts(g);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/alpha.*Completed.*Completed.*Submitted.*Not started/i);
    expect(rows[1]).toMatch(/beta.*Completed.*In preparation.*Not started.*Rejected/i);
    expect(pageText()).toContain('Tracking only. IRD checklist and Annex 7 template are pending IRD clarification (B6).');
    await axeClean();
  });

  it('refuses without platform.tenant.read; support staff can read but gets no transition/upload controls', async () => {
    resetApi([]);
    expect(refused(await showOrThrown('ird/page'))).toBe(true);
    expect(apiCalls()).toBe(0);
    cleanup(); resetApi(SUPPORT);
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${ANN}`] = () => HttpResponse.json({ data: RECORDS });
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 3'));
    expect(within(panel()).queryByRole('button', { name: /^(mark|move|transition|submitted|completed|in preparation)/i })).toBeNull();
    expect(within(panel()).queryByLabelText(/upload|document/i)).toBeNull();
  });

  it('record panel shows status, the field set for that annex, and only the transitions legal from that status (IR2..IR8)', async () => {
    await show('ird/page');
    await userEvent.click(cell('beta', 'Annex 2'));
    const p = panel();
    expect(within(p).getByLabelText(/reference no/i)).toBeTruthy();
    expect((within(p).getByLabelText(/reference no/i) as HTMLInputElement).maxLength).toBe(100);
    expect((within(p).getByLabelText(/tax office/i) as HTMLInputElement).maxLength).toBe(200);
    expect((within(p).getByLabelText(/notes/i) as HTMLTextAreaElement).maxLength).toBe(2000);
    expect(within(p).queryByLabelText(/counterparty/i)).toBeNull(); // Annex 7 only
    expect(within(p).queryByLabelText(/software version/i)).toBeNull(); // Annex 1 only
    // in_preparation → submitted or not_started only
    expect(within(p).queryByRole('button', { name: /submitted/i })).not.toBeNull();
    expect(within(p).queryByRole('button', { name: /^(mark )?completed/i })).toBeNull();
    cleanup();
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 7'));
    const q = panel();
    expect(within(q).getByLabelText(/counterparty/i)).toBeTruthy();
    expect((within(q).getByLabelText(/counterparty/i) as HTMLInputElement).maxLength).toBe(200);
    // not_started → in_preparation only (AC-E3.3: never straight to completed)
    expect(within(q).queryByRole('button', { name: /in preparation/i })).not.toBeNull();
    for (const n of [/submitted/i, /^(mark )?completed/i]) expect(within(q).queryByRole('button', { name: n })).toBeNull();
  });

  it('Annex 1 panel shows Software version (≤40) and no tax-office/counterparty field', async () => {
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 1'));
    expect((within(panel()).getByLabelText(/software version/i) as HTMLInputElement).maxLength).toBe(40);
    expect(within(panel()).queryByLabelText(/counterparty/i)).toBeNull();
  });

  it('→ submitted without "Submitted on" is blocked client-side (AC-E3.1); with it → POST /transition {to_status, submitted_on} with If-Match "<version>"', async () => {
    routes[`POST ${ANN}/${annex(4, T_BETA, 'annex_2', 'x').record_id}/transition`] = () => HttpResponse.json({ ...RECORDS[3], status: 'submitted', version: 8 });
    const url = `${ANN}/${RECORDS[3]!.record_id}/transition`;
    await show('ird/page');
    await userEvent.click(cell('beta', 'Annex 2'));
    const p = panel();
    await userEvent.click(within(p).getByRole('button', { name: /submitted/i }));
    expect(callsTo('POST', url)).toHaveLength(0);
    await userEvent.type(within(p).getByLabelText(/submitted on/i), '2026-11-10');
    await userEvent.click(within(p).getByRole('button', { name: /submitted/i }));
    await waitFor(() => expect(callsTo('POST', url)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', url)[0])).toMatchObject({ to_status: 'submitted', submitted_on: '2026-11-10' });
    expect(callsTo('POST', url)[0]!.headers.get('if-match')).toBe('"7"');
  });

  it('submitted → completed needs Reference no. and Completed on (AC-E3.2); submitted → rejected needs a note (IR5)', async () => {
    const url = `${ANN}/${RECORDS[1]!.record_id}/transition`;
    routes[`POST ${url}`] = () => HttpResponse.json({ ...RECORDS[1], status: 'completed', version: 5 });
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 3'));
    const p = panel();
    await userEvent.click(within(p).getByRole('button', { name: /^(mark )?completed/i }));
    expect(callsTo('POST', url)).toHaveLength(0);
    await userEvent.type(within(p).getByLabelText(/reference no/i), 'IRD-2026-0042');
    await userEvent.type(within(p).getByLabelText(/completed on/i), '2026-11-05');
    await userEvent.click(within(p).getByRole('button', { name: /^(mark )?completed/i }));
    await waitFor(() => expect(callsTo('POST', url)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', url)[0])).toMatchObject({ to_status: 'completed', reference_no: 'IRD-2026-0042', completed_on: '2026-11-05' });
  });

  it('submitted → rejected needs a note (IR5): empty note → no request; with note → POST {to_status:"rejected", note}', async () => {
    const url = `${ANN}/${RECORDS[1]!.record_id}/transition`;
    routes[`POST ${url}`] = () => HttpResponse.json({ ...RECORDS[1], status: 'rejected', version: 5 });
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 3'));
    const p = panel();
    await userEvent.click(within(p).getByRole('button', { name: /rejected/i }));
    expect(callsTo('POST', url)).toHaveLength(0);
    await userEvent.type(within(p).getByLabelText(/notes/i), 'Tax office asked for a stamped copy');
    await userEvent.click(within(p).getByRole('button', { name: /rejected/i }));
    await waitFor(() => expect(callsTo('POST', url)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', url)[0])).toMatchObject({ to_status: 'rejected', note: 'Tax office asked for a stamped copy' });
  });

  it('completed on before submitted on is rejected client-side (IR4)', async () => {
    const url = `${ANN}/${RECORDS[1]!.record_id}/transition`;
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 3'));
    const p = panel();
    await userEvent.type(within(p).getByLabelText(/reference no/i), 'IRD-2026-0042');
    await userEvent.type(within(p).getByLabelText(/completed on/i), '2026-10-01'); // submitted_on is 2026-11-01
    await userEvent.click(within(p).getByRole('button', { name: /^(mark )?completed/i }));
    expect(callsTo('POST', url)).toHaveLength(0);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('409 identity.annex_invalid_transition (stale panel) shows an inline error; the panel stays open', async () => {
    const url = `${ANN}/${RECORDS[2]!.record_id}/transition`;
    routes[`POST ${url}`] = () => problem('identity.annex_invalid_transition', 409);
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 7'));
    await userEvent.click(within(panel()).getByRole('button', { name: /in preparation/i }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(panel()).toBeTruthy();
  });

  it('409 common.version_conflict on a transition → reload dialog with the exact copy', async () => {
    const url = `${ANN}/${RECORDS[2]!.record_id}/transition`;
    routes[`POST ${url}`] = () => problem('common.version_conflict', 409);
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 7'));
    await userEvent.click(within(panel()).getByRole('button', { name: /in preparation/i }));
    await waitFor(() => expect(pageText()).toContain(RELOAD_COPY));
  });

  it('completed → superseded opens the successor record (IR7): the response\'s new record becomes the open panel / matrix cell', async () => {
    const url = `${ANN}/${RECORDS[0]!.record_id}/transition`;
    routes[`POST ${url}`] = () => HttpResponse.json({ ...RECORDS[0], status: 'superseded', version: 3 });
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 2'));
    await userEvent.click(within(panel()).getByRole('button', { name: /superseded/i }));
    const confirm = screen.queryAllByRole('dialog').at(-1);
    if (confirm && /supersede/i.test(confirm.textContent ?? '')) await userEvent.click(within(confirm).getByRole('button', { name: /supersede|confirm/i }));
    await waitFor(() => expect(bodyOf(callsTo('POST', url)[0])).toMatchObject({ to_status: 'superseded' }));
    await waitFor(() => expect(reloaded()).toBe(true));
  });

  it('upload: only PDF/PNG/JPEG ≤ 15 MB are sent (multipart, Idempotency-Key); .exe / text / 16 MB are refused client-side with no request', async () => {
    const url = `${ANN}/${RECORDS[1]!.record_id}/documents`;
    routes[`POST ${url}`] = () => HttpResponse.json({ document_id: AN_2 }, { status: 201 });
    await show('ird/page');
    await userEvent.click(cell('alpha', 'Annex 3'));
    const input = within(panel()).getByLabelText(/upload|document|file/i) as HTMLInputElement;
    expect(input.accept).toMatch(/pdf/); expect(input.accept).toMatch(/png/); expect(input.accept).toMatch(/jpe?g/);
    const u = userEvent.setup({ applyAccept: false });
    await u.upload(input, new File(['MZ'], 'run.exe', { type: 'application/x-msdownload' }));
    await u.upload(input, new File(['hello'], 'note.txt', { type: 'text/plain' }));
    await u.upload(input, new File([new Uint8Array(15 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }));
    expect(callsTo('POST', url)).toHaveLength(0);
    await u.upload(input, new File(['%PDF-1.4 synthetic'], 'approval-letter.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(callsTo('POST', url)).toHaveLength(1));
    expect(callsTo('POST', url)[0]!.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    expect(callsTo('POST', url)[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('a malformed query (tenant_id, annex_code, status) is not forwarded to the API', async () => {
    await show('ird/page', { searchParams: { tenant_id: "x' OR 1=1 --", annex_code: 'annex_9', status: '../..' } });
    for (const c of callsTo('GET', ANN)) {
      const q = c.url.searchParams;
      if (q.get('tenant_id')) expect(q.get('tenant_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      if (q.get('annex_code')) expect(q.get('annex_code')).toMatch(/^annex_[1237]$/);
      if (q.get('status')) expect(q.get('status')).toMatch(/^(not_started|in_preparation|submitted|completed|rejected|superseded)$/);
    }
  });
});

// ============================================================================ PL-5
describe('PL-5 Support sessions (AC-E4.1, AC-E4.4, AC-E4.6; 03-APP-FLOW §2.4)', () => {
  const SS = `${P}/support-sessions`;
  beforeEach(() => {
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${SS}`] = () => HttpResponse.json(page([
      supportSession(1), // active, expires far in the future
      supportSession(2, { status: 'requested', tenant_id: T_BETA, expires_at: undefined, started_at: undefined }),
      supportSession(3, { status: 'ended', ended_at: '2026-11-10T05:00:00.000Z', end_reason: 'ended_by_staff' }),
    ]));
  });

  it('active card: staff, tenant, scope, reason, ticket, a countdown, [Go to tenant admin] → /admin and [End]; requested row says it awaits tenant approval and has no Go-to button', async () => {
    await show('support-sessions/page');
    const t = pageText();
    expect(t).toContain('TCK-1001'); expect(t).toContain('Synthetic Support One');
    expect(t).toMatch(/\d+\s*(min|h|d|:)/i); // countdown / remaining
    expect(screen.getAllByRole('link', { name: /go to tenant admin/i })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /go to tenant admin/i })[0]!.getAttribute('href')).toBe('/admin');
    expect(screen.getAllByRole('button', { name: /^end/i })).toHaveLength(1);
    expect(t).toMatch(/waiting for (tenant )?approval|awaiting approval/i);
    await axeClean();
  });

  it('[End] → POST /support-sessions/{id}/end', async () => {
    routes[`POST ${SS}/${supportSession(1).support_session_id}/end`] = () => HttpResponse.json(supportSession(1, { status: 'ended' }));
    await show('support-sessions/page');
    await userEvent.click(screen.getByRole('button', { name: /^end/i }));
    const confirm = screen.queryByRole('dialog');
    if (confirm) await userEvent.click(within(confirm).getByRole('button', { name: /^end/i }));
    await waitFor(() => expect(callsTo('POST', `${SS}/${supportSession(1).support_session_id}/end`)).toHaveLength(1));
  });

  it('approved session shows [Activate] → POST /activate (SP6)', async () => {
    const s = supportSession(4, { status: 'approved', started_at: undefined, expires_at: undefined });
    routes[`GET ${SS}`] = () => HttpResponse.json(page([s]));
    routes[`POST ${SS}/${s.support_session_id}/activate`] = () => HttpResponse.json({ ...s, status: 'active' });
    await show('support-sessions/page');
    await userEvent.click(screen.getByRole('button', { name: /^activate/i }));
    await waitFor(() => expect(callsTo('POST', `${SS}/${s.support_session_id}/activate`)).toHaveLength(1));
  });

  it('Open support session dialog: Tenant select, Scope (Read only / Admin), Reason (10–500, hint "No patient details"), Ticket reference (≤60), Duration (5–60, default 30)', async () => {
    await show('support-sessions/page');
    await userEvent.click(screen.getByRole('button', { name: /open support session/i }));
    const d = dialog();
    expect(within(d).getByText(/no patient details/i)).toBeTruthy();
    expect((within(d).getByLabelText(/reason/i) as HTMLTextAreaElement).maxLength).toBe(500);
    expect((within(d).getByLabelText(/ticket reference/i) as HTMLInputElement).maxLength).toBe(60);
    const dur = within(d).getByLabelText(/duration/i) as HTMLInputElement;
    expect(dur.value).toBe('30'); expect(dur.min).toBe('5'); expect(dur.max).toBe('60');
    expect(within(d).getByRole('option', { name: /read only/i })).toBeTruthy();
    expect(within(d).getByRole('option', { name: /^admin/i })).toBeTruthy();
    expect(within(d).getByRole('option', { name: /alpha/i })).toBeTruthy();
    await axeClean();
  });

  it('valid submit → POST /support-sessions {tenant_id, scope, reason_text, ticket_ref, duration_minutes} with Idempotency-Key', async () => {
    routes[`POST ${SS}`] = () => HttpResponse.json(supportSession(5), { status: 201 });
    await show('support-sessions/page');
    await userEvent.click(screen.getByRole('button', { name: /open support session/i }));
    const d = dialog();
    await userEvent.selectOptions(within(d).getByLabelText(/^tenant/i), T_ALPHA);
    await userEvent.selectOptions(within(d).getByLabelText(/^scope/i), 'read_only');
    await userEvent.type(within(d).getByLabelText(/reason/i), 'Report stuck in review, no patient details');
    await userEvent.type(within(d).getByLabelText(/ticket reference/i), 'TCK-2002');
    await userEvent.click(within(d).getByRole('button', { name: /^open/i }));
    await waitFor(() => expect(callsTo('POST', SS)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', SS)[0])).toEqual({ tenant_id: T_ALPHA, scope: 'read_only', reason_text: 'Report stuck in review, no patient details', ticket_ref: 'TCK-2002', duration_minutes: 30 });
    expect(callsTo('POST', SS)[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it.each([
    ['reason shorter than 10', { reason: 'too short', ticket: 'TCK-1', duration: '30' }],
    ['empty ticket', { reason: 'A long enough reason here', ticket: '', duration: '30' }],
    ['duration 4', { reason: 'A long enough reason here', ticket: 'TCK-1', duration: '4' }],
    ['duration 61', { reason: 'A long enough reason here', ticket: 'TCK-1', duration: '61' }],
  ])('invalid input (%s) is blocked client-side', async (_n, v) => {
    await show('support-sessions/page');
    await userEvent.click(screen.getByRole('button', { name: /open support session/i }));
    const d = dialog();
    await userEvent.selectOptions(within(d).getByLabelText(/^tenant/i), T_ALPHA);
    await userEvent.type(within(d).getByLabelText(/reason/i), v.reason);
    if (v.ticket) await userEvent.type(within(d).getByLabelText(/ticket reference/i), v.ticket);
    const dur = within(d).getByLabelText(/duration/i);
    await userEvent.clear(dur); await userEvent.type(dur, v.duration);
    await userEvent.click(within(d).getByRole('button', { name: /^open/i }));
    expect(callsTo('POST', SS)).toHaveLength(0);
  });

  it('Admin scope is offered only to superadmin: a support-role session (no platform.tenant.manage) does not see it (07-SECURITY E-6)', async () => {
    resetApi(SUPPORT);
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${SS}`] = () => HttpResponse.json(page([]));
    await show('support-sessions/page');
    await userEvent.click(screen.getByRole('button', { name: /open support session/i }));
    expect(within(dialog()).queryByRole('option', { name: /^admin/i })).toBeNull();
    expect(within(dialog()).getByRole('option', { name: /read only/i })).toBeTruthy();
  });

  it('server refusals are shown, not swallowed: 403 auth.forbidden / 422 / 404 keep the dialog open with an alert', async () => {
    routes[`POST ${SS}`] = () => problem('auth.forbidden', 403);
    await show('support-sessions/page');
    await userEvent.click(screen.getByRole('button', { name: /open support session/i }));
    const d = dialog();
    await userEvent.selectOptions(within(d).getByLabelText(/^tenant/i), T_ALPHA);
    await userEvent.type(within(d).getByLabelText(/reason/i), 'A long enough reason here');
    await userEvent.type(within(d).getByLabelText(/ticket reference/i), 'TCK-3');
    await userEvent.click(within(d).getByRole('button', { name: /^open/i }));
    await waitFor(() => expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0));
  });

  it('no [Open support session] without platform.support_session.open; page needs platform.tenant.read', async () => {
    resetApi(['platform.tenant.read']);
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${SS}`] = () => HttpResponse.json(page([]));
    await show('support-sessions/page');
    expect(screen.queryByRole('button', { name: /open support session/i })).toBeNull();
    cleanup(); resetApi([]);
    expect(refused(await showOrThrown('support-sessions/page'))).toBe(true);
    expect(apiCalls()).toBe(0);
  });
});

// ============================================================================ PL-6
describe('PL-6 Dead letters (US-E5)', () => {
  const DL = `${P}/dead-letters`;
  beforeEach(() => {
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${DL}`] = () => HttpResponse.json(page([deadLetter(1), deadLetter(2, { tenant_id: undefined, task_identifier: 'identity.send_recovery', last_error_code: 'common.internal' })]));
  });

  it('defaults to state=open; columns Dead at, Tenant, Task, Attempts, Last error code, State; rows link to the detail', async () => {
    await show('dead-letters/page');
    expect(callsTo('GET', DL)[0]!.url.searchParams.get('state')).toBe('open');
    const g = gridNamed(/dead letters?/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Dead at', 'Tenant', 'Task', 'Attempts', 'Last error code', 'State']));
    expect(rowTexts(g)[0]).toMatch(/alpha.*identity\.gotrue_signout.*5.*common\.dependency_unavailable.*Open/i);
    expect(within(g).getAllByRole('link')[0]!.getAttribute('href')).toBe(`/platform/dead-letters/${DL_1}`);
    await axeClean();
  });

  it('filters are forwarded as state, tenant_id, task_identifier, dead_at_from/dead_at_to (URL → API)', async () => {
    await show('dead-letters/page', { searchParams: { state: 'replayed', tenant_id: T_BETA, task_identifier: 'identity.gotrue_signout', dead_at_from: '2026-11-01', dead_at_to: '2026-11-09' } });
    const q = callsTo('GET', DL)[0]!.url.searchParams;
    expect(q.get('state')).toBe('replayed'); expect(q.get('tenant_id')).toBe(T_BETA); expect(q.get('task_identifier')).toBe('identity.gotrue_signout');
    expect(q.get('dead_at_from')).toBe('2026-11-01'); expect(q.get('dead_at_to')).toBe('2026-11-09');
  });

  it('"Platform tasks only" sends platform_rows=true and clears + disables the Tenant filter; platform_rows is never sent together with tenant_id (API would 400)', async () => {
    await show('dead-letters/page', { searchParams: { platform_rows: 'true', tenant_id: T_ALPHA } });
    const q = callsTo('GET', DL)[0]!.url.searchParams;
    expect(q.get('platform_rows')).toBe('true');
    expect(q.get('tenant_id')).toBeNull();
    expect((screen.getByLabelText(/platform tasks only/i) as HTMLInputElement).checked).toBe(true);
    const tenant = screen.getByLabelText(/^tenant/i) as HTMLSelectElement | HTMLInputElement;
    expect(tenant.disabled || tenant.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('platform_rows defaults to off (box unchecked, param absent or false)', async () => {
    await show('dead-letters/page');
    expect((screen.getByLabelText(/platform tasks only/i) as HTMLInputElement).checked).toBe(false);
    expect([null, 'false']).toContain(callsTo('GET', DL)[0]!.url.searchParams.get('platform_rows'));
  });

  it('empty → "No dead letters yet"; refuses without platform.dead_letter.manage (support staff) before any call', async () => {
    routes[`GET ${DL}`] = () => HttpResponse.json(page([]));
    await show('dead-letters/page');
    expect(pageText()).toMatch(/No dead letters/i);
    cleanup(); resetApi(SUPPORT);
    expect(refused(await showOrThrown('dead-letters/page'))).toBe(true);
    expect(apiCalls()).toBe(0);
  });

  describe('detail', () => {
    const ONE = `${DL}/${DL_1}`;
    const open = async (over: Record<string, unknown> = {}) => {
      routes[`GET ${ONE}`] = () => HttpResponse.json(deadLetter(1, over));
      await show('dead-letters/[dead_letter_id]/page', { params: { dead_letter_id: DL_1 } });
    };

    it('shows task, tenant, attempts, first failed, dead at, last error code, REDACTED message, state, version-independent; never a job payload', async () => {
      await open();
      const t = pageText();
      for (const s of ['identity.gotrue_signout', 'common.dependency_unavailable', 'upstream timed out for user [redacted]', 'Open']) expect(t).toContain(s);
      expect(t).toMatch(/Attempts\s*5/);
      expect(t).not.toMatch(/payload/i);
      await axeClean();
    });

    it('open row: [Replay] and [Discard]; resolved row: neither, but the resolution note and resolved by/at are shown', async () => {
      await open();
      expect(screen.getByRole('button', { name: /^replay/i })).toBeTruthy();
      expect(screen.getByRole('button', { name: /^discard/i })).toBeTruthy();
      cleanup();
      await open({ state: 'discarded', resolved_by: STAFF_1, resolved_at: '2026-11-10T04:00:00.000Z', resolution_note: 'Poisoned job, ticket TCK-55' });
      expect(screen.queryByRole('button', { name: /^replay/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /^discard/i })).toBeNull();
      expect(pageText()).toContain('Poisoned job, ticket TCK-55');
    });

    it('Replay: optional note ≤500; empty note → body without reason_text; POST with If-Match "<version>"', async () => {
      routes[`POST ${ONE}/replay`] = () => HttpResponse.json(deadLetter(1, { state: 'replayed', version: 5 }));
      await open();
      await userEvent.click(screen.getByRole('button', { name: /^replay/i }));
      const d = dialog();
      expect((within(d).getByLabelText(/note/i) as HTMLTextAreaElement).maxLength).toBe(500);
      await userEvent.click(within(d).getByRole('button', { name: /^replay/i }));
      await waitFor(() => expect(callsTo('POST', `${ONE}/replay`)).toHaveLength(1));
      const c = callsTo('POST', `${ONE}/replay`)[0]!;
      expect(c.headers.get('if-match')).toBe('"4"');
      expect(bodyOf(c)?.reason_text ?? undefined).toBeUndefined();
    });

    it('Replay with a note sends it as reason_text', async () => {
      routes[`POST ${ONE}/replay`] = () => HttpResponse.json(deadLetter(1, { state: 'replayed', version: 5 }));
      await open();
      await userEvent.click(screen.getByRole('button', { name: /^replay/i }));
      await userEvent.type(within(dialog()).getByLabelText(/note/i), 'Upstream is back');
      await userEvent.click(within(dialog()).getByRole('button', { name: /^replay/i }));
      await waitFor(() => expect(bodyOf(callsTo('POST', `${ONE}/replay`)[0])).toEqual({ reason_text: 'Upstream is back' }));
    });

    it('Discard requires a reason (1–500): empty → no request; with reason → POST /discard {reason_text} + If-Match', async () => {
      routes[`POST ${ONE}/discard`] = () => HttpResponse.json(deadLetter(1, { state: 'discarded', version: 5 }));
      await open();
      await userEvent.click(screen.getByRole('button', { name: /^discard/i }));
      const d = dialog();
      await userEvent.click(within(d).getByRole('button', { name: /^discard/i }));
      expect(callsTo('POST', `${ONE}/discard`)).toHaveLength(0);
      expect((within(d).getByLabelText(/reason/i) as HTMLTextAreaElement).maxLength).toBe(500);
      await userEvent.type(within(d).getByLabelText(/reason/i), 'Poisoned job, ticket TCK-55');
      await userEvent.click(within(d).getByRole('button', { name: /^discard/i }));
      await waitFor(() => expect(callsTo('POST', `${ONE}/discard`)).toHaveLength(1));
      expect(bodyOf(callsTo('POST', `${ONE}/discard`)[0])).toEqual({ reason_text: 'Poisoned job, ticket TCK-55' });
      expect(callsTo('POST', `${ONE}/discard`)[0]!.headers.get('if-match')).toBe('"4"');
    });

    it('409 common.version_conflict → reload dialog with the exact copy; replay clicked twice sends once', async () => {
      let n = 0;
      routes[`POST ${ONE}/replay`] = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return problem('common.version_conflict', 409); };
      await open();
      await userEvent.click(screen.getByRole('button', { name: /^replay/i }));
      const b = within(dialog()).getByRole('button', { name: /^replay/i });
      await userEvent.dblClick(b);
      await waitFor(() => expect(pageText()).toContain(RELOAD_COPY));
      expect(n).toBe(1);
      await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
      expect(reloaded()).toBe(true);
    });

    it('404 → not-found page; malformed id never reaches the API; no access without dead_letter.manage', async () => {
      routes[`GET ${ONE}`] = () => problem('common.not_found', 404);
      await expect(show('dead-letters/[dead_letter_id]/page', { params: { dead_letter_id: DL_1 } })).rejects.toThrow(/NEXT_NOT_FOUND/);
      resetApi(SUPER);
      for (const bad of ['../tenants', 'abc', `${DL_1}/replay`]) await showOrThrown('dead-letters/[dead_letter_id]/page', { params: { dead_letter_id: bad } });
      expect(apiCalls()).toBe(0);
      resetApi(SUPPORT);
      expect(refused(await showOrThrown('dead-letters/[dead_letter_id]/page', { params: { dead_letter_id: DL_1 } }))).toBe(true);
      expect(apiCalls()).toBe(0);
    });

    it('error text from the job is rendered as text, never markup (REQ-SEC-088)', async () => {
      await open({ last_error_message_redacted: '<img src=x onerror=alert(1)><script>window.__pwned=1</script>' });
      expect(document.querySelector('img[src="x"]')).toBeNull();
      expect(document.querySelector('script')).toBeNull();
      expect(pageText()).toContain('<img src=x onerror=alert(1)>');
    });
  });
});

// ============================================================================ PL-7
describe('PL-7 Platform staff (07-SECURITY E-6, P-7; AC-E6)', () => {
  const ST = `${P}/staff`;
  beforeEach(() => {
    routes[`GET ${ST}`] = () => HttpResponse.json({ data: [staffDto(1, { role_code: 'platform_superadmin' }), staffDto(2, { is_active: false, allowed_cidrs: [] })] });
    routes[`GET ${P}/sessions`] = () => HttpResponse.json({ data: [{ session_id: SESS_1, platform_staff_id: STAFF_1, display_name: 'Synthetic Staff 1', state: 'active', aal: 'aal2', created_at: '2026-11-11T03:00:00.000Z', last_seen_at: '2026-11-11T04:00:00.000Z', idle_expires_at: '2099-01-01T00:00:00.000Z', absolute_expires_at: '2099-01-01T08:00:00.000Z', client_ip_masked: '203.0.113.x', user_agent_family: 'Firefox', is_support: false }] });
  });

  it('table Name, Email, Role, Allowed networks, MFA, Status; email masked; CIDRs shown; inactive row has a text status', async () => {
    await show('staff/page');
    const g = gridNamed(/staff/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Name', 'Email', 'Role', 'Allowed networks', 'MFA', 'Status']));
    const rows = rowTexts(g);
    expect(rows[0]).toMatch(/Synthetic Staff 1.*st\*\*\*1@example\.test.*(Superadmin|platform_superadmin).*203\.0\.113\.0\/24.*Active/i);
    expect(rows[1]).toMatch(/Inactive|Deactivated/i);
    await axeClean();
  });

  it('Sessions tab lists active platform sessions with [Log out] → POST /sessions/{id}/revoke', async () => {
    routes[`POST ${P}/sessions/${SESS_1}/revoke`] = () => new Response(null, { status: 204 });
    await show('staff/page');
    await userEvent.click(screen.getByRole('tab', { name: /sessions/i }));
    expect(await screen.findByText(/203\.0\.113\.x/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /log out/i }));
    const confirm = screen.queryByRole('dialog');
    if (confirm) await userEvent.click(within(confirm).getByRole('button', { name: /log out/i }));
    await waitFor(() => expect(callsTo('POST', `${P}/sessions/${SESS_1}/revoke`)).toHaveLength(1));
  });

  it('invite dialog: email, name, role (Superadmin/Support), allowed CIDRs as chips; valid IPv4 + IPv6 CIDRs accepted → POST /staff with Idempotency-Key', async () => {
    routes[`POST ${ST}`] = () => HttpResponse.json(staffDto(3), { status: 201 });
    await show('staff/page');
    await userEvent.click(screen.getByRole('button', { name: /invite/i }));
    const d = dialog();
    await userEvent.type(within(d).getByLabelText(/^email/i), 'new.staff@provider.example.test');
    await userEvent.type(within(d).getByLabelText(/^name|full name|display name/i), 'New Staff');
    await userEvent.selectOptions(within(d).getByLabelText(/^role/i), 'platform_support');
    const cidr = within(d).getByLabelText(/allowed (networks|cidrs?)/i);
    await userEvent.type(cidr, '203.0.113.0/24{Enter}');
    await userEvent.type(cidr, '2001:db8::/32{Enter}');
    expect(within(d).getAllByRole('button', { name: /remove/i }).length).toBe(2);
    await userEvent.click(within(d).getByRole('button', { name: /^(send )?invit/i }));
    await waitFor(() => expect(callsTo('POST', ST)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', ST)[0])).toEqual({ email: 'new.staff@provider.example.test', display_name: 'New Staff', role_code: 'platform_support', allowed_cidrs: ['203.0.113.0/24', '2001:db8::/32'] });
    expect(callsTo('POST', ST)[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it.each(['203.0.113.0', 'abc', '203.0.113.0/', '999.1.1.1/24', '203.0.113.0/33', '2001:db8::/129', '<script>/8'])('rejects the CIDR %j as a chip and never sends it', async (bad) => {
    await show('staff/page');
    await userEvent.click(screen.getByRole('button', { name: /invite/i }));
    const d = dialog();
    await userEvent.type(within(d).getByLabelText(/allowed (networks|cidrs?)/i), `${bad}{Enter}`);
    expect(within(d).queryAllByRole('button', { name: /remove/i })).toHaveLength(0);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    expect(callsTo('POST', ST)).toHaveLength(0);
  });

  it('more than 20 CIDRs are refused (maxItems 20)', async () => {
    await show('staff/page');
    await userEvent.click(screen.getByRole('button', { name: /invite/i }));
    const d = dialog();
    const cidr = within(d).getByLabelText(/allowed (networks|cidrs?)/i);
    for (let i = 0; i < 21; i++) await userEvent.type(cidr, `10.0.${i}.0/24{Enter}`);
    expect(within(d).getAllByRole('button', { name: /remove/i }).length).toBeLessThanOrEqual(20);
  });

  it('refuses without platform.staff.manage — a platform_support session (and a superadmin lacking the code) gets no staff data (07-SECURITY E-6)', async () => {
    resetApi(SUPPORT);
    expect(refused(await showOrThrown('staff/page'))).toBe(true);
    expect(apiCalls()).toBe(0);
  });

  it('403 auth.forbidden from the API on invite shows an inline alert and keeps the dialog', async () => {
    routes[`POST ${ST}`] = () => problem('auth.forbidden', 403);
    await show('staff/page');
    await userEvent.click(screen.getByRole('button', { name: /invite/i }));
    const d = dialog();
    await userEvent.type(within(d).getByLabelText(/^email/i), 'new.staff@provider.example.test');
    await userEvent.type(within(d).getByLabelText(/^name|full name|display name/i), 'New Staff');
    await userEvent.click(within(d).getByRole('button', { name: /^(send )?invit/i }));
    await waitFor(() => expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0));
  });
});

// ============================================================================ PL-8
describe('PL-8 Sign-in events (AC-E6 platform_ip_denied visibility)', () => {
  const EV = `${P}/auth-events`;
  beforeEach(() => {
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${EV}`] = () => HttpResponse.json(page([
      authEvent(1),
      authEvent(2, { tenant_id: undefined, event_type: 'login_blocked_ip', reason_code: 'identity.platform_ip_denied', client_ip: '198.51.100.23', platform_staff_id: STAFF_1 }),
    ]));
  });

  it('always sends a bounded date range (occurred_at_from/to both present, span ≤ 31 days) — the API requires both', async () => {
    await show('auth-events/page');
    const q = callsTo('GET', EV)[0]!.url.searchParams;
    const from = Date.parse(q.get('occurred_at_from') ?? ''); const to = Date.parse(q.get('occurred_at_to') ?? '');
    expect(Number.isNaN(from) || Number.isNaN(to)).toBe(false);
    expect(to - from).toBeLessThanOrEqual(31 * 86_400_000);
    expect(to).toBeGreaterThan(from);
  });

  it('a range over 31 days shows an inline error and makes no request; a valid filter set is forwarded (tenant_id, event_type)', async () => {
    await show('auth-events/page', { searchParams: { occurred_at_from: '2026-09-01T00:00:00.000Z', occurred_at_to: '2026-11-01T00:00:00.000Z' } });
    expect(callsTo('GET', EV).filter((c) => Date.parse(c.url.searchParams.get('occurred_at_to') ?? '') - Date.parse(c.url.searchParams.get('occurred_at_from') ?? '') > 31 * 86_400_000)).toHaveLength(0);
    expect(screen.getAllByRole('alert').length + (pageText().match(/31 days/i) ? 1 : 0)).toBeGreaterThan(0);
    cleanup(); resetApi(SUPER);
    routes[`GET ${P}/tenants`] = () => HttpResponse.json(page(TENANTS));
    routes[`GET ${EV}`] = () => HttpResponse.json(page([]));
    await show('auth-events/page', { searchParams: { occurred_at_from: '2026-11-01T00:00:00.000Z', occurred_at_to: '2026-11-10T00:00:00.000Z', tenant_id: T_BETA, event_type: 'login_failed' } });
    const q = callsTo('GET', EV)[0]!.url.searchParams;
    expect(q.get('tenant_id')).toBe(T_BETA); expect(q.get('event_type')).toBe('login_failed');
  });

  it('columns Time, Tenant, User, Event, Reason, IP, Browser; list IP is masked (last octet); a no-tenant event is labelled; blocked-IP event shows its reason', async () => {
    await show('auth-events/page');
    const g = gridNamed(/sign-in|auth events?/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Time', 'Tenant', 'User', 'Event', 'Reason', 'IP', 'Browser']));
    const t = pageText();
    expect(t).toContain('203.0.113.x'); expect(t).toContain('198.51.100.x');
    expect(t).not.toContain('203.0.113.77'); expect(t).not.toContain('198.51.100.23');
    expect(rowTexts(g)[1]).toMatch(/No tenant/i);
    expect(rowTexts(g)[1]).toMatch(/identity\.platform_ip_denied|not allowed from this network/i);
    expect(screen.getByRole('option', { name: /no tenant/i })).toBeTruthy(); // tenant filter offers it
    await axeClean();
  });

  it('empty → "No entries in this period"; refuses without platform.tenant.read; 503 shows ErrorState with request id', async () => {
    routes[`GET ${EV}`] = () => HttpResponse.json(page([]));
    await show('auth-events/page');
    expect(pageText()).toContain('No entries in this period');
    cleanup();
    routes[`GET ${EV}`] = () => problem('common.dependency_unavailable', 503);
    await show('auth-events/page');
    expect(pageText()).toContain('req-t26-0001');
    cleanup(); resetApi([]);
    expect(refused(await showOrThrown('auth-events/page'))).toBe(true);
    expect(apiCalls()).toBe(0);
  });

  it('user-agent and reason text render as text nodes (REQ-SEC-088)', async () => {
    routes[`GET ${EV}`] = () => HttpResponse.json(page([authEvent(3, { user_agent: '<script>window.__pwned=1</script>', reason_code: '<img src=x onerror=1>' })]));
    await show('auth-events/page');
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
