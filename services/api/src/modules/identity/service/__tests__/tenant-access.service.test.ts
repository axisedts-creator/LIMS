// T17 behaviour of service/tenant-access.service.ts: tenant sessions, tenant-side support sessions, admin notices.
// 01-PRD AC-A5.3 (+AC-A5.4 guard), AC-E4.4; 03-APP-FLOW SP3/SP4/SP10; 02-TRD s5.x rows + s9 access-log table; 07-SECURITY P-1, P-3, P-6, E-5, threat 6 (reason text), P2.
// Seams: tenant-access.helpers.ts. Expected now: the suite fails to load (service/tenant-access.service.ts does not exist).
import { describe, expect, it } from 'vitest';
import { createTenantAccessService } from '../tenant-access.service.js';
import { ADMIN, ADMIN2, B_STAFF, HOUR, NOW, PLATFORM_SESSION, REASON, SECRET, STAFF1, STAFF2, TENANT_A, TENANT_B, errBody, idN, makeWorld, otherWrites, rejection, sinks, type World } from './tenant-access.helpers.js';

const setup = () => { const w = makeWorld(); return { w, svc: createTenantAccessService(w.deps as any) as unknown as Record<string, (ctx: any, input?: any) => Promise<any>> }; };
const NOT_A_SESSION = idN(0xdead);
const ALLOWED_SESSION_KEYS = ['session_id', 'membership_id', 'display_name', 'state', 'aal', 'created_at', 'last_seen_at', 'idle_expires_at', 'absolute_expires_at', 'client_ip_masked', 'user_agent_family', 'is_support'];
const ALLOWED_SUPPORT_KEYS = ['support_session_id', 'tenant_id', 'platform_staff_id', 'platform_staff_display_name', 'scope', 'reason_text', 'ticket_ref', 'duration_minutes', 'status', 'requested_at', 'decided_at',
  'decision_note', 'started_at', 'expires_at', 'ended_at', 'end_reason', 'version'];
const noWrites = (w: World) => expect(w.committed().map((x) => x.m)).toEqual([]);

describe('context guards', () => {
  it.each(['listSessions', 'revokeSession', 'listTenantSupportSessions', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession', 'listAdminNotices', 'dismissAdminNotice'])(
    '%s: no tenant / actor / tx in ctx -> auth.unauthenticated, repo untouched', async (op) => {
      const { w, svc } = setup(); for (const c of [{ tenantId: undefined }, { actor: undefined }, { tx: undefined }]) {
        const e = await rejection(svc[op]!(w.ctxFor(c), { sessionId: idN(1), supportSessionId: idN(1), noticeId: idN(1), expectedVersion: 1, reasonText: 'x' })); expect(e.code).toBe('auth.unauthenticated');
      }
      expect(Object.keys(w.calls)).toEqual([]); noWrites(w);
    });
});

describe('listSessions', () => {
  it('returns SessionSummary rows of the caller\'s tenant: whitelisted keys, IP masked, user agent reduced to its family, no token material', async () => {
    const { w, svc } = setup(); const s = w.addSession(STAFF1, { display_name: 'Demo Lab Tech' }); w.addSession(ADMIN);
    const r = await svc['listSessions']!(w.ctxFor(), {}); expect(r.status).toBe(200); expect(r.body.data).toHaveLength(2);
    const row = r.body.data.find((x: any) => x.session_id === s.id); expect(Object.keys(row).every((k) => ALLOWED_SESSION_KEYS.includes(k)), JSON.stringify(Object.keys(row))).toBe(true);
    expect(row).toMatchObject({ membership_id: STAFF1.membershipId, display_name: 'Demo Lab Tech', state: 'active', aal: 'aal2', user_agent_family: 'Firefox', is_support: false, created_at: NOW.toISOString() });
    expect(row.client_ip_masked).toBeTypeOf('string'); expect(row.client_ip_masked).not.toContain('113.9'); expect(row.client_ip_masked).not.toBe('203.0.113.9');
    expect(JSON.stringify(r.body)).not.toContain(SECRET); expect(JSON.stringify(r.body)).not.toContain('Windows NT'); expect(JSON.stringify(r.body)).not.toContain('gotrue');
    expect(r.body.page).toEqual({ limit: 50 });
  });
  it('is_support is true for a session bound to a support session', async () => {
    const { w, svc } = setup(); w.addSession(STAFF1, { support_session_id: idN(0x99) }); expect((await svc['listSessions']!(w.ctxFor(), {})).body.data[0].is_support).toBe(true);
  });
  it('P-3: tenant B sessions are never returned, even when B data exists and even if the repo leaks B rows', async () => {
    const { w, svc } = setup(); w.addSession(STAFF1); const b = w.addSession({ ...B_STAFF, tenantId: TENANT_B });
    expect(JSON.stringify((await svc['listSessions']!(w.ctxFor(), {})).body)).not.toContain(b.id);
    const leaky = createTenantAccessService({ ...w.deps, repo: { ...w.repo, listSessions: async () => [...w.sessions] } } as any) as any;   // repo ignores the tenant
    const r = await leaky.listSessions(w.ctxFor(), {}); expect(r.body.data.map((x: any) => x.session_id)).not.toContain(b.id); expect(r.body.data).toHaveLength(1);
  });
  it('filters membership_id / state are passed 1:1 to the repo; absent filters stay absent', async () => {
    const { w, svc } = setup(); w.addSession(STAFF1); w.addSession(STAFF2, { state: 'revoked', revoke_reason: 'admin_revoke' });
    const r = await svc['listSessions']!(w.ctxFor(), { membershipId: STAFF2.membershipId, state: 'revoked' }); expect(r.body.data.map((x: any) => x.state)).toEqual(['revoked']);
    expect(w.calls['listSessions']![0]).toMatchObject({ membershipId: STAFF2.membershipId, state: 'revoked' });
    await svc['listSessions']!(w.ctxFor(), {}); const a = w.calls['listSessions']![1]; expect(a.membershipId).toBeUndefined(); expect(a.state).toBeUndefined();
  });
  it.each([[{ state: 'nope' }], [{ state: 'ACTIVE' }], [{ membershipId: 'not-a-uuid' }], [{ limit: 0 }], [{ limit: 201 }], [{ limit: 1.5 }], [{ cursor: '!!!' }], [{ cursor: Buffer.from('{"x":1}').toString('base64url') }]])(
    'invalid input %j -> 400 common.validation_failed, repo not called', async (input) => {
      const { w, svc } = setup(); w.addSession(STAFF1); const e = await rejection(svc['listSessions']!(w.ctxFor(), input)); expect(e.code).toBe('common.validation_failed'); expect(w.calls['listSessions']).toBeUndefined();
    });
  it('keyset paging: limit+1 requested, next_cursor only when more rows exist, no duplicates / gaps over three pages', async () => {
    const { w, svc } = setup(); const ids = [0, 1, 2, 3, 4].map((i) => w.addSession(STAFF1, { last_seen_at: new Date(NOW.getTime() - i * 60_000) }).id);
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await svc['listSessions']!(w.ctxFor(), { limit: 2, ...(cursor ? { cursor } : {}) }); expect(r.body.data.length).toBeLessThanOrEqual(2); seen.push(...r.body.data.map((x: any) => x.session_id));
      cursor = r.body.page.next_cursor; expect(r.body.page.limit).toBe(2); pages++; expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(seen).toEqual(ids); expect(pages).toBe(3); expect(w.calls['listSessions']![0].limit).toBe(3);
  });
  it('no next_cursor on the last page; page.limit echoes the default 50', async () => {
    const { w, svc } = setup(); w.addSession(STAFF1); const r = await svc['listSessions']!(w.ctxFor(), {}); expect(r.body.page).toEqual({ limit: 50 }); expect(w.calls['listSessions']![0].limit).toBe(51);
  });
});

describe('revokeSession (AC-A5.3, AC-A5.4)', () => {
  it('AC-A5.3: a tenant admin revokes a staff user\'s session: revoked (admin_revoke), sign-out job, session_revoked event, access-log session.revoke; 204', async () => {
    const { w, svc } = setup(); const s = w.addSession(STAFF1); w.addSession(ADMIN, { id: ADMIN.sessionId });
    const r = await w.run((c) => svc['revokeSession']!(c, { sessionId: s.id })); expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect(s.state).toBe('revoked'); expect(s.revoke_reason).toBe('admin_revoke');                                   // the next request of that session is rejected (T8 resolver reads the row)
    expect(w.committed('revokeSession').map((x) => x.arg)).toEqual([expect.objectContaining({ t: TENANT_A, sessionId: s.id, reason: 'admin_revoke', actorId: ADMIN.userId, at: NOW })]);
    expect(w.committed('enqueue').map((x) => x.arg)).toEqual([{ identifier: 'identity.gotrue_signout', payload: { user_id: STAFF1.userId, tenant_id: TENANT_A, session_id: s.id }, jobKey: `signout:${s.id}:admin_revoke` }]);
    expect(w.eventsOf('session_revoked')).toEqual([expect.objectContaining({ reasonCode: 'admin_revoke', tenantId: TENANT_A, userId: STAFF1.userId, membershipId: STAFF1.membershipId, sessionId: s.id, actorId: ADMIN.userId })]);
    expect(w.audit.mock.calls).toEqual([[{ action: 'session.revoke', entityType: 'session', entityId: s.id, outcome: 'allowed' }]]);
    expect(otherWrites(w, ['revokeSession', 'enqueue', 'recordTenant'])).toEqual([]);
  });
  it('the access-log entry is written LAST, after the revoke, the job and the event (no entry for a rolled-back revoke)', async () => {
    const { w, svc } = setup(); const s = w.addSession(STAFF1); let auditAfter = -1; w.audit.mockImplementation(async () => { auditAfter = w.writes.length; });
    await w.run((c) => svc['revokeSession']!(c, { sessionId: s.id })); expect(auditAfter).toBe(3);
  });
  it('AC-A5.4: the caller\'s own CURRENT session -> 409 identity.self_action_forbidden; nothing written, no access-log entry', async () => {
    const { w, svc } = setup(); const own = w.addSession(ADMIN, { id: ADMIN.sessionId });
    const e = await rejection(w.run((c) => svc['revokeSession']!(c, { sessionId: own.id }))); expect(e.code).toBe('identity.self_action_forbidden'); expect(own.state).toBe('active'); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('P-1: a session of tenant B -> 404 common.not_found, identical to a random uuid; B unchanged, nothing written', async () => {
    const { w, svc } = setup(); const b = w.addSession({ ...B_STAFF, tenantId: TENANT_B });
    const e1 = await rejection(w.run((c) => svc['revokeSession']!(c, { sessionId: b.id }))); const e2 = await rejection(w.run((c) => svc['revokeSession']!(c, { sessionId: NOT_A_SESSION })));
    expect(e1.code).toBe('common.not_found'); expect(errBody(e1)).toBe(errBody(e2)); expect(b.state).toBe('active'); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it.each([['not-a-uuid'], [''], [undefined], [42]])('malformed session id %j -> 404 common.not_found (as revokeOwnSession), repo not called', async (id) => {
    const { w, svc } = setup(); const e = await rejection(svc['revokeSession']!(w.ctxFor(), { sessionId: id })); expect(e.code).toBe('common.not_found'); expect(w.calls['findSession']).toBeUndefined();
  });
  it.each(['revoked', 'expired'])('an already %s session -> 204 and no write, no duplicate job / event / access-log entry', async (state) => {
    const { w, svc } = setup(); const s = w.addSession(STAFF1, { state, revoke_reason: 'logout' }); const r = await w.run((c) => svc['revokeSession']!(c, { sessionId: s.id }));
    expect(r.status).toBe(204); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('a failure after the revoke (job enqueue) rolls the revoke back: the session stays live, no access-log entry', async () => {
    const { w, svc } = setup(); const s = w.addSession(STAFF1); w.fail.enabled['enqueue'] = new Error('queue down');
    await rejection(w.run((c) => svc['revokeSession']!(c, { sessionId: s.id }))); expect(s.state).toBe('active'); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('no token material, session secret or raw IP reaches logs, access log, events or jobs', async () => {
    const { w, svc } = setup(); const s = w.addSession(STAFF1); await w.run((c) => svc['revokeSession']!(c, { sessionId: s.id }));
    expect(sinks(w)).not.toContain(SECRET); expect(sinks(w)).not.toContain('Windows NT');
  });
  it('the tenant, caller and current session come from ctx only: an input tenantId / userId / actorId is ignored', async () => {
    const { w, svc } = setup(); const s = w.addSession(STAFF1);
    await w.run((c) => svc['revokeSession']!(c, { sessionId: s.id, tenantId: TENANT_B, userId: idN(9), actorId: idN(8), reason: 'lock' }));
    expect(w.committed('revokeSession')[0]!.arg).toMatchObject({ t: TENANT_A, reason: 'admin_revoke', actorId: ADMIN.userId });
  });
});

describe('listTenantSupportSessions', () => {
  it('returns the tenant\'s SupportSession rows (newest first), whitelisted keys, optionals omitted not null, no platform session id; body {data} only', async () => {
    const { w, svc } = setup(); const a = w.addSupport({ requested_at: new Date(NOW.getTime() - 2 * HOUR) }); const b = w.addSupport({ status: 'active', started_at: NOW, expires_at: new Date(NOW.getTime() + 30 * 60_000) });
    const r = await svc['listTenantSupportSessions']!(w.ctxFor(), {}); expect(r.status).toBe(200); expect(Object.keys(r.body)).toEqual(['data']);
    expect(r.body.data.map((x: any) => x.support_session_id)).toEqual([b.id, a.id]);
    for (const x of r.body.data) { expect(Object.keys(x).every((k) => ALLOWED_SUPPORT_KEYS.includes(k)), JSON.stringify(Object.keys(x))).toBe(true); expect(Object.values(x)).not.toContain(null); }
    expect(r.body.data[1]).toMatchObject({ support_session_id: a.id, tenant_id: TENANT_A, platform_staff_display_name: 'Demo Support', scope: 'read_only', reason_text: REASON, ticket_ref: 'SUP-1001', duration_minutes: 30, status: 'requested', version: 1, requested_at: a.requested_at.toISOString() });
    expect(r.body.data[1].decided_at).toBeUndefined(); expect(JSON.stringify(r.body)).not.toContain(PLATFORM_SESSION); expect(JSON.stringify(r.body)).not.toContain('decided_by_membership_id');
  });
  it('P-3 / P-6: tenant B rows are never returned, even if the repo leaks them', async () => {
    const { w, svc } = setup(); w.addSupport(); const b = w.addSupport({ tenant_id: TENANT_B });
    expect(JSON.stringify((await svc['listTenantSupportSessions']!(w.ctxFor(), {})).body)).not.toContain(b.id);
    const leaky = createTenantAccessService({ ...w.deps, repo: { ...w.repo, listSupportSessions: async () => [...w.supports] } } as any) as any;
    const r = await leaky.listTenantSupportSessions(w.ctxFor(), {}); expect(r.body.data.map((x: any) => x.support_session_id)).not.toContain(b.id); expect(r.body.data).toHaveLength(1);
  });
  it('status filter passed 1:1; unknown status -> 400 common.validation_failed without a repo call', async () => {
    const { w, svc } = setup(); w.addSupport(); w.addSupport({ status: 'denied', end_reason: 'denied' });
    expect((await svc['listTenantSupportSessions']!(w.ctxFor(), { status: 'denied' })).body.data.map((x: any) => x.status)).toEqual(['denied']); expect(w.calls['listSupportSessions']![0]).toMatchObject({ status: 'denied' });
    for (const status of ['nope', 'REQUESTED', 42, '']) { const e = await rejection(svc['listTenantSupportSessions']!(w.ctxFor(), { status })); expect(e.code).toBe('common.validation_failed'); }
    expect(w.calls['listSupportSessions']).toHaveLength(1);
  });
  it('never more than 200 rows (SupportSessionList maxItems), whatever the repo returns', async () => {
    const { w, svc } = setup(); for (let i = 0; i < 205; i++) w.addSupport(); const r = await svc['listTenantSupportSessions']!(w.ctxFor(), {}); expect(r.body.data.length).toBeLessThanOrEqual(200);
  });
});

describe('approveSupportSession (AC-E4.4, SP3)', () => {
  it('AC-E4.4: a tenant admin approves a requested session: approved, decided_at / decided by the caller\'s membership, access-log support_session.approve, 200 + version for the ETag', async () => {
    const { w, svc } = setup(); const s = w.addSupport();
    const r = await w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: s.id, expectedVersion: 1 }));
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ support_session_id: s.id, status: 'approved', version: 2, decided_at: NOW.toISOString(), scope: 'read_only' });
    expect(Object.keys(r.body).every((k) => ALLOWED_SUPPORT_KEYS.includes(k))).toBe(true);
    expect(w.committed('updateSupportSession').map((x) => x.arg)).toEqual([expect.objectContaining({ t: TENANT_A, supportSessionId: s.id, expectedVersion: 1, patch: expect.objectContaining({ status: 'approved', decidedAt: NOW, decidedByMembershipId: ADMIN.membershipId, actorId: ADMIN.userId }) })]);
    expect(w.audit.mock.calls).toEqual([[{ action: 'support_session.approve', entityType: 'support_session', entityId: s.id, outcome: 'allowed' }]]);
    expect(otherWrites(w, ['updateSupportSession'])).toEqual([]);
  });
  it('If-Match absent -> 428 common.precondition_required; malformed (0, -1, 1.5, "1", NaN) -> 400 common.validation_failed; no write either way', async () => {
    const { w, svc } = setup(); const s = w.addSupport();
    for (const v of [undefined, null]) expect((await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: s.id, expectedVersion: v })))).code).toBe('common.precondition_required');
    for (const v of [0, -1, 1.5, '1', Number.NaN, 2 ** 31]) expect((await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: s.id, expectedVersion: v })))).code, String(v)).toBe('common.validation_failed');
    noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('a stale If-Match -> 409 common.version_conflict; nothing written, session still requested', async () => {
    const { w, svc } = setup(); const s = w.addSupport({ version: 3 });
    const e = await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: s.id, expectedVersion: 2 }))); expect(e.code).toBe('common.version_conflict'); expect(s.status).toBe('requested'); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('a lost race (the compare-and-set update finds a newer version) -> 409 common.version_conflict and no access-log entry', async () => {
    const { w, svc } = setup(); const s = w.addSupport(); const racy = createTenantAccessService({ ...w.deps, repo: { ...w.repo, updateSupportSession: async () => undefined } } as any) as any;
    const e = await rejection(w.envelope(() => racy.approveSupportSession(w.ctxFor(), { supportSessionId: s.id, expectedVersion: 1 }))); expect(e.code).toBe('common.version_conflict'); expect(w.audit).not.toHaveBeenCalled(); void svc;
  });
  it.each(['approved', 'denied', 'active', 'ended', 'expired', 'revoked'])('only `requested` can be approved: a %s session -> 409 common.version_conflict, unchanged', async (status) => {
    const { w, svc } = setup(); const s = w.addSupport({ status }); const e = await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: s.id, expectedVersion: 1 })));
    expect(e.code).toBe('common.version_conflict'); expect(s.status).toBe(status); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('AC-E4.4 24 h rule: a request older than 24 h (SP5 expiry not yet run by the cron) can no longer be approved -> 409; at exactly 24 h it still can', async () => {
    const { w, svc } = setup(); const old = w.addSupport({ requested_at: new Date(NOW.getTime() - 24 * HOUR - 1000) }); const edge = w.addSupport({ requested_at: new Date(NOW.getTime() - 24 * HOUR) });
    const e = await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: old.id, expectedVersion: 1 }))); expect(e.code).toBe('common.version_conflict'); expect(old.status).toBe('requested'); noWrites(w);
    expect((await w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: edge.id, expectedVersion: 1 }))).status).toBe(200); expect(edge.status).toBe('approved');
  });
  it('P-6: a tenant B session -> 404 common.not_found identical to a random uuid; B unchanged, nothing written', async () => {
    const { w, svc } = setup(); const b = w.addSupport({ tenant_id: TENANT_B });
    const e1 = await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: b.id, expectedVersion: 1 }))); const e2 = await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: NOT_A_SESSION, expectedVersion: 1 })));
    expect(e1.code).toBe('common.not_found'); expect(errBody(e1)).toBe(errBody(e2)); expect(b.status).toBe('requested'); expect(b.version).toBe(1); noWrites(w);
  });
  it.each([['not-a-uuid'], [undefined], [7]])('malformed support session id %j -> 400 common.validation_failed (as T21)', async (id) => {
    const { w, svc } = setup(); const e = await rejection(svc['approveSupportSession']!(w.ctxFor(), { supportSessionId: id, expectedVersion: 1 })); expect(e.code).toBe('common.validation_failed'); expect(w.calls['findSupportSession']).toBeUndefined();
  });
  it('E-5 / self-approval: a support-session actor (claims `supportSessionId`, no membership) can never approve -> 403 auth.forbidden, nothing written', async () => {
    const { w, svc } = setup(); const s = w.addSupport({ status: 'requested' });
    for (const actor of [{ type: 'user', id: ADMIN.userId, supportSessionId: idN(0x55) }, { type: 'user', id: ADMIN.userId, membershipId: ADMIN.membershipId, supportSessionId: idN(0x55) }, { type: 'user', id: ADMIN.userId }]) {
      const e = await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: s.id, expectedVersion: 1 }), { actor })); expect(e.code, JSON.stringify(actor)).toBe('auth.forbidden');
    }
    expect(s.status).toBe('requested'); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('the support reason text never reaches logs, access log, events or jobs (07-SECURITY threat 6)', async () => {
    const { w, svc } = setup(); const s = w.addSupport(); await w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: s.id, expectedVersion: 1 })); expect(sinks(w)).not.toContain('PLANTED-REASON');
  });
});

describe('denySupportSession (AC-E4.4, SP4)', () => {
  it('AC-E4.4: denial ends the request: status denied, decision_note stored, end_reason denied, decided by the caller, access-log support_session.deny; 200 + version', async () => {
    const { w, svc } = setup(); const s = w.addSupport();
    const r = await w.run((c) => svc['denySupportSession']!(c, { supportSessionId: s.id, reasonText: 'Not needed, synthetic' }));
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ support_session_id: s.id, status: 'denied', decision_note: 'Not needed, synthetic', end_reason: 'denied', version: 2, decided_at: NOW.toISOString() });
    expect(w.committed('updateSupportSession').map((x) => x.arg)).toEqual([expect.objectContaining({ expectedVersion: 1, patch: expect.objectContaining({ status: 'denied', decidedAt: NOW, decidedByMembershipId: ADMIN.membershipId, decisionNote: 'Not needed, synthetic', endReason: 'denied', actorId: ADMIN.userId }) })]);
    expect(w.audit.mock.calls).toEqual([[{ action: 'support_session.deny', entityType: 'support_session', entityId: s.id, outcome: 'allowed' }]]); expect(otherWrites(w, ['updateSupportSession'])).toEqual([]);
  });
  it('a denied request can never be approved afterwards, and an approved one can no longer be denied (the state machine is closed)', async () => {
    const { w, svc } = setup(); const a = w.addSupport(); const b = w.addSupport();
    await w.run((c) => svc['denySupportSession']!(c, { supportSessionId: a.id, reasonText: 'no' }));
    expect((await rejection(w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: a.id, expectedVersion: 2 })))).code).toBe('common.version_conflict'); expect(a.status).toBe('denied');
    await w.run((c) => svc['approveSupportSession']!(c, { supportSessionId: b.id, expectedVersion: 1 }));
    expect((await rejection(w.run((c) => svc['denySupportSession']!(c, { supportSessionId: b.id, reasonText: 'late' })))).code).toBe('common.version_conflict'); expect(b.status).toBe('approved');
  });
  it('reason_text is required, 1..500 characters: missing / empty / non-string / 501 -> 400 common.validation_failed; exactly 500 is accepted', async () => {
    const { w, svc } = setup(); const s = w.addSupport();
    for (const reasonText of [undefined, null, '', 7, {}, 'x'.repeat(501)]) { const e = await rejection(w.run((c) => svc['denySupportSession']!(c, { supportSessionId: s.id, reasonText }))); expect(e.code, String(reasonText)).toBe('common.validation_failed'); }
    noWrites(w); expect((await w.run((c) => svc['denySupportSession']!(c, { supportSessionId: s.id, reasonText: 'x'.repeat(500) }))).status).toBe(200);
  });
  it.each(['approved', 'denied', 'active', 'ended', 'expired', 'revoked'])('only `requested` can be denied: a %s session -> 409 common.version_conflict, unchanged', async (status) => {
    const { w, svc } = setup(); const s = w.addSupport({ status }); const e = await rejection(w.run((c) => svc['denySupportSession']!(c, { supportSessionId: s.id, reasonText: 'no' })));
    expect(e.code).toBe('common.version_conflict'); expect(s.status).toBe(status); noWrites(w);
  });
  it('a lost race -> 409 common.version_conflict, no access-log entry', async () => {
    const { w } = setup(); const s = w.addSupport(); const racy = createTenantAccessService({ ...w.deps, repo: { ...w.repo, updateSupportSession: async () => undefined } } as any) as any;
    expect((await rejection(w.envelope(() => racy.denySupportSession(w.ctxFor(), { supportSessionId: s.id, reasonText: 'no' })))).code).toBe('common.version_conflict'); expect(w.audit).not.toHaveBeenCalled();
  });
  it('P-6: a tenant B session -> 404 identical to a random uuid; B unchanged', async () => {
    const { w, svc } = setup(); const b = w.addSupport({ tenant_id: TENANT_B });
    const e1 = await rejection(w.run((c) => svc['denySupportSession']!(c, { supportSessionId: b.id, reasonText: 'no' }))); const e2 = await rejection(w.run((c) => svc['denySupportSession']!(c, { supportSessionId: NOT_A_SESSION, reasonText: 'no' })));
    expect(e1.code).toBe('common.not_found'); expect(errBody(e1)).toBe(errBody(e2)); expect(b.status).toBe('requested'); noWrites(w);
  });
  it('E-5: a support-session actor can never deny -> 403 auth.forbidden', async () => {
    const { w, svc } = setup(); const s = w.addSupport(); const actor = { type: 'user', id: ADMIN.userId, supportSessionId: idN(0x55) };
    expect((await rejection(w.run((c) => svc['denySupportSession']!(c, { supportSessionId: s.id, reasonText: 'no' }), { actor }))).code).toBe('auth.forbidden'); noWrites(w);
  });
  it('the admin\'s note and the support reason text stay in the support-session row only: not in logs, access log, events or jobs', async () => {
    const { w, svc } = setup(); const s = w.addSupport(); await w.run((c) => svc['denySupportSession']!(c, { supportSessionId: s.id, reasonText: 'PLANTED-NOTE-77aa' }));
    expect(sinks(w)).not.toContain('PLANTED-NOTE-77aa'); expect(sinks(w)).not.toContain('PLANTED-REASON'); expect(s.decision_note).toBe('PLANTED-NOTE-77aa');
  });
});

describe('revokeSupportSession (SP10)', () => {
  it('an approved session is revoked by the tenant: status revoked, ended by the caller, end_reason revoked_by_tenant, access-log support_session.revoke; 200 + version', async () => {
    const { w, svc } = setup(); const s = w.addSupport({ status: 'approved', decided_at: NOW, version: 2 });
    const r = await w.run((c) => svc['revokeSupportSession']!(c, { supportSessionId: s.id })); expect(r.status).toBe(200); expect(r.version).toBe(3);
    expect(r.body).toMatchObject({ support_session_id: s.id, status: 'revoked', end_reason: 'revoked_by_tenant', ended_at: NOW.toISOString(), version: 3 });
    expect(w.committed('updateSupportSession').map((x) => x.arg)).toEqual([expect.objectContaining({ expectedVersion: 2, patch: expect.objectContaining({ status: 'revoked', endedAt: NOW, endedBy: ADMIN.userId, endReason: 'revoked_by_tenant', actorId: ADMIN.userId }) })]);
    expect(w.audit.mock.calls).toEqual([[{ action: 'support_session.revoke', entityType: 'support_session', entityId: s.id, outcome: 'allowed' }]]);
  });
  it('an ACTIVE session is revoked AND the platform session\'s support binding is cleared (the platform user is cut off at once)', async () => {
    const { w, svc } = setup(); const s = w.addSupport({ status: 'active', started_at: NOW, expires_at: new Date(NOW.getTime() + 20 * 60_000), version: 4 });
    expect(w.bindings).toEqual([{ platformSessionId: PLATFORM_SESSION, supportSessionId: s.id }]);
    await w.run((c) => svc['revokeSupportSession']!(c, { supportSessionId: s.id })); expect(s.status).toBe('revoked');
    expect(w.bindings).toEqual([{ platformSessionId: PLATFORM_SESSION, supportSessionId: null }]); expect(w.committed('unbindSupportSession').map((x) => x.arg)).toEqual([expect.objectContaining({ t: TENANT_A, supportSessionId: s.id })]);
  });
  it.each(['requested', 'denied', 'ended', 'expired', 'revoked'])('only approved / active can be revoked: a %s session -> 409 common.version_conflict, unchanged, no unbind', async (status) => {
    const { w, svc } = setup(); const s = w.addSupport({ status }); const e = await rejection(w.run((c) => svc['revokeSupportSession']!(c, { supportSessionId: s.id })));
    expect(e.code).toBe('common.version_conflict'); expect(s.status).toBe(status); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('a failure while clearing the binding rolls the revoke back: still active, no access-log entry', async () => {
    const { w, svc } = setup(); const s = w.addSupport({ status: 'active', started_at: NOW, expires_at: new Date(NOW.getTime() + 20 * 60_000) }); w.fail.enabled['unbindSupportSession'] = new Error('db down');
    await rejection(w.run((c) => svc['revokeSupportSession']!(c, { supportSessionId: s.id }))); expect(s.status).toBe('active'); noWrites(w); expect(w.audit).not.toHaveBeenCalled();
  });
  it('a lost race -> 409 common.version_conflict', async () => {
    const { w } = setup(); const s = w.addSupport({ status: 'approved', decided_at: NOW }); const racy = createTenantAccessService({ ...w.deps, repo: { ...w.repo, updateSupportSession: async () => undefined } } as any) as any;
    expect((await rejection(w.envelope(() => racy.revokeSupportSession(w.ctxFor(), { supportSessionId: s.id })))).code).toBe('common.version_conflict'); expect(w.audit).not.toHaveBeenCalled();
  });
  it('P-6: a tenant B session (even an active one) -> 404 identical to a random uuid; B unchanged, binding untouched', async () => {
    const { w, svc } = setup(); const b = w.addSupport({ tenant_id: TENANT_B, status: 'active', started_at: NOW, expires_at: new Date(NOW.getTime() + HOUR) });
    const e1 = await rejection(w.run((c) => svc['revokeSupportSession']!(c, { supportSessionId: b.id }))); const e2 = await rejection(w.run((c) => svc['revokeSupportSession']!(c, { supportSessionId: NOT_A_SESSION })));
    expect(e1.code).toBe('common.not_found'); expect(errBody(e1)).toBe(errBody(e2)); expect(b.status).toBe('active'); expect(w.bindings[0]!.supportSessionId).toBe(b.id); noWrites(w);
  });
  it('malformed id -> 400 common.validation_failed', async () => {
    const { w, svc } = setup(); expect((await rejection(svc['revokeSupportSession']!(w.ctxFor(), { supportSessionId: 'x' }))).code).toBe('common.validation_failed'); expect(w.calls['findSupportSession']).toBeUndefined();
  });
});

describe('listAdminNotices', () => {
  it('returns the caller\'s active notices: for all admins or for the caller, unexpired, not dismissed by the caller; whitelisted keys; subject_id omitted when NULL; no PHI / internals', async () => {
    const { w, svc } = setup();
    const all = w.addNotice(); const mine = w.addNotice({ created_for_membership_id: ADMIN.membershipId, kind: 'access_review_due', subject_type: 'access_review', created_at: new Date(NOW.getTime() - 2 * HOUR) });
    const throttled = w.addNotice({ kind: 'login_ip_throttled', subject_type: 'auth_event', subject_id: null, created_at: new Date(NOW.getTime() - 3 * HOUR) });
    w.addNotice({ expires_at: new Date(NOW.getTime() - 1000) });                                  // expired
    w.addNotice({ dismissed_by: [ADMIN.membershipId] });                                           // dismissed by me
    w.addNotice({ created_for_membership_id: ADMIN2.membershipId });                              // for another admin
    const r = await svc['listAdminNotices']!(w.ctxFor(), {}); expect(r.status).toBe(200); expect(Object.keys(r.body)).toEqual(['data']);
    expect(r.body.data.map((x: any) => x.notice_id)).toEqual([all.id, mine.id, throttled.id]);
    expect(r.body.data[0]).toEqual({ notice_id: all.id, kind: 'support_session_requested', subject_type: 'support_session', subject_id: all.subject_id, created_at: all.created_at.toISOString(), expires_at: all.expires_at.toISOString() });
    expect('subject_id' in r.body.data[2]).toBe(false); expect(JSON.stringify(r.body)).not.toContain(SECRET); expect(JSON.stringify(r.body)).not.toMatch(/dismissed_by|created_for|tenant_id|created_by/);
    expect(w.calls['listNotices']![0]).toMatchObject({ membershipId: ADMIN.membershipId, now: NOW });
  });
  it('a notice dismissed by ANOTHER admin is still shown to me', async () => {
    const { w, svc } = setup(); const n = w.addNotice({ dismissed_by: [ADMIN2.membershipId] }); expect((await svc['listAdminNotices']!(w.ctxFor(), {})).body.data.map((x: any) => x.notice_id)).toEqual([n.id]);
  });
  it('P-3: tenant B notices are never returned, even if the repo leaks them; expired / dismissed / foreign-targeted rows are dropped even if the repo leaks them', async () => {
    const { w } = setup(); const ok = w.addNotice(); const b = w.addNotice({ tenant_id: TENANT_B }); const old = w.addNotice({ expires_at: new Date(NOW.getTime() - 1) }); const dis = w.addNotice({ dismissed_by: [ADMIN.membershipId] });
    const other = w.addNotice({ created_for_membership_id: ADMIN2.membershipId });
    const leaky = createTenantAccessService({ ...w.deps, repo: { ...w.repo, listNotices: async () => [...w.notices] } } as any) as any; const ids = (await leaky.listAdminNotices(w.ctxFor(), {})).body.data.map((x: any) => x.notice_id);
    expect(ids).toEqual([ok.id]); for (const x of [b, old, dis, other]) expect(ids).not.toContain(x.id);
  });
  it('never more than 200 notices; no access-log entry for listing', async () => {
    const { w, svc } = setup(); for (let i = 0; i < 205; i++) w.addNotice(); expect((await svc['listAdminNotices']!(w.ctxFor(), {})).body.data.length).toBeLessThanOrEqual(200); expect(w.audit).not.toHaveBeenCalled();
  });
});

describe('dismissAdminNotice', () => {
  it('adds the caller\'s MEMBERSHIP to dismissed_by: 204 without body, gone from my list, still in the other admin\'s list; no access-log entry', async () => {
    const { w, svc } = setup(); const n = w.addNotice(); const r = await w.run((c) => svc['dismissAdminNotice']!(c, { noticeId: n.id })); expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect(w.committed('dismissNotice').map((x) => x.arg)).toEqual([{ t: TENANT_A, noticeId: n.id, membershipId: ADMIN.membershipId, actorId: ADMIN.userId }]); expect(otherWrites(w, ['dismissNotice'])).toEqual([]);
    expect((await svc['listAdminNotices']!(w.ctxFor(), {})).body.data).toEqual([]);
    expect((await svc['listAdminNotices']!(w.ctxFor({ actor: { type: 'user', id: ADMIN2.userId, membershipId: ADMIN2.membershipId } }), {})).body.data.map((x: any) => x.notice_id)).toEqual([n.id]); expect(w.audit).not.toHaveBeenCalled();
  });
  it('dismissing twice is idempotent: 204 and no second write', async () => {
    const { w, svc } = setup(); const n = w.addNotice({ dismissed_by: [ADMIN.membershipId] }); expect((await w.run((c) => svc['dismissAdminNotice']!(c, { noticeId: n.id }))).status).toBe(204); noWrites(w);
  });
  it('P-1: a tenant B notice -> 404 common.not_found identical to a random uuid; B unchanged', async () => {
    const { w, svc } = setup(); const b = w.addNotice({ tenant_id: TENANT_B });
    const e1 = await rejection(w.run((c) => svc['dismissAdminNotice']!(c, { noticeId: b.id }))); const e2 = await rejection(w.run((c) => svc['dismissAdminNotice']!(c, { noticeId: NOT_A_SESSION })));
    expect(e1.code).toBe('common.not_found'); expect(errBody(e1)).toBe(errBody(e2)); expect(b.dismissed_by).toEqual([]); noWrites(w);
  });
  it('a notice addressed to another admin is invisible to me -> 404 (same as unknown), not dismissed on their behalf', async () => {
    const { w, svc } = setup(); const n = w.addNotice({ created_for_membership_id: ADMIN2.membershipId });
    expect((await rejection(w.run((c) => svc['dismissAdminNotice']!(c, { noticeId: n.id })))).code).toBe('common.not_found'); expect(n.dismissed_by).toEqual([]); noWrites(w);
  });
  it.each([['not-a-uuid'], [''], [undefined], [3]])('malformed notice id %j -> 404 common.not_found, repo not called', async (id) => {
    const { w, svc } = setup(); expect((await rejection(svc['dismissAdminNotice']!(w.ctxFor(), { noticeId: id }))).code).toBe('common.not_found'); expect(w.calls['findNotice']).toBeUndefined();
  });
  it('input tenantId / membershipId are ignored: the caller\'s ctx decides', async () => {
    const { w, svc } = setup(); const n = w.addNotice(); await w.run((c) => svc['dismissAdminNotice']!(c, { noticeId: n.id, tenantId: TENANT_B, membershipId: ADMIN2.membershipId }));
    expect(w.committed('dismissNotice')[0]!.arg).toMatchObject({ t: TENANT_A, membershipId: ADMIN.membershipId });
  });
});
