// POST /v1/identity/auth/login (02-TRD §5.1; x-context identity_auth, x-idempotency none, rate tier login). Behaviour: service/auth.service.ts.
// One ctx.db.identityAuthTx per request (08 A25 D-212); client IP = ctx.clientIp only (P-61). A 4xx after ctx.commitOnError() is
// returned out of the tx callback so the tx COMMITs its auth event / job / throttle writes, and re-thrown afterwards (08 A19 P-42).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { TxFn, TxInput } from '../../../core/db/tx.js';
import { gotrueGatewayFromEnv } from '../gotrue/gateway.http.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { createAuthEventsRepo, createAuthRepo } from '../repository/auth-events.repo.js';
import { createAuthService, type AuthCtx, type AuthDeps, type AuthLimits } from '../service/auth.service.js';
import { idMetrics } from '../metrics.js';

export interface LoginHctx extends HandlerContext {
  requestId: string; bffKey?: string; actor?: { type: string; id: string }; commitOnError?: () => void;
  rateLimit?: { consume(tier: 'login', key: string): Promise<void> };
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}

const H = 3_600_000;

// ---------- AuthLimits adapter ----------
// a:<hmac> 10/h is C0's `login` rule (ctx.rateLimit.consume). C0 has no `f:` rule and no non-consuming read (core/ratelimit RULES), so the
// failure windows below are process-local (.orchestra/cr/T6.md).
// ponytail: per-instance Maps; N API instances = N x the thresholds and a restart forgets them. Move to the C0 store when the CR lands.
const fails = new Map<string, number[]>();      // a:<hmac> failure times, sliding 60 min (03-APP-FLOW §3.3)
const ipFails = new Map<string, number[]>();    // f:<ip> failure times, sliding 10 min (08 A1)
const ipAttempts = new Map<string, number[]>(); // f:<ip> attempts while throttled, sliding 60 s
const ipUntil = new Map<string, number>();      // f:<ip> throttle end
const ipLast = new Map<string, number>();       // f:<ip> last failure (T28 stuffing gauge, 15 min)
const MAX_KEYS = 100_000;

function window(m: Map<string, number[]>, key: string, now: number, ms: number): number[] {
  const a = (m.get(key) ?? []).filter((t) => t > now - ms);
  if (a.length) m.set(key, a); else m.delete(key);
  if (m.size > MAX_KEYS) m.delete(m.keys().next().value as string); // bound memory under key spraying: oldest key goes
  return a;
}
const Q = 15 * 60_000;
/** T28 backing gauges (02-TRD §13) from the same process-local windows [CONV; the auth_events sample is CR-C2-T28-002].
 *  ponytail: O(keys) scan per failure, bounded by MAX_KEYS; fine for login traffic. */
function gauges(t: number) {
  let throttled = 0; for (const u of ipUntil.values()) if (u > t) throttled += 1;
  let accounts = 0; for (const a of fails.values()) if ((a[a.length - 1] ?? 0) > t - Q) accounts += 1;
  let ips = 0; for (const l of ipLast.values()) if (l > t - Q) ips += 1;
  idMetrics.ipThrottlesActive(undefined, throttled);
  idMetrics.stuffing(undefined, accounts, ips);
}
const limitedFor = (ms: number) => Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)) });

export function createAuthLimits(rateLimit: LoginHctx['rateLimit'], now: () => number = Date.now): AuthLimits {
  return {
    async consumeAttempt(k) {
      if (!rateLimit) throw new LimsError('common.dependency_unavailable'); // fail closed
      await rateLimit.consume('login', `a:${k}`);
    },
    async accountState(k) {
      const a = window(fails, `a:${k}`, now(), H);
      return { failures: a.length, lastFailureAt: a.length ? new Date(a[a.length - 1]!) : null };
    },
    async recordAccountFailure(k) { const key = `a:${k}`; const a = window(fails, key, now(), H); a.push(now()); fails.set(key, a); },
    async clearAccountFailures(k) { fails.delete(`a:${k}`); },
    async checkIp(ip) {
      const key = `f:${ip}`; const t = now();
      if ((ipUntil.get(key) ?? 0) <= t) { if (ipUntil.delete(key)) gauges(t); return; }
      const a = window(ipAttempts, key, t, 60_000);
      if (a.length >= 5) throw limitedFor(a[0]! + 60_000 - t);
      a.push(t); ipAttempts.set(key, a);
    },
    async recordIpFailure(ip) {
      const key = `f:${ip}`; const t = now();
      const a = window(ipFails, key, t, 600_000); a.push(t); ipFails.set(key, a);
      const engaged = a.length >= 10 && (ipUntil.get(key) ?? 0) <= t;
      if (engaged) ipUntil.set(key, t + 30 * 60_000);
      ipLast.delete(key); ipLast.set(key, t);                                  // re-insert: Map order = recency
      if (ipLast.size > MAX_KEYS) ipLast.delete(ipLast.keys().next().value as string);
      gauges(t);
      return { engaged, windowStart: new Date(a[0]!) };
    },
  };
}

// ---------- wiring ----------
let gateway: GoTrueGateway | undefined;
const gotrue: Pick<GoTrueGateway, 'signInWithPassword'> = {
  signInWithPassword: (e, p) => (gateway ??= gotrueGatewayFromEnv()).signInWithPassword(e, p),
};
const repo = createAuthRepo();
const events = createAuthEventsRepo();

/** module wiring of the login family (loginStaff / loginPartner / openMobileSession) */
export const wiredAuthDeps = (ctx: LoginHctx): AuthDeps => ({
  gotrue, repo, events, limits: createAuthLimits(ctx.rateLimit),
  alert: (code, detail) => ctx.log.warn({ event: 'identity_alert', alert: code, ...detail }, 'identity alert'),
});

export function parseBody(b: unknown): { email: string; password: string } {
  const bad = new LimsError('common.validation_failed');
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad;
  const o = b as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'email' && k !== 'password')) throw bad;   // LoginRequest additionalProperties: false
  const { email, password } = o;
  if (typeof email !== 'string' || email.length < 3 || email.length > 254) throw bad;
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) throw bad;
  return { email, password };
}

/** One identityAuthTx per request; the operation's input is parsed (400) before any DB work. Shared by the T31 login handlers. */
export function createLoginHandler<I>(operationId: string, parse: (b: unknown) => I, depsFor: (ctx: LoginHctx) => AuthDeps,
  run: (svc: ReturnType<typeof createAuthService>, c: AuthCtx, input: I) => Promise<unknown>): Handler {
  const operation = Object.freeze({ module: 'identity', operationId, context: 'identity_auth' });
  return (async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = hctx as LoginHctx;
    const input = parse(req.body);
    const actor = ctx.actor;
    if (typeof actor?.id !== 'string' || !actor.id) throw new LimsError('common.internal');   // system actor = created_by of every write
    const ua = (req.headers as Record<string, unknown> | undefined)?.['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : undefined;
    const deps = depsFor(ctx);
    const svc = createAuthService(deps);
    const now = deps.now ?? (() => new Date());
    const out = await ctx.db.identityAuthTx({ operation, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent }, async (tx, ctl) => {
      ctl.noRetry();   // GoTrue sign-in and limiter state are not replayable
      let keep = false;
      const sctx: AuthCtx = {
        tx, actor, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent, bffKey: ctx.bffKey,
        now, log: ctx.log, commitOnError: () => { keep = true; ctx.commitOnError?.(); },
      };
      try { return { ok: await run(svc, sctx, input) }; } catch (err) { if (keep) return { err }; throw err; }
    });
    if ('err' in out) throw out.err;
    return out.ok;
  }) as Handler;
}

export const loginStaff: Handler = createLoginHandler('loginStaff', parseBody, wiredAuthDeps, (svc, c, i) => svc.loginStaff(c, i));
