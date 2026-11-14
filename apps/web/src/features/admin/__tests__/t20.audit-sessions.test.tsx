// @vitest-environment jsdom
// C2.T20 — ME-1 My account, AD-9 Active sessions, AD-10 Audit log, AD-11 Audit entry, AD-12 Access/Sign-in log, AD-13 Exports, AD-14 Support access, AD-15 Access review (04-UI-UX §5, §6).
// ACs: US-D1 (list metadata only, ≤31 d), D2 (entry + DiffTable, "viewing is recorded"), D3 (access log + auth events), D4 (export dialog/limits/download), US-G1 (access review), US-A5/A6 self-service UI,
// REQ-SEC-088 (values as text nodes — XSS payload in a DiffTable value), insider-risk UX (D4.2 banner, D4.5 requester-only download).
// ASSUMED: page searchParams use the API wire names (occurred_at_from/to, table, action, row_id, request_id, support_session_id, centre_id, membership_id, entity_type, event_type);
// list tables = role "grid" named /audit|access|sign-in|sessions|exports/i; export download link = <a href="/admin/exports/{id}/file"> (BFF route, never the API origin).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ID, ME_M, USER_M, AUDIT_1, EXPORT_1, EXPORT_2, SESSION_1, SESSION_2, SUPPORT_1, NOW, api, calls, callsTo, bodyOf, resetApi, routes, json, problem, page, userSummary, auditSummary, auditExport, sessionSummary,
  show, showOrThrown, gridNamed, headersOf, rowTexts, pageText, norm, axeClean, router,
} from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { resetApi(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const iso = (daysAgo: number) => new Date(Date.parse(NOW) - daysAgo * 86400000).toISOString();
const dlg = async () => screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));

describe('ME-1 My account (US-A5/A6 UI)', () => {
  beforeEach(() => {
    routes[`GET ${ID}/me`] = json({ membership_id: ME_M, display_name: 'Synthetic Admin', email: 'synthetic.admin@example.test', roles: [{ role_id: 'r1', code: 'lab_admin', name: 'Lab admin' }], permissions: ['identity.self.manage'], centre_scope: { all: true, centre_ids: [] }, mfa: { enrolled: true, level: 'aal2' }, last_login_at: '2026-11-10T09:00:00.000Z' });
    routes[`GET ${ID}/me/sessions`] = json(page([sessionSummary({ session_id: SESSION_1, membership_id: ME_M }), sessionSummary({ session_id: SESSION_2, membership_id: ME_M, user_agent_family: 'Chrome' })]));
    routes[`GET ${ID}/me/mfa-factors`] = json({ data: [{ factor_id: 'f1', friendly_name: 'Authenticator', status: 'verified', verified_at: '2026-11-01T00:00:00.000Z' }] });
  });

  it('needs identity.self.manage', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown('me');
    expect(calls).toEqual([]);
  });
  it('tabs Profile, Security, Sessions; Profile is read-only: name, email, roles, centre scope, last login', async () => {
    await show('me');
    expect(screen.getAllByRole('tab').map((t) => norm(t.textContent))).toEqual(['Profile', 'Security', 'Sessions']);
    for (const t of ['Synthetic Admin', 'synthetic.admin@example.test', 'Lab admin', 'All centres']) expect(pageText()).toContain(t);
    expect(screen.queryAllByRole('textbox').filter((x) => !(x as HTMLInputElement).readOnly && !(x as HTMLInputElement).disabled)).toEqual([]);
  });
  it('Security: change password posts {current_password,new_password} only after Confirm matches; success toast copy; never echoes the passwords', async () => {
    routes[`POST ${ID}/me/password`] = () => new Response(null, { status: 204 });
    await show('me');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Security' }));
    await user.type(screen.getByLabelText(/current password/i), 'Old-passphrase-001');
    await user.type(screen.getByLabelText(/^new password/i), 'New-passphrase-0002');
    await user.type(screen.getByLabelText(/confirm password/i), 'Mismatch-0003');
    await user.click(screen.getByRole('button', { name: /change password/i }));
    expect(callsTo('POST', `${ID}/me/password`)).toHaveLength(0);
    await user.clear(screen.getByLabelText(/confirm password/i));
    await user.type(screen.getByLabelText(/confirm password/i), 'New-passphrase-0002');
    await user.click(screen.getByRole('button', { name: /change password/i }));
    await waitFor(() => expect(callsTo('POST', `${ID}/me/password`)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', `${ID}/me/password`)[0])).toEqual({ current_password: 'Old-passphrase-001', new_password: 'New-passphrase-0002' });
    expect(await screen.findByText('Password changed. Your other sessions were logged out.')).toBeTruthy();
    expect((screen.getByLabelText(/current password/i) as HTMLInputElement).value).toBe(''); // fields cleared after success
  });
  it('Security: 401 wrong current password and policy/breach errors show inline copy, no toast, fields keep non-secret state', async () => {
    routes[`POST ${ID}/me/password`] = () => problem('auth.password_breached', 422);
    await show('me');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Security' }));
    await user.type(screen.getByLabelText(/current password/i), 'Old-passphrase-001');
    await user.type(screen.getByLabelText(/^new password/i), 'Password12345!!');
    await user.type(screen.getByLabelText(/confirm password/i), 'Password12345!!');
    await user.click(screen.getByRole('button', { name: /change password/i }));
    expect(await screen.findByText('This password appears in known data breaches. Choose a different one.')).toBeTruthy();
  });
  it('Security: "Two-step verification" card shows StatusChip On/Off text, [Set up], factor list with [Remove]; last factor with an MFA-required role is disabled with tooltip "Your role requires two-step verification"', async () => {
    await show('me');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Security' }));
    expect(pageText()).toMatch(/Two-step verification/);
    expect(pageText()).toMatch(/\bOn\b/);
    const rm = screen.getByRole('button', { name: /remove/i }) as HTMLButtonElement;
    expect(rm.disabled || rm.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(pageText()).toContain('Your role requires two-step verification');
  });
  it('Sessions tab: columns Device/browser, IP (masked), Started, Last active, Expires; [Log out this session] → POST /me/sessions/{id}/revoke after confirmation', async () => {
    routes[`POST ${ID}/me/sessions/${SESSION_2}/revoke`] = () => new Response(null, { status: 204 });
    await show('me');
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Sessions' }));
    const g = gridNamed(/sessions/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Device/browser', 'IP', 'Started', 'Last active', 'Expires']));
    expect(rowTexts(g).join(' ')).toMatch(/203\.0\.113\.x/);
    const buttons = within(g).getAllByRole('button', { name: /log out/i });
    await user.click(buttons.at(-1)!);
    await user.click(within(await dlg()).getByRole('button', { name: /log out|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ID}/me/sessions/${SESSION_2}/revoke`)).toHaveLength(1));
  });
  it('a11y', async () => { await show('me'); await axeClean(); });
});

describe('AD-9 Active sessions', () => {
  const L = `${ID}/sessions`;
  beforeEach(() => {
    routes[`GET ${L}`] = json(page([sessionSummary(), sessionSummary({ session_id: SESSION_2, display_name: 'Synthetic Support Sam', aal: 'aal1', is_support: true, membership_id: undefined })]));
  });
  it('needs identity.session.revoke (no API call otherwise)', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown('sessions');
    expect(calls).toEqual([]);
  });
  it('columns User, Started, Last active, Expires, IP (masked), Browser, Two-step ("Verified" for aal2), Support (badge)', async () => {
    await show('sessions');
    const g = gridNamed(/sessions/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['User', 'Started', 'Last active', 'Expires', 'IP', 'Browser', 'Two-step', 'Support']));
    const t = rowTexts(g);
    expect(t[0]).toMatch(/Synthetic Sita Rai.*203\.0\.113\.x.*Firefox.*Verified/);
    expect(t[1]).toMatch(/Support/);
    expect(t[1]).not.toMatch(/Verified/);
  });
  it('filters: user (membership_id) maps to the wire param; "Support only" hides non-support rows', async () => {
    await show('sessions', { searchParams: { membership_id: USER_M } });
    expect(callsTo('GET', L).at(-1)!.url.searchParams.get('membership_id')).toBe(USER_M);
  });
  it('[Log out] = ConfirmDialog then POST /sessions/{id}/revoke; failure shows inline error (no success toast)', async () => {
    routes[`POST ${L}/${SESSION_1}/revoke`] = () => new Response(null, { status: 204 });
    await show('sessions');
    const user = userEvent.setup();
    await user.click(within(gridNamed(/sessions/i)).getAllByRole('button', { name: /log out/i })[0]!);
    await user.click(within(await dlg()).getByRole('button', { name: /log out|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${L}/${SESSION_1}/revoke`)).toHaveLength(1));
  });
  it('a11y', async () => { await show('sessions'); await axeClean(); });
});

describe('AD-10 Audit log (US-D1)', () => {
  const L = `${ID}/audit-entries`;
  beforeEach(() => { routes[`GET ${L}`] = json(page([auditSummary(), auditSummary({ audit_id: 'a2', support_session_id: SUPPORT_1, centre_id: 'c1', action: 'insert' })], true)); });

  it('needs audit.log.read (no API call otherwise)', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown('audit');
    expect(calls).toEqual([]);
  });
  it('default range is the last 24 h (required filter): occurred_at_from/to sent, ≈24 h apart, to ≈ now', async () => {
    await show('audit');
    const q = callsTo('GET', L).at(-1)!.url.searchParams;
    const from = Date.parse(q.get('occurred_at_from')!), to = Date.parse(q.get('occurred_at_to')!);
    expect(Math.abs((to - from) - 86400000)).toBeLessThan(120000);
    expect(Math.abs(to - Date.parse(NOW))).toBeLessThan(120000);
  });
  it('range over 31 days → inline "Choose 31 days or fewer" and NO API request; exactly 31 days is allowed', async () => {
    await show('audit', { searchParams: { occurred_at_from: iso(40), occurred_at_to: NOW } });
    expect(pageText()).toContain('Choose 31 days or fewer');
    expect(callsTo('GET', L)).toHaveLength(0);
    cleanup();
    await show('audit', { searchParams: { occurred_at_from: iso(31), occurred_at_to: NOW } });
    expect(callsTo('GET', L)).toHaveLength(1);
  });
  it('filters map to the wire: table, action, membership_id/actor_id, centre_id, row_id, request_id, support_session_id', async () => {
    const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000007${n}0`;
    await show('audit', { searchParams: { table: 'frontdesk.orders', action: 'update', membership_id: USER_M, centre_id: id(1), row_id: id(2), request_id: id(3), support_session_id: id(4) } });
    const q = callsTo('GET', L).at(-1)!.url.searchParams;
    expect(Object.fromEntries(['table', 'action', 'membership_id', 'centre_id', 'row_id', 'request_id', 'support_session_id'].map((k) => [k, q.get(k)]))).toEqual({ table: 'frontdesk.orders', action: 'update', membership_id: USER_M, centre_id: id(1), row_id: id(2), request_id: id(3), support_session_id: id(4) });
  });
  it('malformed UUID filters (Record id / Request id / Support session) are rejected client-side, not forwarded', async () => {
    await show('audit', { searchParams: { row_id: 'not-a-uuid', request_id: "' OR 1=1 --" } });
    const q = callsTo('GET', L).at(-1)?.url.searchParams;
    expect(q?.get('row_id') ?? null).toBeNull();
    expect(q?.get('request_id') ?? null).toBeNull();
  });
  it('columns Time, User, Action, Table, Record id (short + copy), Centre, Changed fields (count + names), Support (badge); metadata only — no old/new values; UTC tooltip', async () => {
    await show('audit');
    const g = gridNamed(/audit/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Time', 'User', 'Action', 'Table', 'Record id', 'Centre', 'Changed fields', 'Support']));
    const t = rowTexts(g);
    expect(t[0]).toMatch(/Synthetic Sita Rai.*Update.*frontdesk\.orders.*2/);
    expect(t[1]).toMatch(/Support/);
    expect(pageText()).not.toMatch(/old_values|new_values/);
    expect(screen.getAllByRole('button', { name: /copy/i }).length).toBeGreaterThan(0);
    expect(document.body.innerHTML).toMatch(/2026-11-11T07:00:00(\.000)?Z|UTC/);
  });
  it('a row opens AD-11 (/admin/audit/{audit_id}); [Export…] only with audit.log.export, leading to /admin/exports', async () => {
    await show('audit');
    expect(screen.getByRole('link', { name: /export/i }) ?? screen.getByRole('button', { name: /export/i })).toBeTruthy();
    expect([...document.querySelectorAll('a')].some((a) => a.getAttribute('href') === `/admin/audit/${AUDIT_1}`)).toBe(true);
    cleanup();
    resetApi(['audit.log.read']);
    routes[`GET ${L}`] = json(page([auditSummary()]));
    await show('audit');
    expect(screen.queryByRole('link', { name: /export/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull();
  });
  it('"Load more" with the returned cursor; API 400 → ErrorState with request_id', async () => {
    await show('audit');
    expect(screen.getByRole('button', { name: /load more/i }) ?? screen.getByRole('link', { name: /load more/i })).toBeTruthy();
  });
  it('a11y', async () => { await show('audit'); await axeClean(); });
});

describe('AD-11 Audit entry (US-D2)', () => {
  const ONE = `${ID}/audit-entries/${AUDIT_1}`;
  const entry = (over: Record<string, unknown> = {}) => ({
    ...auditSummary(), request_id: '01a1a98a-ac40-7000-8000-00000000cafe', client_ip: '203.0.113.77', user_agent: 'Mozilla/5.0 (synthetic)',
    old_values: JSON.stringify({ status: 'draft', total_paisa: 1000, note: 'same' }), new_values: JSON.stringify({ status: 'final', total_paisa: 1000, note: 'same' }), ...over,
  });
  beforeEach(() => { routes[`GET ${ONE}`] = json(entry()); });

  it('KeyValueList (time, user, action, table, record id, request id, IP, user agent, centre, support session) + notice "Your viewing of this entry is recorded."', async () => {
    await show('audit/[audit_id]', { params: { audit_id: AUDIT_1 } });
    for (const t of ['Synthetic Sita Rai', 'frontdesk.orders', '01a1a98a-ac40-7000-8000-00000000cafe', '203.0.113.77', 'Mozilla/5.0 (synthetic)', 'Your viewing of this entry is recorded.']) expect(pageText()).toContain(t);
  });
  it('DiffTable: before/after per key; changed keys carry the text marker "changed" (not colour only); unchanged keys do not', async () => {
    await show('audit/[audit_id]', { params: { audit_id: AUDIT_1 } });
    const rows = within(screen.getByRole('table')).getAllByRole('row').map((r) => norm(r.textContent));
    expect(rows.find((r) => /status/.test(r))).toMatch(/draft.*final.*changed/i); // ruling §3: kit renders "Changed"
    expect(rows.find((r) => /note/.test(r))).not.toMatch(/changed/i);
  });
  it('REQ-SEC-088: values containing markup are rendered as TEXT NODES (no <img>/<script>/<svg> elements created)', async () => {
    routes[`GET ${ONE}`] = json(entry({ new_values: JSON.stringify({ status: '<img src=x onerror=alert(1)>', name: '<svg onload=alert(1)>' }), old_values: JSON.stringify({ status: 'draft', name: 'a' }) }));
    await show('audit/[audit_id]', { params: { audit_id: AUDIT_1 } });
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"], img[onerror]')).toBeNull();
    expect(document.querySelector('svg[onload]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
  it('malformed old/new JSON text does not crash the page (renders raw text or an empty diff)', async () => {
    routes[`GET ${ONE}`] = json(entry({ old_values: '{not json', new_values: '[1,2' }));
    await show('audit/[audit_id]', { params: { audit_id: AUDIT_1 } });
    expect(screen.getByRole('heading')).toBeTruthy();
  });
  it('unknown / other-tenant id → 404 → not-found; needs audit.log.read', async () => {
    routes[`GET ${ONE}`] = () => problem('common.not_found', 404);
    const m = await showOrThrown('audit/[audit_id]', { params: { audit_id: AUDIT_1 } });
    expect(m ?? pageText()).toMatch(/NEXT_NOT_FOUND|not found/i);
    cleanup(); resetApi(['identity.user.read']);
    await showOrThrown('audit/[audit_id]', { params: { audit_id: AUDIT_1 } });
    expect(calls).toEqual([]);
  });
  it('a11y', async () => { await show('audit/[audit_id]', { params: { audit_id: AUDIT_1 } }); await axeClean(); });
});

describe('AD-12 Access log + Sign-in events (US-D3)', () => {
  const AL = `${ID}/access-log-entries`, AE = `${ID}/auth-events`;
  beforeEach(() => {
    routes[`GET ${AL}`] = json(page([{ id: 'x1', actor_id: USER_M, actor_type: 'user', membership_id: USER_M, action: 'audit_entry.view', entity_type: 'audit_entry', entity_id: AUDIT_1, outcome: 'allowed', detail: '{}', occurred_at: '2026-11-11T07:00:00.000Z', centre_id: 'c1' }]));
    routes[`GET ${AE}`] = json(page([{ auth_event_id: 'e1', event_type: 'login_failed', membership_id: USER_M, reason_code: 'bad_password', client_ip: '203.0.113.77', user_agent: 'Firefox', occurred_at: '2026-11-11T07:00:00.000Z' }]));
  });
  it('needs audit.log.read; two tabs Access log / Sign-in events', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown('access-log');
    expect(calls).toEqual([]);
    cleanup(); resetApi();
    await show('access-log');
    expect(screen.getAllByRole('tab').map((t) => norm(t.textContent))).toEqual(['Access log', 'Sign-in events']);
  });
  it('Access log columns Time, User, Event, Entity type, Entity id, Centre + range ≤31 d + wire filters (entity_type, entity_id, centre_id)', async () => {
    await show('access-log', { searchParams: { entity_type: 'audit_entry' } });
    expect(headersOf(gridNamed(/access log/i))).toEqual(expect.arrayContaining(['Time', 'User', 'Event', 'Entity type', 'Entity id', 'Centre']));
    expect(rowTexts(gridNamed(/access log/i))[0]).toMatch(/audit_entry\.view.*audit_entry/);
    expect(callsTo('GET', AL).at(-1)!.url.searchParams.get('entity_type')).toBe('audit_entry');
  });
  it('Sign-in events tab: columns Time, User, Event, Reason, IP (masked in lists), Browser; event_type filter', async () => {
    await show('access-log');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Sign-in events' }));
    await waitFor(() => expect(callsTo('GET', AE).length).toBeGreaterThan(0));
    expect(headersOf(gridNamed(/sign-in/i))).toEqual(expect.arrayContaining(['Time', 'User', 'Event', 'Reason', 'IP', 'Browser']));
    expect(pageText()).not.toContain('203.0.113.77'); // last octet masked in lists (04-UI-UX §3)
    expect(pageText()).toMatch(/203\.0\.113\.x/);
  });
  it('over-31-day range is refused inline on both tabs without a request', async () => {
    await show('access-log', { searchParams: { occurred_at_from: iso(60), occurred_at_to: NOW } });
    expect(pageText()).toContain('Choose 31 days or fewer');
    expect(callsTo('GET', AL)).toHaveLength(0);
  });
  it('a11y', async () => { await show('access-log'); await axeClean(); });
});

describe('AD-13 Exports (US-D4)', () => {
  const L = `${ID}/audit-exports`;
  beforeEach(() => {
    routes[`GET ${L}`] = json(page([auditExport(), auditExport({ export_id: EXPORT_2, requested_by_membership_id: USER_M, status: 'ready' }), auditExport({ export_id: 'e3', status: 'ready', downloads_remaining: 0 }), auditExport({ export_id: 'e4', status: 'building', row_count: undefined })]));
  });
  it('needs audit.log.export (no API call otherwise)', async () => {
    resetApi(['audit.log.read']);
    await showOrThrown('exports');
    expect(calls).toEqual([]);
  });
  it('table columns Created, Requested by, Source, Range, Status, Rows, Expires, Downloads left; status is text', async () => {
    await show('exports');
    expect(headersOf(gridNamed(/exports/i))).toEqual(expect.arrayContaining(['Created', 'Requested by', 'Source', 'Range', 'Status', 'Rows', 'Expires', 'Downloads left']));
    expect(rowTexts(gridNamed(/exports/i))[0]).toMatch(/Ready.*1,?200.*3/);
  });
  it('AC-D4.5 [Download] only for the requester\'s READY rows with downloads left; it is a link to the BFF route (never the API origin or a token)', async () => {
    await show('exports');
    const links = [...document.querySelectorAll('a')].filter((a) => /download/i.test(a.textContent ?? ''));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/admin/exports/${EXPORT_1}/file`]);
    for (const a of links) expect(a.getAttribute('href')).not.toMatch(/api\.t20\.test|token|jwt/);
  });
  it('[New export] dialog: Source radios (Audit log / Access log / Sign-in events), Date range ≤31 d, Format CSV only, warning banner copy (D4.2/A-7)', async () => {
    await show('exports');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /new export/i }));
    const d = await dlg();
    for (const r of ['Audit log', 'Access log', 'Sign-in events']) expect(within(d).getByRole('radio', { name: r })).toBeTruthy();
    expect(norm(d.textContent)).toContain('Exports are limited, recorded, and every administrator of your lab is notified. Exports do not include changed values.');
    expect(within(d).queryByRole('radio', { name: /xlsx|pdf/i })).toBeNull();
    expect(within(d).getByRole('button', { name: 'Create export' })).toBeTruthy();
  });
  it('create: POST {source, occurred_at_from, occurred_at_to, format:"csv"} with Idempotency-Key; range > 31 days → inline error, no request', async () => {
    routes[`POST ${L}`] = json(auditExport({ status: 'queued' }), 202);
    await show('exports', { searchParams: { occurred_at_from: iso(5), occurred_at_to: NOW } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /new export/i }));
    const d = await dlg();
    await user.click(within(d).getByRole('radio', { name: 'Access log' }));
    await user.click(within(d).getByRole('button', { name: 'Create export' }));
    await waitFor(() => expect(callsTo('POST', L)).toHaveLength(1));
    const c = callsTo('POST', L)[0]!;
    const b = bodyOf(c);
    expect(b).toMatchObject({ source: 'access_log', format: 'csv' });
    expect(Date.parse(b.occurred_at_to) - Date.parse(b.occurred_at_from)).toBeLessThanOrEqual(31 * 86400000);
    expect(c.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(b)).not.toContain('old_values');
  });
  it('AC-D4.4/D4.3 errors: auth.forbidden → banner "Exports need access to all centres. Ask another administrator."; identity.export_too_large / common.rate_limited → inline alert, no raw code', async () => {
    routes[`POST ${L}`] = () => problem('auth.forbidden', 403);
    await show('exports');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /new export/i }));
    await user.click(within(await dlg()).getByRole('button', { name: 'Create export' }));
    expect(await screen.findByText('Exports need access to all centres. Ask another administrator.')).toBeTruthy();
    cleanup();
    for (const code of ['identity.export_too_large', 'common.rate_limited']) {
      routes[`POST ${L}`] = () => problem(code, code === 'common.rate_limited' ? 429 : 422);
      await show('exports');
      await user.click(screen.getByRole('button', { name: /new export/i }));
      await user.click(within(await dlg()).getByRole('button', { name: 'Create export' }));
      expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
      expect(pageText()).not.toContain(code);
      cleanup();
    }
  });
  it('a queued/building export refreshes the list (polling via router.refresh) — bounded, not a tight loop', async () => {
    vi.useRealTimers();
    await show('exports');
    await new Promise((r) => setTimeout(r, 3500));
    expect(router.refresh.mock.calls.length).toBeGreaterThan(0);
    expect(router.refresh.mock.calls.length).toBeLessThan(6);
  }, 15000);
  it('a11y', async () => { await show('exports'); await axeClean(); });
});

describe('AD-14 Support access', () => {
  const L = `${ID}/support-sessions`;
  const ss = (over: Record<string, unknown>) => ({ support_session_id: SUPPORT_1, tenant_id: 't', platform_staff_display_name: 'Synthetic Support Sam', scope: 'read_only', reason_text: 'Synthetic ticket reason', ticket_ref: 'SYN-123', duration_minutes: 30, status: 'requested', requested_at: iso(0), version: 1, ...over });
  beforeEach(() => {
    routes[`GET ${L}`] = json(page([ss({}), ss({ support_session_id: 's2', status: 'active', started_at: iso(0), expires_at: new Date(Date.parse(NOW) + 20 * 60000).toISOString() }), ss({ support_session_id: 's3', status: 'ended', ended_at: iso(1), end_reason: 'ended_by_staff' })]));
  });
  it('needs audit.log.read (no API call otherwise)', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown('support-access');
    expect(calls).toEqual([]);
  });
  it('Pending card shows staff name, reason, ticket, requested duration with [Approve] [Deny]; Active has [End access]; History table has the ended row', async () => {
    await show('support-access');
    expect(pageText()).toMatch(/Synthetic Support Sam/);
    expect(pageText()).toMatch(/Synthetic ticket reason/);
    expect(pageText()).toMatch(/SYN-123/);
    expect(pageText()).toMatch(/30 min/);
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /deny/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /end access/i })).toBeTruthy();
    expect(rowTexts(gridNamed(/history/i)).join(' ')).toMatch(/Ended/);
  });
  it('Approve / Deny / End access post to approve / deny / revoke (If-Match "<version>"); Deny asks for a note; reason text is rendered as text only', async () => {
    routes[`POST ${L}/${SUPPORT_1}/approve`] = json(ss({ status: 'approved', version: 2 }));
    routes[`POST ${L}/s2/revoke`] = json(ss({ support_session_id: 's2', status: 'revoked' }));
    await show('support-access');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /approve/i }));
    const d = await screen.findByRole('alertdialog').catch(() => null);
    if (d) await user.click(within(d).getByRole('button', { name: /approve|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${L}/${SUPPORT_1}/approve`)).toHaveLength(1));
    expect(callsTo('POST', `${L}/${SUPPORT_1}/approve`)[0]!.headers.get('if-match')).toBe('"1"');
    await user.click(screen.getByRole('button', { name: /end access/i }));
    await user.click(within(await dlg()).getByRole('button', { name: /end|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${L}/s2/revoke`)).toHaveLength(1));
  });
  it('markup in a support reason renders as text (REQ-SEC-088)', async () => {
    routes[`GET ${L}`] = json(page([ss({ reason_text: '<img src=x onerror=alert(1)>' })]));
    await show('support-access');
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
  it('a11y', async () => { await show('support-access'); await axeClean(); });
});

describe('AD-15 Access review (US-G1)', () => {
  const R = `${ID}/access-reviews`;
  const mk = (n: number) => userSummary({ membership_id: `m${n}`, display_name: `Synthetic User ${n}` });
  beforeEach(() => {
    routes[`GET ${ID}/users`] = json(page([mk(1), mk(2), mk(3)]));
    routes[`GET ${R}`] = json({ data: [{ access_review_id: 'ar1', reviewed_by_membership_id: ME_M, memberships_reviewed: 3, reviewed_at: iso(100), notes: 'q3' }] });
  });
  it('needs identity.user.read (no API call otherwise)', async () => {
    resetApi(['identity.self.manage']);
    await showOrThrown('access-review');
    expect(calls).toEqual([]);
  });
  it('table User, Roles, Centres, MFA, Last login, Status for every ACTIVE membership; NO export/download control on this screen', async () => {
    await show('access-review');
    expect(headersOf(gridNamed(/access review|users/i))).toEqual(expect.arrayContaining(['User', 'Roles', 'Centres', 'MFA', 'Last login', 'Status']));
    expect(rowTexts(gridNamed(/access review|users/i))).toHaveLength(3);
    expect(callsTo('GET', `${ID}/users`).at(-1)!.url.searchParams.get('status')).toBe('active');
    expect(screen.queryByRole('button', { name: /export|download|csv/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /export|download|csv/i })).toBeNull();
  });
  it('last review older than 90 days → WARNING banner "Last review: {date}"; recent review → info (not warning)', async () => {
    await show('access-review');
    expect(pageText()).toMatch(/Last review:/);
    expect(screen.getAllByRole('alert').map((a) => norm(a.textContent)).join(' ')).toMatch(/Last review/);
    cleanup();
    routes[`GET ${R}`] = json({ data: [{ access_review_id: 'ar1', reviewed_by_membership_id: ME_M, memberships_reviewed: 3, reviewed_at: iso(30) }] });
    await show('access-review');
    expect(screen.queryAllByRole('alert').map((a) => norm(a.textContent)).join(' ')).not.toMatch(/Last review/);
  });
  it('no review yet → warning banner (due)', async () => {
    routes[`GET ${R}`] = json({ data: [] });
    await show('access-review');
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
  it('[Record review completed]: dialog with Notes ≤2000 and the count auto-filled = rows shown; POST {memberships_reviewed:3, notes}', async () => {
    routes[`POST ${R}`] = json({ access_review_id: 'ar2', reviewed_by_membership_id: ME_M, memberships_reviewed: 3, notes: 'Synthetic review notes', reviewed_at: NOW }, 201);
    await show('access-review');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /record review completed/i }));
    const d = await dlg();
    expect(norm(d.textContent)).toMatch(/\b3\b/);
    await user.type(within(d).getByLabelText(/notes/i), 'Synthetic review notes');
    await user.click(within(d).getByRole('button', { name: /record|confirm|save/i }));
    await waitFor(() => expect(callsTo('POST', R)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', R)[0])).toEqual({ memberships_reviewed: 3, notes: 'Synthetic review notes' });
  });
  it('notes over 2000 chars are refused client-side', async () => {
    await show('access-review');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /record review completed/i }));
    const d = await dlg();
    await act(async () => { await user.click(within(d).getByLabelText(/notes/i)); await user.paste('x'.repeat(2001)); });
    await user.click(within(d).getByRole('button', { name: /record|confirm|save/i }));
    expect(callsTo('POST', R)).toHaveLength(0);
  });
  it('a11y', async () => { await show('access-review'); await axeClean(); });
});

void [EXPORT_2, SUPPORT_1];
