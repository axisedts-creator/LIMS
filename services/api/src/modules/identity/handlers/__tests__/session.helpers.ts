// T8 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute.
//
// Files under test (plan row T8): service/session.service.ts, handlers/resolveSession.ts, handlers/logoutSession.ts. Same shape as T7 (mfa.helpers.ts):
//   handlers/resolveSession.ts  resolveSession (wired Handler) + createResolveSession(deps)
//   handlers/logoutSession.ts   logoutSession  (wired Handler) + createLogoutSession(deps)
//   service/session.service.ts  the logic both factories call (exports createSessionService; its shape is NOT pinned, only that the file exists)
//   deps = { gotrue: Pick<GoTrueGateway,'refresh'>, repo: SessionRepo, events: {recordTenantless, recordTenant} (= createAuthEventsRepo), hmac?, newId?, now? }
//   Constants (02-TRD s11 / s12): touch interval 60 s (LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS), refresh window 120 s. Tests use the defaults.
//   Handler call = (req, hctx), hctx as in T7 (ctx.db.identityAuthTx, commitOnError, clientIp, requestId, bffKey, actor, log). Cookie `__Host-lims_sid=<43 chars>` in req.headers.cookie.
//   bffKey binds the kind (AU-T13): tenant_staff + platform -> 'staff_web', partner -> 'partner'; patient / staff_mobile are never served here; anything else -> 401 auth.session_expired.
//   Returns: resolveSession { status: 200, body: ResolvedSession }; logoutSession { status: 204, body: undefined }.
//   SessionRepo = the T7 MfaRepo methods (sessionByToken, loadSession, updateSession, enqueue; mfa.repo.ts may be extended - the writer picks the file) PLUS these seams:
//     sessionByToken(tx, sha256: Buffer)  -> undefined | { sessionId, kind, state, tenantId|null, userId, membershipId|null, platformStaffId|null, tokenReused }   (state may be 'revoked'/'expired': the handler must check it)
//     loadSession(tx, ref {sessionId, tenantId|null, userId, kind})  -> T7 fields + { state, lastSeenAt, idleTimeoutMinutes, membershipLocked, tenantStatus }   FOR UPDATE inside (the row lock)
//     updateSession(tx, ref, patch)   patch keys as T7: state?, aal?, accessToken?+refreshToken? (together), accessExpiresAt?, revoked? { reason: 'logout' | 'refresh_failed' | ... }, actorId
//     touchSession(tx, ref, { lastSeenAt: Date, idleExpiresAt: Date, actorId })                         (SS: last_seen_at = now, idle_expires_at = now + idle_timeout_minutes)
//     expireSession(tx, ref, { reason: 'idle' | 'absolute', actorId })                                   (SS10: UPDATE ... WHERE state NOT IN ('revoked','expired'))
//     enqueue(tx, taskIdentifier, payload, jobKey)                                                        (identity.gotrue_signout)
//   Events (AuthEvent shape = auth.helpers.ts): session_expired_idle / session_expired_absolute (lazy expiry), refresh_failed (+ session revoked, reason refresh_failed), logout.
//   Tenant kinds: tx.bindTenant(session.tenantId) once, after sessionByToken, before loadSession; events -> recordTenant. Platform kind: no bindTenant, events -> recordTenantless.
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { EMAIL, HMAC_KEY, MEMB_A, REQ_ID, START, STAFF_ID, SYSTEM_ACTOR, TENANT_A, hmacHex, idN, rejection } from '../../service/__tests__/auth.helpers.js';

export { EMAIL, HMAC_KEY, MEMB_A, REQ_ID, STAFF_ID, SYSTEM_ACTOR, TENANT_A, hmacHex, idN, rejection, LimsError };
export const CLIENT_IP = '203.0.113.9';
export const COOKIE = '__Host-lims_sid';
export const MIN = 60_000, HOUR = 3_600_000;
export const OLD_ACCESS = 'ACCESS-OLD-SENTINEL-a1b2', OLD_REFRESH = 'REFRESH-OLD-SENTINEL-c3d4';
export const sha256 = (s: string) => createHash('sha256').update(s).digest();
export const tokenN = (n: number) => `S${n.toString(36).padStart(42, '0')}`;      // 43 chars base64url-safe

export type Kind = 'tenant_staff' | 'platform' | 'partner' | 'patient' | 'staff_mobile';
export interface Row {
  sessionId: string; kind: Kind; state: string; tenantId: string | null; userId: string; membershipId: string | null; platformStaffId: string | null; tokenReused: boolean;
  aal: 'aal1' | 'aal2'; accessToken: string; refreshToken: string; mfaFailedAttempts: number; email: string; accessExpiresAt: Date; idleExpiresAt: Date; absoluteExpiresAt: Date;
  lastSeenAt: Date; idleTimeoutMinutes: number; membershipLocked: boolean; tenantStatus: string | null; revokeReason?: string; expiredReason?: string;
}
export interface Write { seq: number; m: string; arg: any; committed: boolean }
type TxObj = { query: ReturnType<typeof vi.fn>; bindTenant: ReturnType<typeof vi.fn> };

/** In-memory SessionRepo + events + an identityAuthTx envelope with REAL commit/rollback AND a per-session row lock (FOR UPDATE emulation).
 *  Mutations are applied at COMMIT (an uncommitted write is invisible to other transactions); a write is `committed` only when the tx callback RETURNS (P-42 oracle). */
export function makeStore(clock: { ms: number }) {
  const sessions = new Map<string, Row>();                       // key: sha256 hex of the cookie token
  const writes: Write[] = []; const order: string[] = []; let seq = 0;
  const pending = new Map<object, Array<{ w: Write; apply?: () => void }>>();
  const tails = new Map<string, Promise<void>>(); const held = new Map<object, Array<() => void>>(); const heldIds = new Map<object, Set<string>>();
  const same = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);
  const byId = (id: string) => [...sessions.values()].find((s) => s.sessionId === id);
  const rec = (tx: object, m: string, arg: unknown, apply?: () => void) => {
    const w: Write = { seq: seq++, m, arg, committed: false }; writes.push(w); order.push(m);
    const l = pending.get(tx) ?? []; l.push({ w, ...(apply ? { apply } : {}) }); pending.set(tx, l);
  };
  const terminal = (s: Row) => s.state === 'revoked' || s.state === 'expired';

  const repo = {
    async sessionByToken(_tx: unknown, sha: Buffer) {
      order.push('sessionByToken'); const s = sessions.get(sha.toString('hex')); if (!s) return undefined;
      return { sessionId: s.sessionId, kind: s.kind, state: s.state, tenantId: s.tenantId, userId: s.userId, membershipId: s.membershipId, platformStaffId: s.platformStaffId, tokenReused: s.tokenReused };
    },
    async loadSession(tx: object, ref: { sessionId: string; tenantId: string | null; userId: string; kind: string }) {
      order.push('loadSession');
      const ids = heldIds.get(tx) ?? new Set<string>(); heldIds.set(tx, ids);
      if (!ids.has(ref.sessionId)) {                                       // FOR UPDATE: wait for the previous holder's COMMIT/ROLLBACK
        const prev = tails.get(ref.sessionId) ?? Promise.resolve(); let release!: () => void; const mine = new Promise<void>((r) => { release = r; });
        tails.set(ref.sessionId, prev.then(() => mine)); await prev; ids.add(ref.sessionId); (held.get(tx) ?? held.set(tx, []).get(tx)!).push(release);
      }
      await new Promise((r) => setImmediate(r));                          // let parallel requests interleave
      const s = byId(ref.sessionId);
      if (!s || !same(s.tenantId, ref.tenantId) || s.userId !== ref.userId) return undefined;
      return { state: s.state, aal: s.aal, accessToken: s.accessToken, refreshToken: s.refreshToken, mfaFailedAttempts: s.mfaFailedAttempts, email: s.email, accessExpiresAt: s.accessExpiresAt,
        idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt, lastSeenAt: s.lastSeenAt, idleTimeoutMinutes: s.idleTimeoutMinutes, membershipLocked: s.membershipLocked, tenantStatus: s.tenantStatus };
    },
    async updateSession(tx: object, ref: { sessionId: string }, patch: any) {
      rec(tx, 'updateSession', { ref, patch }, () => {
        const s = byId(ref.sessionId); if (!s) return;
        for (const k of ['state', 'aal', 'accessToken', 'refreshToken', 'accessExpiresAt', 'mfaFailedAttempts'] as const) if (patch[k] !== undefined) (s as any)[k] = patch[k];
        if (patch.revoked) { s.state = 'revoked'; s.revokeReason = patch.revoked.reason; }
      });
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
  /** the identityAuthTx envelope: apply + mark committed on return, drop on throw; the row locks are released either way */
  async function envelope<T>(tx: object, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn(); for (const p of pending.get(tx) ?? []) { p.w.committed = true; p.apply?.(); } return r;
    } finally { pending.delete(tx); heldIds.delete(tx); for (const rel of held.get(tx) ?? []) rel(); held.delete(tx); }
  }
  const committed = (m?: string) => writes.filter((w) => w.committed && (!m || w.m === m));
  const eventsOf = (type: string) => committed().filter((w) => (w.m === 'recordTenant' || w.m === 'recordTenantless') && w.arg.eventType === type).map((w) => w.arg);
  return { sessions, writes, order, repo, events, envelope, committed, eventsOf, byId, now: () => clock.ms };
}

/** GoTrue refresh stub on the injected clock: every refresh token works ONCE (second use -> reused, like a strict rotating GoTrue); modes simulate revoke / outage. */
export function makeRefresher(clock: { ms: number }) {
  const used = new Set<string>(); const calls: string[] = []; let n = 0; let delayTicks = 2;
  const st = { mode: 'ok' as 'ok' | 'revoked' | 'reused' | 'invalid' | 'down' };
  return {
    st, calls,
    async refresh(rt: string) {
      calls.push(rt); for (let i = 0; i < delayTicks; i++) await new Promise((r) => setImmediate(r));
      if (st.mode === 'down') throw new Error('connect ECONNREFUSED gotrue');
      if (st.mode !== 'ok') return { ok: false as const, reason: st.mode };
      if (used.has(rt)) return { ok: false as const, reason: 'reused' as const };
      used.add(rt); n++;
      return { ok: true as const, tokens: { accessToken: `ACCESS-NEW-${n}`, refreshToken: `REFRESH-NEW-${n}`, expiresAt: Math.floor(clock.ms / 1000) + 3600, sessionId: idN(0x5000 + n), userId: idN(0x6000), aal: 'aal2' as const } };
    },
  };
}

export async function makeSessionWorld() {
  const clock = { ms: START.getTime() };
  const store = makeStore(clock); const gw = makeRefresher(clock);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let n = 0xf000; const txCalls: any[] = []; const txs: TxObj[] = [];
  const deps = { gotrue: { refresh: (rt: string) => gw.refresh(rt) }, repo: store.repo, events: store.events, hmac: (e: string) => hmacHex(e), newId: () => idN(n++), now: () => new Date(clock.ms) };

  /** an identity.sessions row (+ its cookie token). Default: active, aal2, idle 15 min from now, absolute 12 h from now, access JWT valid for 1 h. */
  function addSession(a: Partial<Row> & { token?: string } = {}) {
    const k: Kind = a.kind ?? 'tenant_staff';
    const row: Row = {
      sessionId: idN(n++), kind: k, state: 'active', tenantId: k === 'platform' ? null : TENANT_A, userId: idN(n++), membershipId: k === 'platform' ? null : MEMB_A, platformStaffId: k === 'platform' ? STAFF_ID : null,
      tokenReused: false, aal: 'aal2', accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH, mfaFailedAttempts: 0, email: EMAIL, accessExpiresAt: new Date(clock.ms + HOUR),
      idleExpiresAt: new Date(clock.ms + 15 * MIN), absoluteExpiresAt: new Date(clock.ms + 12 * HOUR), lastSeenAt: new Date(clock.ms), idleTimeoutMinutes: 15,
      membershipLocked: false, tenantStatus: k === 'platform' ? null : 'active', ...a,
    };
    delete (row as any).token; const token = a.token ?? tokenN(n++);
    store.sessions.set(sha256(token).toString('hex'), row);
    return { token, row };
  }

  const keyFor = (k: Kind) => (k === 'partner' ? 'partner' : k === 'tenant_staff' || k === 'platform' ? 'staff_web' : undefined);
  /** hctx as the C0 core builds it for an identity_auth operation; every identityAuthTx call gets its OWN tx object (parallel requests) */
  function makeHctx(c: Record<string, unknown> = {}) {
    const commitOnError = vi.fn(() => { store.order.push('commitOnError'); });
    const forbidden = (nm: string) => () => { throw new Error(`session handlers must not use ctx.db.${nm}`); };
    const hctx: any = { operationId: 'resolveSession', clientIp: CLIENT_IP, requestId: REQ_ID, bffKey: 'staff_web', actor: { type: 'system', id: SYSTEM_ACTOR }, log, commitOnError,
      db: { identityAuthTx: (input: any, fn: any) => {
        txCalls.push(input);
        const tx: TxObj = { query: vi.fn(async (..._a: unknown[]) => ({ rows: [] })), bindTenant: vi.fn(async (id: string) => { if (tx.bindTenant.mock.calls.length > 1) throw new Error('bindTenant called twice (D-212)'); store.order.push(`bindTenant:${id}`); }) };
        txs.push(tx); return store.envelope(tx, () => fn(tx, { noRetry: () => undefined }));
      }, tx: forbidden('tx'), requestTx: forbidden('requestTx'), withTenantScope: forbidden('withTenantScope') }, ...c };
    return { hctx, commitOnError };
  }
  const req = (a: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => ({ params: {}, query: {}, body: a.body,
    headers: { ...(a.token ? { cookie: `theme=dark; ${COOKIE}=${a.token}; other=1` } : {}), 'user-agent': 'Mozilla/5.0 Firefox/130.0', ...(a.headers ?? {}) } });
  const advance = (ms: number) => { clock.ms += ms; };
  return { clock, store, gw, deps, log, txCalls, txs, addSession, makeHctx, req, advance, keyFor };
}
export type SessionWorld = Awaited<ReturnType<typeof makeSessionWorld>>;

/** every string the three sinks (logs, events, writes) hold, for leak checks */
export const sinks = (w: SessionWorld) => JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.filter((x) => x.m !== 'updateSession').map((x) => x.arg)]);
/** writes of the committed set that are NOT in `allowed` (P-42: "no other write of that request survives") */
export const otherWrites = (s: ReturnType<typeof makeStore>, allowed: string[]) => s.committed().filter((w) => !allowed.includes(w.m)).map((w) => w.m);
