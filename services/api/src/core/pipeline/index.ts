// Request pipeline, 02-TRD §6.2 stages 5-11 (LD-133, T0D-18). Stages 1-4 and 12-13 stay Fastify hooks (errors.ts, openapi.ts,
// observability/logging.ts). One run() per request; the HandlerContext built here has exactly the §6.3 members.
// Errors thrown by a stage or the handler are rethrown after the rollback and the idempotency key release; a handler RESULT
// with status >= 400 is returned (and rolled back unless ctx.commitOnError() was called).
import type { DbClaims } from '../auth/claims.js';
import { access, type AccessLogEntry } from '../audit/access.js';
import type { Db, Tx, TxControl, TxFn } from '../db/tx.js';
import { isLimsError, LimsError } from '../errors.js';
import type { IdemHandle, IdemOperation, Idempotency } from '../idempotency.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../module.js';
import type { createAuthzGuard, RequestAuthz } from '../ports/authz-guard.js';
import type { PortLog, PortMetrics, PortRegistry } from '../ports/registry.js';
import type { RateLimiter, RateLimitTier } from '../ratelimit/index.js';

export interface PipelineOp extends IdemOperation {
  readonly method: string;
  /** spec path, e.g. /v1/frontdesk/things/{id} (idempotency request hash, §6.6 step 1). */
  readonly routeTemplate: string;
  /** x-public (identity_auth operations carry it too, D-212). */
  readonly public: boolean;
  readonly identityAuth?: boolean;
  readonly rateLimitTier?: RateLimitTier | undefined;
}

export interface SharedCore {
  readonly core: unknown; readonly events: unknown; readonly uploads: unknown;
  readonly files: unknown; readonly storage: unknown; readonly download: unknown;
}

export interface PipelineDeps {
  readonly env: string;
  /** Absent when LIMS_CORE_DATABASE_URL is unset: only public operations can run (no transaction needed). */
  readonly db?: Db | undefined;
  readonly idempotency?: Pick<Idempotency, 'begin' | 'finish' | 'release'> | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly authz: ReturnType<typeof createAuthzGuard>;
  readonly ports: { portsFor(module: string): PortRegistry };
  /** module name -> createServices(deps) result (ctx.services). */
  readonly services?: Readonly<Record<string, unknown>> | undefined;
  readonly shared: SharedCore;
  readonly log: PortLog;
  readonly metrics: PortMetrics;
}

export interface PipelineCall {
  readonly op: PipelineOp;
  /** Stage-4 result; undefined for a public operation (anonymous actor, no tenant). */
  readonly claims?: DbClaims | undefined;
  readonly requestId: string;
  readonly clientIp: string;
  readonly userAgent?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly req: HandlerRequest;
  readonly handler: Handler;
  readonly log: HandlerContext['log'];
}

export type PipelineResult = HandlerResult;

/** Thrown inside the request transaction to force ROLLBACK of a >= 400 result; never leaves run(). No `code`: not retried, not mapped. */
class RollbackResult {
  constructor(readonly result: HandlerResult) {}
}

const unavailable = (): LimsError => new LimsError('common.dependency_unavailable');

export function createPipeline(d: PipelineDeps) {
  const limiter = (): RateLimiter => d.rateLimiter ?? { consume: async () => { throw unavailable(); } };

  /** Stage 5 (§6.7): `general` = actor + tenant bucket, `ingest` = device bucket; other tiers via ctx.rateLimit in the handler. */
  async function rateLimit(op: PipelineOp, claims: DbClaims | undefined): Promise<void> {
    if (!claims) return; // public: no actor/tenant key [CONV]
    if (op.rateLimitTier === 'general') {
      await limiter().consume('general', `u:${claims.sub}`);
      if (typeof claims.tenant_id === 'string') await limiter().consume('general', `t:${claims.tenant_id}`);
    } else if (op.rateLimitTier === 'ingest') {
      await limiter().consume('ingest', `d:${claims.sub}`);
    }
  }

  /** ctx.ports: the registry view of this module; IdentityPort wrapped so stage 9 sees assertRole (getters keep the consumer check lazy). */
  function portsView(module: string, az: RequestAuthz): PortRegistry {
    const view = d.ports.portsFor(module);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(view)) {
      Object.defineProperty(out, k, {
        enumerable: true,
        get: k === 'IdentityPort' ? () => az.identity(view[k] as { assertRole(...a: unknown[]): unknown }) : () => view[k],
      });
    }
    return Object.freeze(out);
  }

  function buildCtx(c: PipelineCall, az: RequestAuthz, tx: Tx | undefined, ctl: TxControl | undefined, onCommitOnError: () => void): HandlerContext {
    const claims = tx ? c.claims : undefined;
    const actor = claims && Object.freeze({
      type: claims.actor_type, id: claims.sub,
      ...(typeof claims.membership_id === 'string' ? { membershipId: claims.membership_id } : {}),
      ...(typeof claims.support_session_id === 'string' ? { supportSessionId: claims.support_session_id } : {}),
    });
    const noTx = (): never => { throw new LimsError('common.internal'); };
    const ctx: HandlerContext = Object.freeze({
      // RequestContext (IC §4.1)
      tenantId: claims?.tenant_id,
      actor,
      requestId: c.requestId,
      tx,
      now: () => (tx ? tx.startedAt.toISOString() : new Date().toISOString()),
      ports: portsView(c.op.module, az),
      // §6.3
      db: Object.freeze({
        tx: <T>(fn: (rc: HandlerContext) => Promise<T>): Promise<T> => (tx ? tx.savepoint(() => fn(ctx)) : noTx()),
        // D-212: db.identityAuthTx refuses anything but identity + identity_auth + allowlisted op. The caller's input is ignored
        // (accepts (fn) per 02-TRD §6.3 and (input, fn) as module identity calls it): request id, ip and operation are the core's.
        identityAuthTx: <T>(a: unknown, b?: TxFn<T>): Promise<T> => {
          const fn = (typeof a === 'function' ? a : b) as TxFn<T>;
          if (!d.db || typeof fn !== 'function') return Promise.reject(new LimsError('common.internal'));
          return d.db.identityAuthTx({
            requestId: c.requestId, clientIp: c.clientIp, userAgent: c.userAgent,
            operation: { module: c.op.module, operationId: c.op.operationId, context: c.op.context },
          }, fn);
        },
      }),
      core: d.shared.core,
      audit: Object.freeze({ access: (entry: AccessLogEntry) => (tx ? access(ctx as any, entry) : noTx()) }),
      events: d.shared.events,
      rateLimit: Object.freeze({ consume: (tier: RateLimitTier, key: string) => limiter().consume(tier, key) }),
      uploads: d.shared.uploads,
      files: d.shared.files,
      storage: d.shared.storage,
      log: c.log,
      services: d.services?.[c.op.module],
      operationId: c.op.operationId,
      clientIp: c.clientIp,
      download: d.shared.download,
      commitOnError: () => { onCommitOnError(); },
      noRetry: () => { ctl?.noRetry(); },
    } as unknown as HandlerContext);
    return ctx;
  }

  const authzCheck = (az: RequestAuthz, op: PipelineOp, status: number) =>
    d.authz.check(az, { operationId: op.operationId, public: op.public, ...(op.identityAuth ? { identityAuth: true } : {}), status });

  async function run(c: PipelineCall): Promise<PipelineResult> {
    const { op, claims } = c;
    // [CONV] no database configured: dev/ci boot in contract mode (handler without transaction and without stage 9, as before
    // T0D-18; keeps DB-less boot/contract suites working); staging/production never serve a non-public operation then.
    const contractMode = !d.db && (d.env === 'dev' || d.env === 'ci');
    if (!op.public && !contractMode && !(d.db && claims)) throw unavailable();
    if (contractMode && !op.public) {
      const az = d.authz.forRequest();
      return c.handler(c.req, buildCtx(c, az, undefined, undefined, () => undefined));
    }

    await rateLimit(op, claims); // stage 5

    // stage 6 (§6.6): begin() is the single decision point (skip / proceed / replay / throw).
    const begun = d.idempotency
      ? await d.idempotency.begin({
        operation: op, method: op.method, routeTemplate: op.routeTemplate,
        pathParams: c.req.params, query: c.req.query, body: c.req.body,
        idempotencyKey: c.idempotencyKey, claims: claims as DbClaims, requestId: c.requestId, clientIp: c.clientIp, userAgent: c.userAgent,
      })
      : { action: 'skip' as const };
    if (begun.action === 'replay') return { status: begun.status, body: begun.body, headers: begun.headers };
    const handle: IdemHandle | undefined = begun.action === 'proceed' ? begun.handle : undefined;

    // stage 7: public operation without tenant -> no transaction.
    if (!claims || !d.db) {
      const az = d.authz.forRequest();
      const r = await c.handler(c.req, buildCtx(c, az, undefined, undefined, () => undefined)); // stage 8
      authzCheck(az, op, r.status); // stage 9
      return r;
    }

    let out: { r: HandlerResult } | { thrown: unknown };
    try {
      out = await d.db.requestTx({
        claims, requestId: c.requestId, clientIp: c.clientIp, userAgent: c.userAgent,
        operation: { module: op.module, operationId: op.operationId, context: op.context },
      }, async (tx, ctl) => {
        // per attempt: a 40001/40P01 retry re-runs the handler with a fresh context and authz state
        const az = d.authz.forRequest();
        let commitOnError = false;
        const ctx = buildCtx(c, az, tx, ctl, () => { commitOnError = true; });
        let r: HandlerResult;
        try {
          r = await c.handler(c.req, ctx); // stage 8
        } catch (e) {
          // [CONV] commitOnError also commits a thrown LimsError (denied access-log rows); a DB error still rolls back (08 A19 P-42).
          if (commitOnError && isLimsError(e)) {
            if (handle) await d.idempotency!.finish(tx, handle, { status: e.statusCode, commitOnError: true });
            return { thrown: e };
          }
          throw e;
        }
        authzCheck(az, op, r.status); // stage 9: throws -> rollback, nothing stored
        if (r.status < 400) {
          if (handle) await d.idempotency!.finish(tx, handle, { status: r.status, body: r.body }); // stage 10 (K2)
          return { r }; // stage 11: COMMIT
        }
        if (commitOnError) {
          if (handle) await d.idempotency!.finish(tx, handle, { status: r.status, body: r.body, commitOnError: true }); // D-202
          return { r };
        }
        throw new RollbackResult(r); // stage 11: ROLLBACK
      });
    } catch (e) {
      if (handle) await d.idempotency!.release(handle); // after the rollback, own transaction (AC-0D-4.5)
      if (e instanceof RollbackResult) return e.result;
      throw e;
    }
    if ('thrown' in out) throw out.thrown;
    return out.r;
  }

  return { run };
}

export type Pipeline = ReturnType<typeof createPipeline>;
