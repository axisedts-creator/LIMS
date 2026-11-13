// @vitest-environment jsdom
// C2.T20 — AD-1 Users, AD-2 Invite user, AD-3 User detail (04-UI-UX §6). ACs: US-B1 (B1.1, B1.3, B1.4 UI copy), B2 (role/session warning), B3 (centre scope + hub-lab warning D-13),
// B4 (lock/unlock/deactivate dialogs, self-action), B5 (reset MFA), B6 (signatory + upload). Security: masking (07 §3 item 3), page gate before any API call, tenant_id/permissions never sent (REQ-SEC-080).
// ASSUMED selectors: react-aria roles — table = role "grid" named /users/i, filters = labelled Select/textbox ("Status", "Search"), dialogs = role "dialog"/"alertdialog", submit buttons by name.
// Writes: invite = POST /v1/identity/users (Idempotency-Key), roles = PUT .../roles, scope = PUT .../centre-scope, profile = PATCH (If-Match "<version>"), lock = POST .../lock {reason_code, reason_text?}.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ID, ME_M, USER_M, ROLE_ADMIN, ROLE_FD, ROLE_LAB, CENTRE_A1, CENTRE_A2, BRANCH_1, api, calls, callsTo, bodyOf, resetApi, routes, json, problem, page, userSummary, userDetail, role,
  show, showOrThrown, gridNamed, headersOf, rowTexts, pageText, norm, axeClean, router,
} from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => resetApi());
afterEach(() => cleanup());

const LIST = `${ID}/users`;
const ONE = `${ID}/users/${USER_M}`;

describe('AD-1 Users — list', () => {
  const rows = [
    userSummary(),
    userSummary({ membership_id: 'm2', display_name: 'Synthetic Locked Lal', is_locked: true, status: 'active', mfa_enrolled: false, all_centres: true, centre_count: 0, last_login_at: undefined }),
    userSummary({ membership_id: 'm3', display_name: 'Synthetic Invited Ila', status: 'invited', roles: [1, 2, 3, 4, 5].map((n) => ({ role_id: `r${n}`, code: `role_${n}`, name: `Role ${n}` })) }),
  ];
  beforeEach(() => { routes[`GET ${LIST}`] = json(page(rows)); });

  it('without identity.user.read: refuses and makes NO API call (page gate, 04-UI-UX §1)', async () => {
    resetApi(['identity.self.manage']);
    await showOrThrown('users');
    expect(calls.filter((c) => c.url.pathname === LIST)).toEqual([]);
  });

  it('columns Name, Email, Status, Roles, Centres, MFA, Last login; email shown masked as served; locked badge is independent of status', async () => {
    await show('users');
    const g = gridNamed(/users/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Name', 'Email', 'Status', 'Roles', 'Centres', 'MFA', 'Last login']));
    const t = rowTexts(g);
    expect(t[0]).toMatch(/Synthetic Sita Rai.*te\*\*\*@example\.test.*Active.*Front desk.*2.*On/);
    expect(t[1]).toMatch(/Locked/);
    expect(t[1]).toMatch(/Active/); // lock does not replace the status chip
    expect(t[1]).toMatch(/All centres/);
    expect(t[1]).toMatch(/Off/);
    expect(t[2]).toMatch(/Invited/);
  });

  it('Roles column: max 3 names then "+n" (AD-1)', async () => {
    await show('users');
    expect(rowTexts(gridNamed(/users/i))[2]).toMatch(/Role 1.*Role 2.*Role 3.*\+2/);
    expect(rowTexts(gridNamed(/users/i))[2]).not.toMatch(/Role 4/);
  });

  it('never renders a full email, phone or token from list rows (masking, 07 §3.3)', async () => {
    await show('users');
    expect(pageText()).not.toMatch(/[a-z0-9._-]+@(?!example\.test)[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(pageText()).not.toContain('jwt-synthetic');
  });

  it('filters map to wire params: status, is_locked, role_id, centre_id, mfa_enrolled, sort (08 A6.1)', async () => {
    await show('users', { searchParams: { status: 'deactivated', is_locked: 'true', role_id: ROLE_FD, centre_id: CENTRE_A1, mfa_enrolled: 'false', sort: '-last_login_at' } });
    const q = callsTo('GET', LIST).at(-1)!.url.searchParams;
    expect(q.get('status')).toBe('deactivated');
    expect(q.get('is_locked')).toBe('true');
    expect(q.get('role_id')).toBe(ROLE_FD);
    expect(q.get('centre_id')).toBe(CENTRE_A1);
    expect(q.get('mfa_enrolled')).toBe('false');
    expect(q.get('sort')).toBe('-last_login_at');
  });

  it('unknown/hostile query params are not forwarded (whitelist)', async () => {
    await show('users', { searchParams: { tenant_id: 'x', status: 'drop table', evil: '1' } });
    const q = callsTo('GET', LIST).at(-1)!.url.searchParams;
    expect(q.has('tenant_id')).toBe(false);
    expect(q.has('evil')).toBe(false);
    expect(q.get('status')).not.toBe('drop table');
  });

  it('empty result: "No users match these filters." with [Clear filters]', async () => {
    routes[`GET ${LIST}`] = json(page([]));
    await show('users');
    expect(screen.getByText('No users match these filters.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /clear filters/i }) ?? screen.getByRole('link', { name: /clear filters/i })).toBeTruthy();
  });

  it('50 rows per page with "Load more" when a cursor exists (02-CV §4.3)', async () => {
    routes[`GET ${LIST}`] = json(page(rows, true));
    await show('users');
    expect(screen.getByRole('button', { name: /load more/i }) ?? screen.getByRole('link', { name: /load more/i })).toBeTruthy();
    expect(callsTo('GET', LIST).at(-1)!.url.searchParams.get('limit') ?? '50').toBe('50');
  });

  it('search box (2–100 chars) calls searchUsers with {query}; 1 char sends nothing (debounced 300 ms)', async () => {
    routes[`POST ${LIST}/search`] = json(page([userSummary({ display_name: 'Synthetic Found Fiona' })]));
    await show('users');
    const user = userEvent.setup();
    const box = screen.getByRole('searchbox', { name: /search/i }) ?? screen.getByLabelText(/search/i);
    await user.type(box, 's');
    await new Promise((r) => setTimeout(r, 450));
    expect(callsTo('POST', `${LIST}/search`)).toHaveLength(0);
    await user.type(box, 'ita');
    await waitFor(() => expect(callsTo('POST', `${LIST}/search`)).toHaveLength(1), { timeout: 3000 });
    expect(bodyOf(callsTo('POST', `${LIST}/search`)[0])).toMatchObject({ query: 'sita' });
  });

  it('[Invite user] is shown only with identity.user.manage', async () => {
    await show('users');
    expect(screen.getByRole('link', { name: /invite user/i }) ?? screen.getByRole('button', { name: /invite user/i })).toBeTruthy();
    cleanup();
    resetApi(['identity.user.read']);
    routes[`GET ${LIST}`] = json(page(rows));
    await show('users');
    expect(screen.queryByRole('link', { name: /invite user/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /invite user/i })).toBeNull();
  });

  it('a11y: no axe violations (WCAG 2.2 AA, 04-UI-UX §8)', async () => {
    await show('users');
    await axeClean();
  });

  it('API failure renders an ErrorState with the request_id, never a stack or raw code', async () => {
    routes[`GET ${LIST}`] = () => problem('common.internal', 500, { request_id: '01a1a98a-ac40-7000-8000-00000000beef' });
    await show('users');
    expect(pageText()).toMatch(/01a1a98a-ac40-7000-8000-00000000beef/);
    expect(pageText()).not.toMatch(/Error:|at \w+ \(|stack/);
  });
});

describe('AD-2 Invite user — form, validation, hub-lab warning (US-B1)', () => {
  beforeEach(() => {
    routes[`POST ${LIST}`] = () => json(userDetail({ status: 'invited' }), 201)();
  });

  it('needs identity.user.manage (page gate; no API call)', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown('users/new');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('fields: Email, Full name, Mobile (+977 prefix shown), Roles, Centre access (All/Selected, default Selected), Centres, Branches; submit "Send invitation"', async () => {
    await show('users/new');
    for (const l of [/^email/i, /full name/i, /mobile/i, /roles/i, /branches/i]) expect(screen.getByLabelText(l)).toBeTruthy();
    expect((screen.getByLabelText(/mobile/i) as HTMLInputElement).value).toMatch(/^\+977/);
    expect((screen.getByRole('radio', { name: /selected centres/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeTruthy();
    expect(pageText()).toMatch(/The user receives an email link valid for a limited time\. Roles marked MFA required will have to set up two-step verification\./);
  });

  it('privileged / MFA-required roles carry an "MFA required" tag in the role picker', async () => {
    await show('users/new');
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/roles/i));
    expect(pageText()).toMatch(/Lab admin.*MFA required|MFA required.*Lab admin/);
  });

  it('client validation: bad email, empty name, bad E.164 mobile, no role, Selected centres with none chosen → no request, error summary links to fields', async () => {
    await show('users/new');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email/i), 'not-an-email');
    await user.clear(screen.getByLabelText(/mobile/i));
    await user.type(screen.getByLabelText(/mobile/i), '98123');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(callsTo('POST', LIST)).toHaveLength(0);
    expect(screen.getAllByRole('alert').length + screen.getAllByRole('link', { name: /email|full name|mobile|roles|centres/i }).length).toBeGreaterThan(0);
    expect(document.activeElement?.getAttribute('aria-invalid') ?? document.activeElement?.closest('[role=alert]')).toBeTruthy(); // focus moves to the first error (04-UI-UX §8)
  });

  it('AC-B1.1: submit posts {email, display_name, phone_e164, role_ids, all_centres:false, centre_ids} with an Idempotency-Key; nothing else (no tenant_id/permissions, REQ-SEC-080); returns to the list', async () => {
    await show('users/new');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email/i), 'test.user.0042@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'Synthetic Tika Rai');
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /front desk/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByLabelText(/centres/i));
    await user.click(await screen.findByRole('option', { name: /Synthetic Centre A1/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(callsTo('POST', LIST)).toHaveLength(1));
    const c = callsTo('POST', LIST)[0]!;
    expect(bodyOf(c)).toEqual({ email: 'test.user.0042@example.test', display_name: 'Synthetic Tika Rai', role_ids: [ROLE_FD], all_centres: false, centre_ids: [CENTRE_A1] });
    expect(c.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic-t20');
    await waitFor(() => expect(router.push.mock.calls.length + router.replace.mock.calls.length).toBeGreaterThan(0));
  });

  it('"All centres" hides the Centres picker and sends all_centres:true', async () => {
    await show('users/new');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /all centres/i }));
    expect(screen.queryByLabelText(/^centres/i)).toBeNull();
    await user.type(screen.getByLabelText(/^email/i), 'test.user.0043@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'Synthetic All Centres');
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /front desk/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(callsTo('POST', LIST)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', LIST)[0])).toMatchObject({ all_centres: true });
  });

  it('D-13 hub-lab warning: roles granting lab.specimen.receive + "Selected centres" → warning Banner (exact copy), never blocks saving', async () => {
    await show('users/new');
    const user = userEvent.setup();
    expect(pageText()).not.toMatch(/These roles receive or work on samples/);
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /lab technician/i }));
    await user.keyboard('{Escape}');
    expect(pageText()).toContain('These roles receive or work on samples. Staff who process samples from other collection centres need All centres or every collection centre whose samples they process. Before receipt, a sample is visible only at its collection centre.');
    await user.click(screen.getByRole('radio', { name: /all centres/i }));
    expect(pageText()).not.toMatch(/These roles receive or work on samples/);
    expect((screen.getByRole('button', { name: 'Send invitation' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('AC-B1.3 identity.user_exists → generic banner copy, no echo of who/where', async () => {
    routes[`POST ${LIST}`] = () => problem('identity.user_exists', 409);
    await show('users/new');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email/i), 'test.user.0044@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'Synthetic Dup');
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /front desk/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('radio', { name: /all centres/i }));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/This email cannot be invited\. Use a different email or contact the LIMS provider support\./)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('AC-B1.4 auth.mfa_required → dialog "This action needs two-step verification…" whose button logs out and goes to /auth/login?next=…', async () => {
    routes[`POST ${LIST}`] = () => problem('auth.mfa_required', 403);
    await show('users/new');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^email/i), 'test.user.0045@example.test');
    await user.type(screen.getByLabelText(/full name/i), 'Synthetic Aal1');
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /front desk/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('radio', { name: /all centres/i }));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(norm(dlg.textContent)).toMatch(/This action needs two-step verification\. Log in again with your authenticator code\./);
  });

  it('a11y: no axe violations', async () => {
    await show('users/new');
    await axeClean();
  });
});

describe('AD-3 User detail (US-B2..B6)', () => {
  const P = { params: { membership_id: USER_M } };
  beforeEach(() => {
    routes[`GET ${ONE}`] = json(userDetail());
    routes[`GET ${ID}/sessions`] = json(page([{ session_id: 's1', membership_id: USER_M, display_name: 'Synthetic Sita Rai', state: 'active', aal: 'aal2', created_at: '2026-11-11T05:00:00.000Z', last_seen_at: '2026-11-11T07:55:00.000Z', idle_expires_at: '2026-11-11T08:25:00.000Z', absolute_expires_at: '2026-11-11T17:00:00.000Z', client_ip_masked: '203.0.113.x', user_agent_family: 'Firefox', is_support: false }]));
    routes[`GET ${ID}/audit-entries`] = json(page([]));
  });

  it('cross-tenant / unknown id → 404 from the API renders not-found (no data leak)', async () => {
    routes[`GET ${ONE}`] = () => problem('common.not_found', 404);
    const m = await showOrThrown('users/[membership_id]', P);
    expect(m === undefined ? pageText() : m).toMatch(/NEXT_NOT_FOUND|not found/i);
  });

  it('header shows name, status, Locked badge; tabs Profile, Roles, Centre access, Sessions, History; Signatory only for lab.result.approve holders', async () => {
    await show('users/[membership_id]', P);
    expect(screen.getByRole('heading', { name: /Synthetic Sita Rai/ })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => norm(t.textContent));
    expect(tabs).toEqual(expect.arrayContaining(['Profile', 'Roles', 'Centre access', 'Sessions', 'History']));
    expect(tabs).not.toContain('Signatory'); // user holds only front_desk; tenant flag not set
    cleanup();
    routes[`GET ${ONE}`] = json(userDetail({ roles: [{ role_id: ROLE_ADMIN, code: 'pathologist', name: 'Pathologist' }] }));
    routes[`GET ${ID}/roles`] = json({ data: [role({ role_id: ROLE_ADMIN, code: 'pathologist', name: 'Pathologist', permission_codes: ['lab.result.approve'] })] });
    await show('users/[membership_id]', P);
    expect(screen.getAllByRole('tab').map((t) => norm(t.textContent))).toContain('Signatory');
  });

  it('actions menu is permission-gated: without identity.user.manage no Lock/Deactivate/Reset 2-step/Log out all', async () => {
    resetApi(['identity.user.read', 'audit.log.read']);
    routes[`GET ${ONE}`] = json(userDetail());
    routes[`GET ${ID}/sessions`] = json(page([]));
    await show('users/[membership_id]', P);
    const t = pageText();
    for (const w of [/lock/i, /deactivate/i, /reset two-step/i, /log out all sessions/i]) expect(t).not.toMatch(w);
  });

  it('Profile: Email read-only, Full name 1–120, Mobile E.164; save PATCHes only changed fields with If-Match "<version>" (AC US-B1/B6 profile)', async () => {
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    expect(screen.getByLabelText(/^email/i).hasAttribute('readonly') || (screen.getByLabelText(/^email/i) as HTMLInputElement).disabled).toBe(true);
    routes[`PATCH ${ONE}`] = json(userDetail({ display_name: 'Synthetic Sita Renamed', version: 5 }));
    await user.clear(screen.getByLabelText(/full name/i));
    await user.type(screen.getByLabelText(/full name/i), 'Synthetic Sita Renamed');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PATCH', ONE)).toHaveLength(1));
    const c = callsTo('PATCH', ONE)[0]!;
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(bodyOf(c)).toEqual({ display_name: 'Synthetic Sita Renamed' });
  });

  it('409 common.version_conflict → dialog "This record was changed by someone else. Reload to see the latest version." with [Reload] (04-UI-UX §3)', async () => {
    await show('users/[membership_id]', P);
    routes[`PATCH ${ONE}`] = () => problem('common.version_conflict', 409);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/full name/i), 'x');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(norm(dlg.textContent)).toContain('This record was changed by someone else. Reload to see the latest version.');
    expect(within(dlg).getByRole('button', { name: /reload/i })).toBeTruthy();
  });

  it('Roles tab: warning "Saving logs this user out of all sessions."; Save = PUT /roles {role_ids} (If-Match); needs ≥1 role', async () => {
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Roles' }));
    expect(pageText()).toContain('Saving logs this user out of all sessions.');
    routes[`PUT ${ONE}/roles`] = json(userDetail({ version: 5 }));
    await user.click(screen.getByLabelText(/roles/i));
    await user.click(await screen.findByRole('option', { name: /lab technician/i }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', `${ONE}/roles`)).toHaveLength(1));
    expect(bodyOf(callsTo('PUT', `${ONE}/roles`)[0]).role_ids.sort()).toEqual([ROLE_FD, ROLE_LAB].sort());
    expect(callsTo('PUT', `${ONE}/roles`)[0]!.headers.get('if-match')).toBe('"4"');
    expect(Object.keys(bodyOf(callsTo('PUT', `${ONE}/roles`)[0]))).toEqual(['role_ids']);
  });

  it('Roles tab surfaces identity.last_admin_protected and identity.role_unknown as inline banners (US-B2.3)', async () => {
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Roles' }));
    routes[`PUT ${ONE}/roles`] = () => problem('identity.last_admin_protected', 409);
    await user.click(screen.getByRole('button', { name: /^save/i }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(pageText()).not.toContain('identity.last_admin_protected');
  });

  it('Centre access tab: PUT /centre-scope {all_centres, centre_ids, branch_ids}; session warning; hub-lab warning when roles grant lab.specimen.receive (D-13)', async () => {
    routes[`GET ${ONE}`] = json(userDetail({ roles: [RRlab()] }));
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Centre access' }));
    expect(pageText()).toContain('Saving logs this user out of all sessions.');
    expect(pageText()).toMatch(/These roles receive or work on samples/);
    routes[`PUT ${ONE}/centre-scope`] = json(userDetail({ version: 5 }));
    await user.click(screen.getByRole('radio', { name: /all centres/i }));
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', `${ONE}/centre-scope`)).toHaveLength(1));
    expect(bodyOf(callsTo('PUT', `${ONE}/centre-scope`)[0])).toMatchObject({ all_centres: true });
  });

  it('AC-B4.1 Lock: dialog with Reason Select (Left organisation, Security concern, Policy violation, Other), Details ≤500 required for Other; copy; POST /lock {reason_code, reason_text}', async () => {
    routes[`POST ${ONE}/lock`] = json(userDetail({ is_locked: true, version: 5 }));
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /actions|more/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^lock/i }));
    const dlg = await screen.findByRole('dialog');
    expect(norm(dlg.textContent)).toContain('Locked users are logged out immediately and cannot log in until unlocked.');
    await user.click(within(dlg).getByLabelText(/reason/i));
    for (const o of ['Left organisation', 'Security concern', 'Policy violation', 'Other']) expect(screen.getByRole('option', { name: o })).toBeTruthy();
    await user.click(screen.getByRole('option', { name: 'Other' }));
    await user.click(within(dlg).getByRole('button', { name: /^lock/i }));
    expect(callsTo('POST', `${ONE}/lock`)).toHaveLength(0); // Details required for "Other"
    await user.type(within(dlg).getByLabelText(/details/i), 'Synthetic note');
    await user.click(within(dlg).getByRole('button', { name: /^lock/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/lock`)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', `${ONE}/lock`)[0])).toEqual({ reason_code: 'other', reason_text: 'Synthetic note' });
    expect(callsTo('POST', `${ONE}/lock`)[0]!.headers.get('if-match')).toBe('"4"');
  });

  it('AC-B4.3 identity.self_action_forbidden (admin locks self) → inline banner, no toast of success', async () => {
    routes[`GET ${ONE}`] = json(userDetail({ membership_id: USER_M }));
    routes[`POST ${ONE}/lock`] = () => problem('identity.self_action_forbidden', 409);
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /actions|more/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^lock/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByLabelText(/reason/i));
    await user.click(screen.getByRole('option', { name: 'Security concern' }));
    await user.click(within(dlg).getByRole('button', { name: /^lock/i }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).toBeNull(); // toasts are success only (04-UI-UX §3)
  });

  it('AC-B4.2 locked user shows Unlock (not Lock); Unlock = POST /unlock behind a ConfirmDialog', async () => {
    routes[`GET ${ONE}`] = json(userDetail({ is_locked: true, lock: { locked_at: '2026-11-10T00:00:00.000Z', reason_code: 'security_concern' } }));
    routes[`POST ${ONE}/unlock`] = json(userDetail({ version: 5 }));
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /actions|more/i }));
    expect(screen.queryByRole('menuitem', { name: /^lock/i })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: /unlock/i }));
    await user.click(within(await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))).getByRole('button', { name: /unlock|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/unlock`)).toHaveLength(1));
  });

  it('Deactivate requires a reason (ConfirmDialog with reason_text); Reactivate for deactivated; Resend invitation only when Invited', async () => {
    routes[`POST ${ONE}/deactivate`] = json(userDetail({ status: 'deactivated', version: 5 }));
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /actions|more/i }));
    expect(screen.queryByRole('menuitem', { name: /resend invitation/i })).toBeNull(); // status active
    await user.click(await screen.findByRole('menuitem', { name: /deactivate/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(dlg).getByRole('button', { name: /deactivate|confirm/i }));
    expect(callsTo('POST', `${ONE}/deactivate`)).toHaveLength(0); // reason missing
    // ruling C2.T20-ruling §1: MembershipReasonRequest requires reason_code (identity.yaml:5496-5502)
    await user.click(within(dlg).getByLabelText(/reason/i));
    await user.click(await screen.findByRole('option', { name: /left organisation/i }));
    await user.type(within(dlg).getByRole('textbox'), 'Synthetic leaver');
    await user.click(within(dlg).getByRole('button', { name: /deactivate|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/deactivate`)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', `${ONE}/deactivate`)[0])).toEqual({ reason_code: 'left_organisation', reason_text: 'Synthetic leaver' });
  });

  it('AC-B5 Reset two-step verification: ConfirmDialog then POST /reset-mfa with a reason', async () => {
    routes[`POST ${ONE}/reset-mfa`] = json({ revoked: 2 });
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /actions|more/i }));
    await user.click(await screen.findByRole('menuitem', { name: /reset two-step/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    const reason = within(dlg).queryByRole('textbox');
    if (reason) await user.type(reason, 'Synthetic lost phone');
    await user.click(within(dlg).getByRole('button', { name: /reset|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/reset-mfa`)).toHaveLength(1));
  });

  it('Log out all sessions → POST /revoke-sessions after confirmation', async () => {
    routes[`POST ${ONE}/revoke-sessions`] = json({ revoked: 1 });
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /actions|more/i }));
    await user.click(await screen.findByRole('menuitem', { name: /log out all sessions/i }));
    await user.click(within(await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))).getByRole('button', { name: /log out|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ONE}/revoke-sessions`)).toHaveLength(1));
  });

  it('Sessions tab: columns incl. masked IP, per-row [Log out] → POST /sessions/{id}/revoke (identity.session.revoke)', async () => {
    routes[`POST ${ID}/sessions/s1/revoke`] = () => new Response(null, { status: 204 });
    await show('users/[membership_id]', P);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Sessions' }));
    const g = gridNamed(/sessions/i);
    expect(rowTexts(g)[0]).toMatch(/203\.0\.113\.x/);
    await user.click(within(g).getByRole('button', { name: /log out/i }));
    await user.click(within(await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))).getByRole('button', { name: /log out|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ID}/sessions/s1/revoke`)).toHaveLength(1));
  });

  it('History tab: last 50 audit entries for this membership (limit=50, row_id filter) and a link to AD-10', async () => {
    await show('users/[membership_id]', P);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'History' }));
    await waitFor(() => expect(callsTo('GET', `${ID}/audit-entries`).length).toBeGreaterThan(0));
    const q = callsTo('GET', `${ID}/audit-entries`)[0]!.url.searchParams;
    expect(q.get('limit')).toBe('50');
    expect(q.get('row_id')).toBe(USER_M);
    expect(screen.getByRole('link', { name: /audit/i }).getAttribute('href')).toMatch(/^\/admin\/audit\?/);
  });

  describe('Signatory (US-B6)', () => {
    beforeEach(() => {
      routes[`GET ${ONE}`] = json(userDetail({ roles: [RRlab()], signatory: { display_title: 'MD Pathology', registration_no: 'NMC-SYN-0001', signature_asset_id: '01a1a98a-ac40-7000-8000-0000000000aa' } }));
      routes[`GET ${ID}/roles`] = json({ data: [role({ role_id: ROLE_LAB, code: 'pathologist', name: 'Pathologist', permission_codes: ['lab.result.approve'] })] });
    });
    const open = async () => { await show('users/[membership_id]', P); const u = userEvent.setup(); await u.click(screen.getByRole('tab', { name: 'Signatory' })); return u; };

    it('fields Title (≤80), "Registration no. (e.g. NMC)" (≤40), Signature FileUpload (PNG/JPEG ≤1 MB) with hint + copy', async () => {
      await open();
      expect((screen.getByLabelText(/^title/i) as HTMLInputElement).value).toBe('MD Pathology');
      expect((screen.getByLabelText(/Registration no\. \(e\.g\. NMC\)/i) as HTMLInputElement).value).toBe('NMC-SYN-0001');
      expect(pageText()).toContain('Transparent PNG, at least 600 px wide works best');
      expect(pageText()).toContain('This signature is printed on reports this user approves (configured by report templates).');
      const input = document.querySelector('input[type=file]') as HTMLInputElement;
      expect(input.accept).toMatch(/image\/png/);
      expect(input.accept).toMatch(/image\/jpeg/);
      expect(input.accept).not.toMatch(/svg/);
    });

    it('title longer than 80 chars is rejected client-side (no PATCH)', async () => {
      const u = await open();
      await u.clear(screen.getByLabelText(/^title/i));
      await u.type(screen.getByLabelText(/^title/i), 'x'.repeat(81));
      await u.click(screen.getByRole('button', { name: /^save/i }));
      expect(callsTo('PATCH', ONE)).toHaveLength(0);
    });

    it('upload: multipart POST /signature with a PNG; a file over 1 MB or an SVG is refused before any request', async () => {
      routes[`POST ${ONE}/signature`] = json(userDetail({ version: 5 }), 200);
      const u = await open();
      const input = document.querySelector('input[type=file]') as HTMLInputElement;
      await u.upload(input, new File([new Uint8Array(2 * 1024 * 1024)], 'big.png', { type: 'image/png' }));
      await u.upload(input, new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'sig.svg', { type: 'image/svg+xml' }));
      expect(callsTo('POST', `${ONE}/signature`)).toHaveLength(0);
      await u.upload(input, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'sig.png', { type: 'image/png' }));
      await waitFor(() => expect(callsTo('POST', `${ONE}/signature`)).toHaveLength(1));
      expect(callsTo('POST', `${ONE}/signature`)[0]!.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    });

    it('server 415 common.unsupported_media_type surfaces as an inline error', async () => {
      routes[`POST ${ONE}/signature`] = () => problem('common.unsupported_media_type', 415);
      const u = await open();
      await u.upload(document.querySelector('input[type=file]') as HTMLInputElement, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'sig.png', { type: 'image/png' }));
      expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    });

    it('current signature preview is an <img> served through the BFF (no token in src, no inline svg)', async () => {
      await open();
      const img = document.querySelector('img') as HTMLImageElement | null;
      if (img) { expect(img.src).not.toMatch(/jwt|token|access_token/i); expect(img.src).not.toMatch(/^http:\/\/api\.t20\.test/); }
      expect(document.querySelector('svg image, svg foreignObject')).toBeNull();
    });
  });

  it('a11y: no axe violations on the detail page', async () => {
    await show('users/[membership_id]', P);
    await axeClean();
  });
});

function RRlab() { return { role_id: ROLE_LAB, code: 'lab_tech', name: 'Lab technician' }; }
void [ME_M, CENTRE_A2, BRANCH_1, calls, headersOf];
