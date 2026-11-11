// T31 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute.
// Spec: 02-TRD s4 items 10/11, s5.1; 05-SCHEMA s4.1 (sessions kind CHECKs, previous_token_sha256); 03-APP-FLOW s3.5a; 07-SECURITY AU-T13..AU-T17, AU-T22;
// 08 R10, A3.1 (CR-C2-018), A19 P-42, A25 D-212/P-61; LD-81 (patient access JWT minted by LIMS, no GoTrue for kind patient).
//
// Handler files (plan row T31); each exports the wired `Handler` AND a factory createX(deps) like T8 (resolveSession.ts):
//   handlers/loginPartner.ts          createLoginPartner(deps: AuthDeps)           deps = T6 auth.helpers makeWorld().deps (gotrue, repo, events, limits, hmac, newId, newToken, now?, sleep, alert)
//   handlers/openMobileSession.ts     createOpenMobileSession(deps: AuthDeps)      same deps; repo ALSO has  membershipHasPermission(tx, { tenantId, membershipId, permission }) -> boolean  (called AFTER tx.bindTenant)
//   handlers/refreshMobileSession.ts  createRefreshMobileSession(deps: AppDeps)    body { session_token }                       -> 200 { session_token, access_token, access_expires_at, session_expires_at, session }
//   handlers/logoutMobileSession.ts   createLogoutMobileSession(deps: AppDeps)     body { session_token }                       -> 204
//   handlers/resolvePatientSession.ts createResolvePatientSession(deps: AppDeps)   header X-Lims-Patient-Session, body { touch } -> 200 ResolvedSession (kind patient)
//   handlers/logoutPatientSession.ts  createLogoutPatientSession(deps: AppDeps)    header X-Lims-Patient-Session                 -> 204
//   AppDeps = { gotrue: Pick<GoTrueGateway,'refresh'>, repo: AppSessionRepo, events: {recordTenantless, recordTenant}, hmac?, newId?, newToken?, now?,
//               mintPatientAccessToken({ sub, sessionId, aal, issuedAt: Date, expiresAt: Date }) => string }   (LD-81: the EdDSA signer is a seam here; claims are exactly these five)
//   Call = (req, hctx) with hctx as in session.helpers.ts (ctx.db.identityAuthTx only; ctx.bffKey, commitOnError, clientIp, requestId, actor, log). One identityAuthTx per request.
//   AppSessionRepo = T8 SessionRepo (sessionByToken, loadSession, updateSession, touchSession, expireSession, enqueue) PLUS
//        rotateToken(tx, ref, { tokenSha256: Buffer, previousTokenSha256: Buffer, actorId }) -> boolean   token_sha256 := new, previous_token_sha256 := old (CR-C2-018; one previous kept)
//      false (0 rows matched the token_sha256 = old guard: a parallel refresh won the race) is treated as reuse, called BEFORE the GoTrue refresh (no refresh token is spent)
//      and loadSession additionally returns { appInstanceId, appPlatform }. sessionByToken behaves like app.identity_session_by_token: a token matching previous_token_sha256 of a
//      NON-terminal session returns tokenReused = true; the current token matches in every state.
//   Kind <-> endpoint family (AU-T13): refreshMobileSession / logoutMobileSession serve kind staff_mobile ONLY; resolvePatientSession / logoutPatientSession serve kind patient ONLY;
//      a kind mismatch is 401 auth.session_expired and changes NOTHING (no revoke, no event, no write). tenant kinds: tx.bindTenant(session.tenant_id) once, after sessionByToken, before loadSession.
//   Reuse (AU-T15 / P-42): a rotated-out token -> updateSession { revoked: { reason: 'token_reuse' } } + recordTenant event session_token_reused + ctx.commitOnError() + 401 auth.session_expired;
//      only that revoke, the event and (staff_mobile only) an identity.gotrue_signout job are written. Patient: NO GoTrue sign-out job (LD-81).
//   loginPartner row seam: app.identity_login_context row gains actor_type ('user' | 'partner') and partner_role; loginPartner accepts ONLY actor_type 'partner' (else auth.login_failed).
//      [SPEC GAP, see notes/T31-tests.md] 05-SCHEMA s6 does not say the DEFINER returns partner memberships; the writer extends it or raises a CR.
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { START, SYSTEM_ACTOR, REQ_ID, TENANT_A, MEMB_A, idN, rejection, makeWorld, tenantRow, type LoginRow } from '../../service/__tests__/auth.helpers.js';

export { START, SYSTEM_ACTOR, REQ_ID, TENANT_A, MEMB_A, idN, rejection, makeWorld, tenantRow, LimsError };
export const CLIENT_IP = '203.0.113.9';
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const sha = (s: string) => createHash('sha256').update(s).digest();
export const tokenN = (n: number) => `S${n.toString(36).padStart(42, '0')}`;   // 43 chars base64url-safe
export const OLD_ACCESS = 'ACCESS-OLD-SENTINEL-a1b2', OLD_REFRESH = 'REFRESH-OLD-SENTINEL-c3d4';
export const APP_INSTANCE = idN(0x7001);

/* ------------------------------------------------------------------ login handlers (loginPartner / openMobileSession) */
export const partnerRow = (o: LoginRow = {}): LoginRow => tenantRow({ actor_type: 'partner', partner_role: 'partner_admin', idle_timeout_minutes: 30, absolute_session_hours: 12, ...o });
export const staffRow = (o: LoginRow = {}): LoginRow => tenantRow({ actor_type: 'user', ...o });

/** run a login-style handler in an identityAuthTx envelope that tracks which transactions COMMITTED (a tx commits when the callback returns, rolls back when it throws: P-42 oracle). */
export function loginRunner(w: ReturnType<typeof makeWorld>, key: string | undefined) {
  const committedTxs = new Set<unknown>(); const txCalls: any[] = []; const ctxs: any[] = [];
  const hctx: any = {
    operationId: 'x', clientIp: CLIENT_IP, requestId: REQ_ID, ...(key ? { bffKey: key } : {}), actor: { type: 'system', id: SYSTEM_ACTOR }, log: w.log, rateLimit: undefined,
    commitOnError: vi.fn(() => { w.repo.order.push('commitOnError'); }),
    db: { identityAuthTx: async (input: any, fn: any) => {
      txCalls.push(input);
      const { tx } = w.makeCtx();
      ctxs.push(tx);
      const r = await fn(tx, { noRetry: () => undefined }); committedTxs.add(tx); return r;
    }, tx: () => { throw new Error('login handlers must use identityAuthTx only'); }, requestTx: () => { throw new Error('requestTx'); }, withTenantScope: () => { throw new Error('withTenantScope'); } },
  };
  const req = (body: unknown, headers: Record<string, string> = {}) => ({ params: {}, query: {}, body, headers: { 'user-agent': 'Mozilla/5.0 Firefox/130.0', ...headers } });
  // committed writes = writes made on a tx that ended by RETURNING (the handler returns { err } out of the tx after commitOnError)
  const committed = () => w.repo.writes.filter((x) => committedTxs.has(x.tx));
  return { hctx, req, txCalls, committed, committedTxs, ctxs };
}

/* ------------------------------------------------------------------ app-token sessions (staff_mobile / patient) */
export type AppKind = 'staff_mobile' | 'patient' | 'tenant_staff' | 'partner';
export interface AppRow {
  sessionId: string; kind: AppKind; state: string; tenantId: string; userId: string; membershipId: string; tokenHex: string; prevHex: string | null;
  aal: 'aal1' | 'aal2'; appInstanceId: string | null; appPlatform: string | null; accessToken: string | null; refreshToken: string | null; accessExpiresAt: Date | null;
  idleExpiresAt: Date; absoluteExpiresAt: Date; lastSeenAt: Date; idleTimeoutMinutes: number; membershipLocked: boolean; tenantStatus: string; mfaFailedAttempts: number; email: string;
  revokeReason?: string; expiredReason?: string;
}
interface W { seq: number; m: string; arg: any; committed: boolean }

export async function makeAppWorld() {
  const clock = { ms: START.getTime() };
  const rows = new Map<string, AppRow>();
  const writes: W[] = []; const order: string[] = []; let seq = 0; let n = 0xf100;
  const pending = new Map<object, Array<{ w: W; apply?: () => void }>>();
  const tails = new Map<string, Promise<void>>(); const held = new Map<object, Array<() => void>>(); const heldIds = new Map<object, Set<string>>();
  const byId = (id: string) => [...rows.values()].find((r) => r.sessionId === id);
  const terminal = (r: AppRow) => r.state === 'revoked' || r.state === 'expired';
  const rec = (tx: object, m: string, arg: unknown, apply?: () => void) => {
    const w: W = { seq: seq++, m, arg, committed: false }; writes.push(w); order.push(m);
    const l = pending.get(tx) ?? []; l.push({ w, ...(apply ? { apply } : {}) }); pending.set(tx, l);
  };
  const rot = { miss: false };   // test switch: the rotateToken guard matches 0 rows
  const repo = {
    async sessionByToken(_tx: unknown, sha256: Buffer) {
      order.push('sessionByToken'); const hex = sha256.toString('hex');
      const cur = [...rows.values()].find((r) => r.tokenHex === hex);
      const prev = cur ? undefined : [...rows.values()].find((r) => r.prevHex === hex && !terminal(r));   // DEFINER: previous token only while the session is live
      const r = cur ?? prev; if (!r) return undefined;
      return { sessionId: r.sessionId, kind: r.kind, state: r.state, tenantId: r.tenantId, userId: r.userId, membershipId: r.membershipId, platformStaffId: null, tokenReused: !cur };
    },
    async loadSession(tx: object, ref: { sessionId: string; tenantId: string | null; userId: string }) {
      order.push('loadSession');
      const ids = heldIds.get(tx) ?? new Set<string>(); heldIds.set(tx, ids);
      if (!ids.has(ref.sessionId)) {
        const prev = tails.get(ref.sessionId) ?? Promise.resolve(); let release!: () => void; const mine = new Promise<void>((r) => { release = r; });
        tails.set(ref.sessionId, prev.then(() => mine)); await prev; ids.add(ref.sessionId); (held.get(tx) ?? held.set(tx, []).get(tx)!).push(release);
      }
      await new Promise((r) => setImmediate(r));
      const s = byId(ref.sessionId);
      if (!s || s.tenantId !== ref.tenantId || s.userId !== ref.userId) return undefined;   // lookup keyed on (id, sub) for patient (LD-81)
      return { state: s.state, aal: s.aal, accessToken: s.accessToken, refreshToken: s.refreshToken, mfaFailedAttempts: s.mfaFailedAttempts, email: s.email, accessExpiresAt: s.accessExpiresAt,
        idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt, lastSeenAt: s.lastSeenAt, idleTimeoutMinutes: s.idleTimeoutMinutes, membershipLocked: s.membershipLocked,
        tenantStatus: s.tenantStatus, appInstanceId: s.appInstanceId, appPlatform: s.appPlatform };
    },
    async updateSession(tx: object, ref: { sessionId: string }, patch: any) {
      rec(tx, 'updateSession', { ref, patch }, () => {
        const s = byId(ref.sessionId); if (!s) return;
        for (const k of ['state', 'aal', 'accessToken', 'refreshToken', 'accessExpiresAt'] as const) if (patch[k] !== undefined) (s as any)[k] = patch[k];
        if (patch.revoked) { s.state = 'revoked'; s.revokeReason = patch.revoked.reason; }
      });
    },
    // returns true = the guarded UPDATE (WHERE token_sha256 = old) matched a row; false = 0 rows (a parallel refresh already rotated the token: lost race = reuse, AU-T15)
    async rotateToken(tx: object, ref: { sessionId: string }, a: { tokenSha256: Buffer; previousTokenSha256: Buffer; actorId: string }): Promise<boolean> {
      if (rot.miss) return false;
      rec(tx, 'rotateToken', { ref, ...a }, () => { const s = byId(ref.sessionId); if (s) { s.tokenHex = a.tokenSha256.toString('hex'); s.prevHex = a.previousTokenSha256.toString('hex'); } });
      return true;
    },
    async touchSession(tx: object, ref: { sessionId: string }, a: { lastSeenAt: Date; idleExpiresAt: Date; actorId: string }) {
      rec(tx, 'touchSession', { ref, ...a }, () => { const s = byId(ref.sessionId); if (s) { s.lastSeenAt = a.lastSeenAt; s.idleExpiresAt = a.idleExpiresAt; } });
    },
    async expireSession(tx: object, ref: { sessionId: string }, a: { reason: 'idle' | 'absolute'; actorId: string }) {
      rec(tx, 'expireSession', { ref, ...a }, () => { const s = byId(ref.sessionId); if (s && !terminal(s)) { s.state = 'expired'; s.expiredReason = a.reason; } });
    },
    async enqueue(tx: object, identifier: string, payload: Record<string, unknown>, jobKey: string) { rec(tx, 'enqueue', { identifier, payload, jobKey }); },
  };
  const events = {
    async recordTenantless(tx: object, e: any) { rec(tx, 'recordTenantless', e); },
    async recordTenant(tx: object, e: any) { rec(tx, 'recordTenant', e); },
  };
  async function envelope<T>(tx: object, fn: () => Promise<T>): Promise<T> {
    try { const r = await fn(); for (const p of pending.get(tx) ?? []) { p.w.committed = true; p.apply?.(); } return r; }
    finally { pending.delete(tx); heldIds.delete(tx); for (const rel of held.get(tx) ?? []) rel(); held.delete(tx); }
  }
  const committed = (m?: string) => writes.filter((w) => w.committed && (!m || w.m === m));
  const eventsOf = (type: string) => committed().filter((w) => (w.m === 'recordTenant' || w.m === 'recordTenantless') && w.arg.eventType === type).map((w) => w.arg);

  // GoTrue refresh stub (staff_mobile only): every refresh token works once
  const gtCalls: string[] = []; let gn = 0;
  const gotrue = { async refresh(rt: string) {
    gtCalls.push(rt); await new Promise((r) => setImmediate(r)); gn++;
    return { ok: true as const, tokens: { accessToken: `ACCESS-NEW-${gn}`, refreshToken: `REFRESH-NEW-${gn}`, expiresAt: Math.floor(clock.ms / 1000) + 3600, sessionId: idN(0x5000 + gn), userId: idN(0x6000), aal: 'aal2' as const } };
  } };
  const gt = { st: { refuse: false as boolean }, calls: gtCalls };
  const gotrueWrapped = { async refresh(rt: string) { if (gt.st.refuse) { gtCalls.push(rt); return { ok: false as const, reason: 'revoked' as const }; } return gotrue.refresh(rt); } };

  const mint = vi.fn((c: { sub: string; sessionId: string; aal: string; issuedAt: Date; expiresAt: Date }) => `PAT-JWT.${c.sessionId}.${c.expiresAt.getTime()}`);
  const deps = { gotrue: gotrueWrapped, repo, events, hmac: (e: string) => `hmac(${e})`, newId: () => idN(n++), newToken: () => tokenN(0x900 + n++), now: () => new Date(clock.ms), mintPatientAccessToken: mint };

  /** an identity.sessions row + its opaque token. kind default staff_mobile: no idle timeout (idle = absolute, 12 h = 720 min), GoTrue tokens present. patient: idle 14 d, abs 30 d, aal1, NO gotrue/access/refresh (LD-81). */
  function addSession(a: Partial<AppRow> & { token?: string } = {}) {
    const kind: AppKind = a.kind ?? 'staff_mobile';
    const patient = kind === 'patient';
    const token = a.token ?? tokenN(n++);
    const row: AppRow = {
      sessionId: idN(n++), kind, state: 'active', tenantId: TENANT_A, userId: idN(n++), membershipId: MEMB_A, tokenHex: sha(token).toString('hex'), prevHex: null,
      aal: patient ? 'aal1' : 'aal2', appInstanceId: kind === 'staff_mobile' || patient ? APP_INSTANCE : null, appPlatform: kind === 'staff_mobile' || patient ? 'android' : null,
      accessToken: patient ? null : OLD_ACCESS, refreshToken: patient ? null : OLD_REFRESH, accessExpiresAt: patient ? null : new Date(clock.ms + HOUR),
      idleExpiresAt: new Date(clock.ms + (patient ? 14 * DAY : 12 * HOUR)), absoluteExpiresAt: new Date(clock.ms + (patient ? 30 * DAY : 12 * HOUR)), lastSeenAt: new Date(clock.ms),
      idleTimeoutMinutes: patient ? 20160 : kind === 'staff_mobile' ? 720 : 15, membershipLocked: false, tenantStatus: 'active', mfaFailedAttempts: 0, email: 'ana.demo@example.test', ...a,
    };
    delete (row as any).token; rows.set(row.sessionId, row);
    return { token, row };
  }

  function makeHctx(c: Record<string, unknown> = {}) {
    const commitOnError = vi.fn(() => { order.push('commitOnError'); });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hctx: any = { operationId: 'x', clientIp: CLIENT_IP, requestId: REQ_ID, actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError,
      db: { identityAuthTx: (input: any, fn: any) => {
        txCalls.push(input);
        const tx: any = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async (id: string) => { if (tx.bindTenant.mock.calls.length > 1) throw new Error('bindTenant called twice (D-212)'); order.push(`bindTenant:${id}`); }) };
        return envelope(tx, () => fn(tx, { noRetry: () => undefined }));
      }, tx: () => { throw new Error('ctx.db.tx'); }, requestTx: () => { throw new Error('requestTx'); }, withTenantScope: () => { throw new Error('withTenantScope'); } }, ...c };
    return { hctx, commitOnError, log };
  }
  const txCalls: any[] = [];
  const req = (a: { body?: unknown; token?: string; as?: 'body' | 'cookie' | 'patient-header'; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 Firefox/130.0', ...(a.headers ?? {}) };
    if (a.token && a.as === 'patient-header') headers['x-lims-patient-session'] = a.token;
    if (a.token && a.as === 'cookie') headers['cookie'] = `__Host-lims_sid=${a.token}`;
    return { params: {}, query: {}, body: a.as === 'body' ? { session_token: a.token, ...(a.body as object ?? {}) } : a.body, headers };
  };
  return { rot, clock, rows, writes, order, repo, events, deps, committed, eventsOf, byId, addSession, makeHctx, req, gt, mint, txCalls, advance: (ms: number) => { clock.ms += ms; } };
}
export type AppWorld = Awaited<ReturnType<typeof makeAppWorld>>;
/** committed writes whose method is NOT in `allowed` (P-42 "no other write of that request survives") */
export const otherWrites = (w: AppWorld, allowed: string[]) => w.committed().filter((x) => !allowed.includes(x.m)).map((x) => x.m);
export { rejection as rej };
