// T17 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute.
//
// Files under test (plan row T17): handlers/{listSessions,revokeSession,listTenantSupportSessions,approveSupportSession,denySupportSession,revokeSupportSession,listAdminNotices,dismissAdminNotice}.ts
// (wired into handlers/index.ts) plus service/tenant-access.service.ts (+ optional repository/tenant-access.repo.ts). Same shape as T10 (self.helpers.ts).
//   service/tenant-access.service.ts exports `createTenantAccessService(deps?: { repo?: TenantAccessRepo; events?: { recordTenant(tx, e: AuthEvent): Promise<void> }; newId?: () => string })`
//        -> { listSessions, revokeSession, listTenantSupportSessions, approveSupportSession, denySupportSession, revokeSupportSession, listAdminNotices, dismissAdminNotice },
//        each `(ctx, input) => Promise<{ status, body?, version? }>`. Authorization (x-permission, aal2 for privileged codes) is the core pipeline's, as in T10/T14; the DEFAULT repo (SQL on ctx.tx) lives
//        in the service file or repository/tenant-access.repo.ts - tests only inject.
//   ctx (tenant request context) = { tenantId, actor{ type:'user', id: <user id>, membershipId, supportSessionId? }, sessionId: <the CALLER's current identity.sessions.id>, aal, requestId, clientIp, tx, now(), log,
//        audit:{ access(entry) } }. Tenant, caller and current session come ONLY from ctx, never from the input. A support-session actor (claims resolver) has NO membershipId and carries supportSessionId.
//   inputs (camelCase): listSessions{membershipId?,state?,limit?,cursor?} - revokeSession{sessionId} - listTenantSupportSessions{status?} - approveSupportSession{supportSessionId,expectedVersion}
//        - denySupportSession{supportSessionId,reasonText} - revokeSupportSession{supportSessionId} - listAdminNotices{} - dismissAdminNotice{noticeId}
//   bodies = SessionSummaryPage / SupportSessionList / SupportSession / AdminNoticeList of contracts/openapi/identity.yaml (additionalProperties:false; absent optionals OMITTED, never null).
//        204 ops: { status: 204 } and no body. Single-support-session results carry `version` (the handler turns it into the ETag).
//   TenantAccessRepo (every method takes the request tx first, then tenantId; the real SQL relies on RLS AND names the tenant explicitly):
//     listSessions(tx, t, { membershipId?, state?, limit, after? })   -> SessRow[]  ORDER BY last_seen_at DESC, id DESC, keyset `after { at: ISO, id }`; the service asks for limit+1; `state` is passed 1:1 (absent stays absent)
//     findSession(tx, t, { sessionId })                              -> SessRow | undefined   (FOR UPDATE)
//     revokeSession(tx, t, { sessionId, reason:'admin_revoke', at, actorId })
//     enqueue(tx, taskIdentifier, payload, jobKey)                    ('identity.gotrue_signout', payload { user_id, tenant_id, session_id }, jobKey `signout:<session id>:admin_revoke`, 02-TRD s10)
//     listSupportSessions(tx, t, { status?, limit })                  -> SupRow[]  (limit = 200, the SupportSessionList maxItems)
//     findSupportSession(tx, t, { supportSessionId })                 -> SupRow | undefined   (FOR UPDATE)
//     updateSupportSession(tx, t, { supportSessionId, expectedVersion, patch })  -> SupRow | undefined   (compare-and-set on version; undefined = lost race)
//          patch = { status, decidedAt?, decidedByMembershipId?, decisionNote?, endedAt?, endedBy?, endReason?, actorId }
//     unbindSupportSession(tx, t, { supportSessionId })               (clears identity.sessions.support_session_id of the platform session(s) bound to it, SP10)
//     listNotices(tx, t, { membershipId, now })                       -> NoticeRow[]  ORDER BY created_at DESC (unexpired, not dismissed by that membership, for all admins or for that membership)
//     findNotice(tx, t, { noticeId })                                 -> NoticeRow | undefined   (FOR UPDATE)
//     dismissNotice(tx, t, { noticeId, membershipId, actorId })        (appends the caller's MEMBERSHIP id to dismissed_by)
//   Events = events.recordTenant(tx, AuthEvent) (repository/auth-events.repo.ts): revokeSession records `session_revoked`, reasonCode 'admin_revoke', userId/membershipId of the TARGET, sessionId, actorId = caller.
//   Access log = ctx.audit.access({action, entityType, entityId, outcome:'allowed'}) (02-TRD s9 table), written LAST, only after every other write succeeded.
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';

export { LimsError };
export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1), REQ_ID = idN(0xe1), CLIENT_IP = '203.0.113.9';
export const NOW = new Date('2026-11-08T06:00:00.000Z');
export const HOUR = 3_600_000;
export const SECRET = 'SECRET-SENTINEL-7f3a';
export const REASON = 'Planted reason text PLANTED-REASON-5c1e';
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export interface SessRow {
  id: string; tenant_id: string; kind: string; user_id: string; membership_id: string; display_name: string; state: string; aal: 'aal1' | 'aal2';
  created_at: Date; last_seen_at: Date; idle_expires_at: Date; absolute_expires_at: Date; client_ip: string | null; user_agent: string | null; support_session_id: string | null;
  revoke_reason?: string | undefined;
  token_sha256?: string; refresh_token_enc?: string; access_token_enc?: string; enc_key_id?: string; gotrue_session_id?: string;   // never on the wire
}
export interface SupRow {
  id: string; tenant_id: string; platform_staff_id: string; platform_staff_display_name: string; scope: 'read_only' | 'admin'; reason_text: string; ticket_ref: string; duration_minutes: number;
  status: string; requested_at: Date; decided_at: Date | null; decided_by_membership_id: string | null; decision_note: string | null; started_at: Date | null; expires_at: Date | null;
  ended_at: Date | null; ended_by: string | null; end_reason: string | null; version: number; platform_session_id: string | null;
}
export interface NoticeRow {
  id: string; tenant_id: string; kind: string; subject_type: string; subject_id: string | null; created_for_membership_id: string | null; dismissed_by: string[]; created_at: Date; expires_at: Date;
  created_by?: string;
}
export interface Write { seq: number; m: string; arg: any; committed: boolean }

export const ADMIN = { userId: idN(0xa01), membershipId: idN(0xa02), sessionId: idN(0xa03) };
export const ADMIN2 = { userId: idN(0xa04), membershipId: idN(0xa05) };       // another tenant-A admin (notice tests)
export const STAFF1 = { userId: idN(0xa11), membershipId: idN(0xa12) }, STAFF2 = { userId: idN(0xa21), membershipId: idN(0xa22) };
export const B_STAFF = { userId: idN(0xb11), membershipId: idN(0xb12) };
export const PLATFORM_STAFF = idN(0xc01), PLATFORM_SESSION = idN(0xc02);

/** One world: in-memory TenantAccessRepo with a REAL commit/rollback envelope (every write is undone when the operation throws). */
export function makeWorld() {
  const sessions: SessRow[] = [], supports: SupRow[] = [], notices: NoticeRow[] = [];
  const bindings: Array<{ platformSessionId: string; supportSessionId: string | null }> = [];
  const writes: Write[] = []; const order: string[] = []; let seq = 0; let pending: Array<{ w: Write; undo?: () => void }> = []; let n = 0x7000;
  const rec = (m: string, arg: unknown, undo?: () => void) => { const w: Write = { seq: seq++, m, arg, committed: false }; writes.push(w); pending.push({ w, ...(undo ? { undo } : {}) }); order.push(m); };
  const fail = { enabled: {} as Record<string, Error | undefined> };
  const calls: Record<string, any[]> = {};
  const spy = (m: string, a: unknown) => { (calls[m] ??= []).push(a); };
  const copy = <T>(r: T): T => ({ ...(r as any) });
  const supView = (s: SupRow): SupRow => ({ ...s, platform_session_id: bindings.find((b) => b.supportSessionId === s.id)?.platformSessionId ?? null });

  const repo = {
    async listSessions(_tx: unknown, t: string, a: { membershipId?: string; state?: string; limit: number; after?: { at: string; id: string } }) {
      spy('listSessions', a); const af = a.after && { at: Date.parse(a.after.at), id: a.after.id };
      return sessions.filter((s) => s.tenant_id === t && (!a.membershipId || s.membership_id === a.membershipId) && (!a.state || s.state === a.state)
        && (!af || s.last_seen_at.getTime() < af.at || (s.last_seen_at.getTime() === af.at && s.id < af.id)))
        .sort((x, y) => (x.last_seen_at.getTime() === y.last_seen_at.getTime() ? (x.id < y.id ? 1 : -1) : y.last_seen_at.getTime() - x.last_seen_at.getTime())).slice(0, a.limit).map(copy);
    },
    async findSession(_tx: unknown, t: string, a: { sessionId: string }) { spy('findSession', a); const s = sessions.find((x) => x.id === a.sessionId && x.tenant_id === t); return s && copy(s); },
    async revokeSession(_tx: unknown, t: string, a: { sessionId: string; reason: string; at: Date; actorId: string }) {
      const s = sessions.find((x) => x.id === a.sessionId && x.tenant_id === t); const before = s && copy(s);
      rec('revokeSession', { t, ...a }, () => { if (s && before) Object.assign(s, before); }); if (s && s.state !== 'revoked' && s.state !== 'expired') { s.state = 'revoked'; s.revoke_reason = a.reason; }
    },
    async enqueue(_tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string) { rec('enqueue', { identifier, payload, jobKey }); },
    async listSupportSessions(_tx: unknown, t: string, a: { status?: string; limit: number }) {
      spy('listSupportSessions', a);
      return supports.filter((s) => s.tenant_id === t && (!a.status || s.status === a.status)).sort((x, y) => y.requested_at.getTime() - x.requested_at.getTime()).slice(0, a.limit).map(supView);
    },
    async findSupportSession(_tx: unknown, t: string, a: { supportSessionId: string }) { spy('findSupportSession', a); const s = supports.find((x) => x.id === a.supportSessionId && x.tenant_id === t); return s && supView(s); },
    async updateSupportSession(_tx: unknown, t: string, a: { supportSessionId: string; expectedVersion: number; patch: Record<string, any> }) {
      const s = supports.find((x) => x.id === a.supportSessionId && x.tenant_id === t); if (!s || s.version !== a.expectedVersion) return undefined;
      const before = copy(s); rec('updateSupportSession', { t, ...a }, () => { Object.assign(s, before); });
      const p = a.patch; s.status = p['status']; s.version += 1;
      if (p['decidedAt']) s.decided_at = p['decidedAt']; if (p['decidedByMembershipId']) s.decided_by_membership_id = p['decidedByMembershipId']; if (p['decisionNote'] !== undefined) s.decision_note = p['decisionNote'];
      if (p['endedAt']) s.ended_at = p['endedAt']; if (p['endedBy']) s.ended_by = p['endedBy']; if (p['endReason']) s.end_reason = p['endReason'];
      return supView(s);
    },
    async unbindSupportSession(_tx: unknown, t: string, a: { supportSessionId: string }) {
      const hit = bindings.filter((b) => b.supportSessionId === a.supportSessionId); const before = hit.map(copy);
      rec('unbindSupportSession', { t, ...a }, () => { hit.forEach((b, i) => Object.assign(b, before[i])); }); hit.forEach((b) => { b.supportSessionId = null; });
    },
    async listNotices(_tx: unknown, t: string, a: { membershipId: string; now: Date }) {
      spy('listNotices', a);
      return notices.filter((x) => x.tenant_id === t && x.expires_at.getTime() > a.now.getTime() && !x.dismissed_by.includes(a.membershipId)
        && (x.created_for_membership_id === null || x.created_for_membership_id === a.membershipId)).sort((x, y) => y.created_at.getTime() - x.created_at.getTime()).map((x) => ({ ...x, dismissed_by: [...x.dismissed_by] }));
    },
    async findNotice(_tx: unknown, t: string, a: { noticeId: string }) { spy('findNotice', a); const x = notices.find((y) => y.id === a.noticeId && y.tenant_id === t); return x && { ...x, dismissed_by: [...x.dismissed_by] }; },
    async dismissNotice(_tx: unknown, t: string, a: { noticeId: string; membershipId: string; actorId: string }) {
      const x = notices.find((y) => y.id === a.noticeId && y.tenant_id === t); const before = x && [...x.dismissed_by];
      rec('dismissNotice', { t, ...a }, () => { if (x && before) x.dismissed_by = before; }); if (x && !x.dismissed_by.includes(a.membershipId)) x.dismissed_by = [...x.dismissed_by, a.membershipId];
    },
  };
  for (const m of Object.keys(repo) as Array<keyof typeof repo>) { const f = repo[m] as any; (repo as any)[m] = async (...a: unknown[]) => { if (fail.enabled[m]) throw fail.enabled[m]; return f(...a); }; }
  const events = { async recordTenant(_tx: unknown, e: any) { rec('recordTenant', e); } };
  const audit = vi.fn(async (_e: Record<string, unknown>) => undefined);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = { repo, events, newId: () => idN(n++) };

  /** request-tx envelope: COMMIT on resolve, rollback (undo every write) on reject */
  async function envelope<T>(fn: () => Promise<T>): Promise<T> {
    pending = [];
    try { const r = await fn(); for (const p of pending) p.w.committed = true; return r; }
    catch (e) { for (const p of [...pending].reverse()) p.undo?.(); throw e; }
    finally { pending = []; }
  }
  const committed = (m?: string) => writes.filter((w) => w.committed && (!m || w.m === m));
  const eventsOf = (type: string) => committed('recordTenant').map((w) => w.arg).filter((e) => e.eventType === type);

  const SECRETS = { token_sha256: SECRET, refresh_token_enc: SECRET, access_token_enc: SECRET, enc_key_id: SECRET };
  function addSession(o: { userId: string; membershipId: string; tenantId?: string }, a: Partial<SessRow> = {}): SessRow {
    const row: SessRow = { id: idN(n++), tenant_id: o.tenantId ?? TENANT_A, kind: 'tenant_staff', user_id: o.userId, membership_id: o.membershipId, display_name: 'Demo Staff', state: 'active', aal: 'aal2',
      created_at: NOW, last_seen_at: NOW, idle_expires_at: new Date(NOW.getTime() + 900_000), absolute_expires_at: new Date(NOW.getTime() + 28_800_000),
      client_ip: '203.0.113.9', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0', support_session_id: null, ...SECRETS, gotrue_session_id: idN(n++), ...a };
    sessions.push(row); return row;
  }
  function addSupport(a: Partial<SupRow> = {}): SupRow {
    const row: SupRow = { id: idN(n++), tenant_id: TENANT_A, platform_staff_id: PLATFORM_STAFF, platform_staff_display_name: 'Demo Support', scope: 'read_only', reason_text: REASON, ticket_ref: 'SUP-1001',
      duration_minutes: 30, status: 'requested', requested_at: new Date(NOW.getTime() - HOUR), decided_at: null, decided_by_membership_id: null, decision_note: null, started_at: null, expires_at: null,
      ended_at: null, ended_by: null, end_reason: null, version: 1, platform_session_id: null, ...a };
    supports.push(row); if (row.status === 'active') bindings.push({ platformSessionId: PLATFORM_SESSION, supportSessionId: row.id }); return row;
  }
  function addNotice(a: Partial<NoticeRow> = {}): NoticeRow {
    const row: NoticeRow = { id: idN(n++), tenant_id: TENANT_A, kind: 'support_session_requested', subject_type: 'support_session', subject_id: idN(n++), created_for_membership_id: null, dismissed_by: [],
      created_at: new Date(NOW.getTime() - HOUR), expires_at: new Date(NOW.getTime() + 24 * HOUR), created_by: SECRET, ...a };
    notices.push(row); return row;
  }
  /** tenant ctx of the caller (default: tenant A admin); override any field, e.g. `{ actor: { type:'user', id, supportSessionId } }` */
  function ctxFor(c: Record<string, unknown> = {}) {
    return { tenantId: TENANT_A, actor: { type: 'user', id: ADMIN.userId, membershipId: ADMIN.membershipId }, sessionId: ADMIN.sessionId, aal: 'aal2', requestId: REQ_ID, clientIp: CLIENT_IP,
      tx: { __tx: 'T17-request-tx', query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }, now: () => NOW, log, audit: { access: audit }, ...c } as any;
  }
  /** run one service operation inside the envelope */
  const run = <T>(fn: (ctx: any) => Promise<T>, c: Record<string, unknown> = {}) => envelope(() => fn(ctxFor(c)));
  return { sessions, supports, notices, bindings, repo, events, audit, log, deps, writes, order, calls, fail, committed, eventsOf, addSession, addSupport, addNotice, ctxFor, run, envelope };
}
export type World = ReturnType<typeof makeWorld>;

/** every string the sinks (logs, access-log, events, jobs) hold; the support-session / notice stores legitimately hold reason texts and are NOT included */
export const sinks = (w: World) => JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.audit.mock.calls,
  w.writes.filter((x) => x.m === 'recordTenant' || x.m === 'enqueue').map((x) => x.arg)]);
/** what a client sees of an error */
export const errBody = (e: any) => JSON.stringify({ code: e.code, message: e.message, detail: e.detail ?? null, errors: e.errors ?? null, status: e.statusCode });
export const otherWrites = (w: World, allowed: string[]) => w.committed().filter((x) => !allowed.includes(x.m)).map((x) => x.m);
