// T10 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute.
//
// Files under test (plan row T10): handlers/{getMe,changeOwnPassword,listOwnSessions,revokeOwnSession,listOwnMfaFactors,removeOwnMfaFactor}.ts (wired into handlers/index.ts)
// plus service/self.service.ts. Same shape as T14 (role.helpers.ts): a service factory the handlers call, tests inject the fakes below.
//   service/self.service.ts  exports `createSelfService(deps?: { repo?: SelfRepo; gotrue?: Pick<GoTrueGateway,'signInWithPassword'|'signOut'|'adminUpdatePassword'|'adminDeleteFactor'>;
//                            breached?: { isBreached(tx, sha1: Buffer): Promise<boolean> }; events?: { recordTenant(tx, e: AuthEvent): Promise<void> }; newId?: () => string })`
//                            -> { getMe, changeOwnPassword, listOwnSessions, revokeOwnSession, listOwnMfaFactors, removeOwnMfaFactor }, each `(ctx, input) => Promise<{ status, body? }>`.
//                            The DEFAULT repo (SQL on ctx.tx, explicit tenant_id/user_id) lives in the service file or a repository/self.repo.ts - tests only inject.
//   ctx (tenant request context, as T14 + the session fields) = { tenantId, actor{ type:'user'|'partner', id: <user id>, membershipId }, sessionId: <identity.sessions.id of the CALLER's current session>,
//        aal, partnerRole? (partner only), requestId, clientIp, tx, now(), log, commitOnError(), audit:{ access(entry) } }. Tenant, user and current session come ONLY from ctx, never from input.
//   inputs (camelCase): getMe{} - changeOwnPassword{currentPassword,newPassword} - listOwnSessions{limit?} - revokeOwnSession{sessionId} - listOwnMfaFactors{} - removeOwnMfaFactor{factorId}
//   bodies = Me / SessionSummaryPage / MfaFactorList of contracts/openapi/identity.yaml (additionalProperties:false; absent optionals OMITTED, never null). 204 ops: { status: 204 } and no body.
//   Events = createAuthEventsRepo().recordTenant(tx, e) (AuthEvent shape of repository/auth-events.repo.ts; tenantId, userId, membershipId, sessionId?, clientIp, requestId, actorId set by the service).
//   changeOwnPassword verifies the current password with gotrue.signInWithPassword(email, current) (no verify-only call exists in GoTrueGateway) and sets the new one with gotrue.adminUpdatePassword.
//   SelfRepo (every method takes the request tx first, then tenantId; scoped to the caller's own rows - the real SQL relies on RLS + explicit predicates):
//     getProfile(tx, tenantId, { membershipId, userId, actorType }) -> Profile | undefined
//     listOwnSessions(tx, tenantId, { userId, limit, after? })      -> SessRow[]   (live sessions of that user in that tenant, ORDER BY last_seen_at DESC, id DESC, keyset after { at: ISO string, id } as T25; the service may ask for limit+1)
//                                                                       service input { limit?, cursor? }: opaque `cursor` <-> `page.next_cursor`; default limit 50
//     findOwnSession(tx, tenantId, { userId, sessionId })           -> SessRow | undefined   (FOR UPDATE; a session of another user / tenant -> undefined)
//     revokeSession(tx, tenantId, { sessionId, reason:'self_revoke', at, actorId })  (UPDATE ... WHERE state NOT IN ('revoked','expired'))
//     revokeOtherSessions(tx, { tenantId, userId, exceptSessionId, reason:'password_change', actorId }) -> [{ sessionId, kind }]   (T9 seam)
//     listOwnFactors(tx, tenantId, { userId })                      -> FactorRow[]  (status <> 'removed')
//     findOwnFactor(tx, tenantId, { userId, factorId })             -> FactorRow | undefined   (FOR UPDATE; another user's factor -> undefined)
//     roleRequiresMfa(tx, tenantId, { membershipId })               -> boolean   (some ACTIVE role of the membership has mfa_required)
//     markFactorRemoved(tx, tenantId, { factorId, reason:'self', at, actorId })
//     passwordMinLength(tx, tenantId)                               -> number | undefined   (identity.tenant_settings; undefined = no row -> the service fails closed, common.internal; REQUIRED method, not optional)
//     gotrue Pick also has 'signOut' (the verifying sign-in session is closed with signOut(accessToken,'local') after a successful current-password check)
//     enqueue(tx, taskIdentifier, payload, jobKey)                 (sign-out jobs: 'identity.gotrue_signout', payload { user_id, tenant_id, session_id }, jobKey `signout:<session id>:<reason>`)
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { createFakeGoTrueGateway } from '../../gotrue/gateway.fake.js';
import type { GoTrueGateway } from '../../gotrue/gateway.js';

export { LimsError };
export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1), REQ_ID = idN(0xe1), CLIENT_IP = '203.0.113.9';
export const NOW = new Date('2026-11-08T06:00:00.000Z');
export const SECRET = 'SECRET-SENTINEL-7f3a';
export const OLD_PW = 'Old-horse-battery-Lims!9', NEW_PW = 'Zq7-new-correct-horse-Lims!', WRONG_PW = 'Wrong-horse-battery-Lims!1';
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export interface Profile {
  membershipId: string; userId: string; email: string; displayName: string; roles: Array<{ role_id: string; code: string; name: string }>; permissions: string[];
  allCentres: boolean; centreIds: string[]; lastLoginAt: Date | null; hasVerifiedFactor: boolean;
}
export interface SessRow {
  id: string; tenant_id: string; kind: string; user_id: string; membership_id: string; display_name: string; state: string; aal: 'aal1' | 'aal2';
  created_at: Date; last_seen_at: Date; idle_expires_at: Date; absolute_expires_at: Date; client_ip: string | null; user_agent: string | null; support_session_id: string | null;
  revoke_reason?: string | undefined;
  token_sha256?: string; refresh_token_enc?: string; access_token_enc?: string; enc_key_id?: string; gotrue_session_id?: string;   // never on the wire
}
export interface FactorRow { id: string; tenant_id: string; user_id: string; gotrue_factor_id: string; friendly_name: string | null; status: 'unverified' | 'verified' | 'removed'; verified_at: Date | null; removal_reason?: string }
export interface Write { seq: number; m: string; arg: any; committed: boolean }

export type Who = 'ME' | 'OTHER' | 'P1' | 'P2' | 'B';
interface Person { key: Who; userId: string; membershipId: string; tenantId: string; type: 'user' | 'partner'; email: string; displayName: string; partnerRole?: string; password: string }

/** One world: fake GoTrue, 5 people (ME + OTHER = tenant A staff, P1 + P2 = tenant A partner members, B = tenant B staff), in-memory SelfRepo with a REAL commit/rollback envelope. */
export async function makeWorld(o: { breached?: (sha1: Buffer) => boolean } = {}) {
  const fake = createFakeGoTrueGateway(); const gcalls: Array<{ method: string; args: unknown[] }> = [];
  const gotrue = new Proxy(fake as unknown as GoTrueGateway, { get: (t, p: string) => (typeof (t as any)[p] === 'function' ? (...a: unknown[]) => { gcalls.push({ method: p, args: a }); return (t as any)[p](...a); } : (t as any)[p]) }) as GoTrueGateway;
  const people = new Map<Who, Person>(); const profiles = new Map<string, Profile>(); const sessions: SessRow[] = []; const factors: FactorRow[] = [];
  const mfaRequired = new Set<string>();           // membership ids whose role requires MFA
  const writes: Write[] = []; const order: string[] = []; let seq = 0; let pending: Array<{ w: Write; undo?: () => void }> = [];
  let n = 0x7000;
  const rec = (m: string, arg: unknown, undo?: () => void) => { const w: Write = { seq: seq++, m, arg, committed: false }; writes.push(w); pending.push({ w, ...(undo ? { undo } : {}) }); order.push(m); };
  const live = (s: SessRow) => s.state !== 'revoked' && s.state !== 'expired';
  const mine = (s: { tenant_id: string; user_id: string }, t: string, u: string) => s.tenant_id === t && s.user_id === u;
  const fail = { enabled: {} as Record<string, Error | undefined> };
  const minLength = { value: 12 as number | undefined };

  const repo = {
    async getProfile(_tx: unknown, t: string, a: { membershipId: string; userId: string; actorType: string }) { order.push('getProfile'); const p = profiles.get(a.membershipId); const owner = [...people.values()].find((x) => x.membershipId === a.membershipId); return p && owner && p.userId === a.userId && owner.tenantId === t ? { ...p, roles: p.roles.map((r) => ({ ...r })), centreIds: [...p.centreIds], hasVerifiedFactor: factors.some((f) => f.user_id === p.userId && f.status === 'verified') } : undefined; },
    async listOwnSessions(_tx: unknown, t: string, a: { userId: string; limit: number; after?: { at: string; id: string } }) {
      order.push('listOwnSessions'); const af = a.after && { at: Date.parse(a.after.at), id: a.after.id };
      return sessions.filter((s) => mine(s, t, a.userId) && live(s) && (!af || s.last_seen_at.getTime() < af.at || (s.last_seen_at.getTime() === af.at && s.id < af.id)))
        .sort((x, y) => (x.last_seen_at.getTime() === y.last_seen_at.getTime() ? (x.id < y.id ? 1 : -1) : y.last_seen_at.getTime() - x.last_seen_at.getTime())).slice(0, a.limit).map((s) => ({ ...s }));
    },
    async findOwnSession(_tx: unknown, t: string, a: { userId: string; sessionId: string }) { order.push('findOwnSession'); const s = sessions.find((x) => x.id === a.sessionId && mine(x, t, a.userId)); return s && { ...s }; },
    async revokeSession(_tx: unknown, t: string, a: { sessionId: string; reason: string; at: Date; actorId: string }) {
      const s = sessions.find((x) => x.id === a.sessionId && x.tenant_id === t); const before = s && { ...s };
      rec('revokeSession', { t, ...a }, () => { if (s && before) Object.assign(s, before); }); if (s && live(s)) { s.state = 'revoked'; s.revoke_reason = a.reason; }
    },
    async revokeOtherSessions(_tx: unknown, a: { tenantId: string; userId: string; exceptSessionId: string; reason: string; actorId: string }) {
      const hit = sessions.filter((s) => mine(s, a.tenantId, a.userId) && s.id !== a.exceptSessionId && live(s)); const before = hit.map((s) => ({ ...s }));
      rec('revokeOtherSessions', a, () => { hit.forEach((s, i) => Object.assign(s, before[i])); }); hit.forEach((s) => { s.state = 'revoked'; s.revoke_reason = a.reason; });
      return hit.map((s) => ({ sessionId: s.id, kind: s.kind }));
    },
    async listOwnFactors(_tx: unknown, t: string, a: { userId: string }) { order.push('listOwnFactors'); return factors.filter((f) => mine(f, t, a.userId) && f.status !== 'removed').map((f) => ({ ...f })); },
    async findOwnFactor(_tx: unknown, t: string, a: { userId: string; factorId: string }) { order.push('findOwnFactor'); const f = factors.find((x) => x.id === a.factorId && mine(x, t, a.userId)); return f && { ...f }; },
    async roleRequiresMfa(_tx: unknown, _t: string, a: { membershipId: string }) { order.push('roleRequiresMfa'); return mfaRequired.has(a.membershipId); },
    async markFactorRemoved(_tx: unknown, t: string, a: { factorId: string; reason: string; at: Date; actorId: string }) {
      const f = factors.find((x) => x.id === a.factorId && x.tenant_id === t); const before = f && { ...f };
      rec('markFactorRemoved', { t, ...a }, () => { if (f && before) Object.assign(f, before); }); if (f) { f.status = 'removed'; f.removal_reason = a.reason; }
    },
    async enqueue(_tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string) { rec('enqueue', { identifier, payload, jobKey }); },
    /** identity.tenant_settings.password_min_length of the tenant; `world.minLength.value = undefined` = no settings row (the service must fail closed) */
    async passwordMinLength(_tx: unknown, _t: string) { order.push('passwordMinLength'); return minLength.value; },
  };
  for (const m of Object.keys(repo) as Array<keyof typeof repo>) { const f = repo[m] as any; (repo as any)[m] = async (...a: unknown[]) => { if (fail.enabled[m]) throw fail.enabled[m]; return f(...a); }; }
  const events = { async recordTenant(_tx: unknown, e: any) { rec('recordTenant', e); } };
  const breached = { isBreached: vi.fn(async (_tx: unknown, sha1: Buffer) => o.breached?.(sha1) ?? false) };
  const audit = vi.fn(async (_e: Record<string, unknown>) => undefined);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = { repo, gotrue, breached, events, newId: () => idN(n++) };

  /** the request-tx envelope: COMMIT on resolve; on reject only when the handler called commitOnError() (P-42), else every write is undone (rollback) */
  let committedFlag = false;
  async function envelope<T>(fn: () => Promise<T>, commitOnErrorCalled: () => boolean): Promise<T> {
    pending = []; committedFlag = false;
    try { const r = await fn(); for (const p of pending) p.w.committed = true; return r; }
    catch (e) { if (commitOnErrorCalled()) { for (const p of pending) p.w.committed = true; } else for (const p of [...pending].reverse()) p.undo?.(); throw e; }
    finally { pending = []; }
  }
  const committed = (m?: string) => writes.filter((w) => w.committed && (!m || w.m === m));
  const eventsOf = (type: string) => committed('recordTenant').map((w) => w.arg).filter((e) => e.eventType === type);
  const otherWrites = (allowed: string[]) => committed().filter((w) => !allowed.includes(w.m)).map((w) => w.m);

  /** a person with a GoTrue user + password and a profile row. `ME`/`OTHER`: tenant A staff; `P1`/`P2`: tenant A partner members; `B`: tenant B staff. */
  async function addPerson(key: Who, a: { password?: string; mfaVerified?: boolean } = {}) {
    const type = key === 'P1' || key === 'P2' ? 'partner' : 'user'; const tenantId = key === 'B' ? TENANT_B : TENANT_A;
    const email = `t10-${key.toLowerCase()}@lims-test.example`; const u = await fake.adminCreateUser({ email, emailConfirm: true }); const userId = (u as any).userId as string;
    const password = a.password ?? OLD_PW; await fake.adminUpdatePassword(userId, password);
    const p: Person = { key, userId, membershipId: idN(0x500 + people.size), tenantId, type, email, displayName: `Demo ${key}`, password, ...(type === 'partner' ? { partnerRole: key === 'P1' ? 'partner_admin' : 'partner_member' } : {}) };
    people.set(key, p);
    profiles.set(p.membershipId, { membershipId: p.membershipId, userId, email, displayName: p.displayName, hasVerifiedFactor: false, lastLoginAt: new Date('2026-11-05T04:15:00.000Z'),
      roles: [{ role_id: idN(0x600 + people.size), code: type === 'partner' ? p.partnerRole! : 'tenant_admin', name: type === 'partner' ? 'Partner' : 'Tenant admin' }],
      permissions: ['identity.self.manage'], allCentres: type === 'user' && key !== 'B', centreIds: type === 'user' && key === 'B' ? [idN(0x700)] : [] });
    if (a.mfaVerified) addFactor(key, { status: 'verified' });
    return p;
  }
  /** an identity.sessions row of that person (default: live, kind by person type). `current` ids are given to ctx.sessionId by `ctxFor`. */
  function addSession(key: Who, a: Partial<SessRow> = {}): SessRow {
    const p = people.get(key)!; const row: SessRow = { id: idN(n++), tenant_id: p.tenantId, kind: p.type === 'partner' ? 'partner' : 'tenant_staff', user_id: p.userId, membership_id: p.membershipId, display_name: p.displayName,
      state: 'active', aal: 'aal2', created_at: NOW, last_seen_at: NOW, idle_expires_at: new Date(NOW.getTime() + 900_000), absolute_expires_at: new Date(NOW.getTime() + 28_800_000),
      client_ip: '203.0.113.9', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0', support_session_id: null,
      token_sha256: SECRET, refresh_token_enc: SECRET, access_token_enc: SECRET, enc_key_id: SECRET, gotrue_session_id: idN(n++), ...a };
    sessions.push(row); return row;
  }
  function addFactor(key: Who, a: Partial<FactorRow> = {}): FactorRow {
    const p = people.get(key)!; const f: FactorRow = { id: idN(n++), tenant_id: p.tenantId, user_id: p.userId, gotrue_factor_id: idN(n++), friendly_name: 'Work phone', status: 'verified', verified_at: new Date('2026-11-05T04:15:00.000Z'), ...a };
    factors.push(f); return f;
  }
  /** ctx for `key`; `sessionId` = the caller's CURRENT session (create one first with addSession) */
  function ctxFor(key: Who, current: { id: string }, c: Record<string, unknown> = {}) {
    const p = people.get(key)!; const commitOnError = vi.fn(() => { order.push('commitOnError'); });
    const ctx: any = { tenantId: p.tenantId, actor: { type: p.type, id: p.userId, membershipId: p.membershipId }, sessionId: current.id, aal: 'aal2', ...(p.partnerRole ? { partnerRole: p.partnerRole } : {}),
      requestId: REQ_ID, clientIp: CLIENT_IP, tx: { __tx: 'T10-request-tx', query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }, now: () => NOW, log, commitOnError, audit: { access: audit }, ...c };
    return { ctx, commitOnError };
  }
  /** run one service operation inside the envelope; resolves with the service result or rejects with its error */
  function run<T>(fn: (ctx: any) => Promise<T>, key: Who, current: { id: string }, c: Record<string, unknown> = {}) {
    const { ctx, commitOnError } = ctxFor(key, current, c);
    return { ctx, commitOnError, promise: envelope(() => fn(ctx), () => commitOnError.mock.calls.length > 0) };
  }
  return { minLength, fake, gotrue, gcalls, people, profiles, sessions, factors, mfaRequired, repo, events, breached, audit, log, deps, writes, order, fail, committed, eventsOf, otherWrites, addPerson, addSession, addFactor, ctxFor, run, envelope, committedFlag: () => committedFlag };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;

/** every string the sinks (logs, access-log, events, jobs, writes) hold, for secret-leak checks */
export const sinks = (w: World) => JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.audit.mock.calls, w.writes.map((x) => x.arg)]);
/** what a client sees of an error */
export const errBody = (e: any) => JSON.stringify({ code: e.code, message: e.message, detail: e.detail ?? null, errors: e.errors ?? null, status: e.statusCode });
