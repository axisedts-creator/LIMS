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

export interface LoginHctx extends HandlerContext {
  requestId: string; bffKey?: HandlerContext['bffKey']; actor?: { type: string; id: string }; commitOnError?: () => void;
  rateLimit?: LoginLimiter;
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}

// ---------- AuthLimits adapter ----------
// SEC-ABUSE-1 (LD-237 (1), LD-410, LD-414): every counter lives in the limiter's `login` tier (Postgres app.ratelimit_hit / _peek / _clear,
// keys HMAC'd by the limiter), so N API instances share one budget and a restart forgets nothing. Fail closed: no limiter or a store
// failure = common.dependency_unavailable. Thresholds, windows and lockout are unchanged from the process-local version:
const ACCOUNT_WINDOW_MS = 60 * 60_000;  // x:<acct> failures, sliding 60 min (03-APP-FLOW §3.3)
const IP_FAIL_LIMIT = 10;               // f:<ip> 10 failures in a sliding 10 min engage the throttle (08 A1)
const IP_FAIL_WINDOW_MS = 10 * 60_000;
const IP_THROTTLE_MS = 30 * 60_000;     // t:<ip> throttle lasts 30 min from the engaging failure
// a:<acct> 10/h and g:<ip> 5 attempts / 60 s while throttled are limiter rules (core/ratelimit RULES.login).
// ponytail: last_hit (DB clock) is compared with the API clock; NTP skew of a few seconds shifts the 30 min / 60 min edges by as much.
// The T28 stuffing / ip-throttle gauges were fed by the process Maps and are no longer set here (.orchestra/cr/SEC-ABUSE-1.2.nonblocking.md).

export interface LoginLimiter {
  consume(tier: 'login', key: string): Promise<void>;
  // optional in the type (core/module.ts HandlerContext declares consume only); missing at run time = fail closed (rl() below)
  peek?(tier: 'login', key: string): Promise<{ hits: number; lastHit: Date | null }>;
  clear?(tier: 'login', key: string): Promise<void>;
}

export function createAuthLimits(rateLimit: LoginLimiter | undefined, now: () => number = Date.now): AuthLimits {
  const rl = (): Required<LoginLimiter> => {
    if (!rateLimit || typeof rateLimit.peek !== 'function' || typeof rateLimit.clear !== 'function') throw new LimsError('common.dependency_unavailable');
    return rateLimit as Required<LoginLimiter>;
  };
  /** the latest hit of `key` when it is younger than `ms`, else null (a stale row counts as nothing). */
  const fresh = async (key: string, ms: number) => {
    const p = await rl().peek('login', key);
    return p.lastHit && now() - p.lastHit.getTime() < ms ? p : null;
  };
  return {
    async consumeAttempt(k) {
      if (!rateLimit) throw new LimsError('common.dependency_unavailable'); // fail closed
      await rateLimit.consume('login', `a:${k}`);
    },
    async accountState(k) {
      const p = await fresh(`x:${k}`, ACCOUNT_WINDOW_MS);
      return p ? { failures: p.hits, lastFailureAt: p.lastHit } : { failures: 0, lastFailureAt: null };
    },
    async recordAccountFailure(k) { await rl().consume('login', `x:${k}`); },
    // Without a limiter there is nothing to clear (and no counter that could lock anyone out); a store failure still throws.
    async clearAccountFailures(k) { if (rateLimit) await rl().clear('login', `x:${k}`); },
    async checkIp(ip) {
      if (!(await fresh(`t:${ip}`, IP_THROTTLE_MS))) return;
      await rl().consume('login', `g:${ip}`);   // 5 / 60 s while throttled -> common.rate_limited with Retry-After
    },
    async recordIpFailure(ip) {
      const prior = await fresh(`f:${ip}`, IP_FAIL_WINDOW_MS);
      if (!prior) await rl().consume('login', `w:${ip}`);   // first failure of a run: window start marker
      await rl().consume('login', `f:${ip}`);
      const failures = (prior?.hits ?? 0) + 1;
      const engaged = failures >= IP_FAIL_LIMIT && !(await fresh(`t:${ip}`, IP_THROTTLE_MS));
      if (!engaged) return { engaged, windowStart: new Date(now()) };
      await rl().consume('login', `t:${ip}`);
      return { engaged, windowStart: (await fresh(`w:${ip}`, IP_FAIL_WINDOW_MS))?.lastHit ?? new Date(now()) };
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
