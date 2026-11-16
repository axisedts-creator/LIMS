// Request pipeline, 02-TRD §6.2 stages 5-11 (LD-133, T0D-18). Stages 1-4 and 12-13 stay Fastify hooks (errors.ts, openapi.ts,
// observability/logging.ts). One run() per request; the HandlerContext built here has exactly the §6.3 members.
// Errors thrown by a stage or the handler are rethrown after the rollback and the idempotency key release; a handler RESULT
// with status >= 400 is returned (and rolled back unless ctx.commitOnError() was called).
import type { BffKind } from '../auth/bff-key.js';
import type { DbClaims } from '../auth/claims.js';
import { access, type AccessLogEntry } from '../audit/access.js';
import type { Db, Tx, TxControl, TxFn } from '../db/tx.js';
import { isLimsError, LimsError } from '../errors.js';
import type { IdemHandle, IdemOperation, Idempotency } from '../idempotency.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../module.js';
import type { createAuthzGuard, RequestAuthz } from '../ports/authz-guard.js';
import type { PortLog, PortMetrics, PortRegistry } from '../ports/registry.js';
import type { CoreMetrics } from '../observability/metrics.js';
import type { RateLimiter, RateLimitTier } from '../ratelimit/index.js';
import { createAuthzCentral, type AuthzException, type AuthzMode } from './authz-central.js';

export interface PipelineOp extends IdemOperation {
  readonly method: string;
  /** spec path, e.g. /v1/frontdesk/things/{id} (idempotency request hash, §6.6 step 1). */
  readonly routeTemplate: string;
  /** x-public (identity_auth operations carry it too, D-212). */
  readonly public: boolean;
  readonly identityAuth?: boolean;
  readonly rateLimitTier?: RateLimitTier | undefined;
  /** SEC-AUTHZ-2: the contract x-permission (stage 8a); absent = nothing to assert centrally. */
  readonly permission?: string | undefined;
  /** SEC-AUTHZ-2: the operation's first security scheme (bearerJwt, bffSession, deviceToken, ...). */
  readonly scheme?: string | undefined;
}

export interface SharedCore {
  readonly core: unknown; readonly events: unknown; readonly uploads: unknown;
  readonly files: unknown; readonly storage: unknown; readonly download: unknown;
}

export interface PipelineDeps {
  readonly env: string;
  /** Absent when LIMS_CORE_DATABASE_URL is unset: only public operations can run (no transaction needed). */
  readonly db?: Db | undefined;
  /** LD-204 (AUTH-ACTOR-1): lazy identity system actor id from core.g_system_actors (boot.ts); rejects common.internal on any failure. */
  readonly identityActor?: (() => Promise<string>) | undefined;
  /** LD-204: Db opened with that actor, used ONLY for ctx.db.identityAuthTx of module identity. */
  readonly identityAuthDb?: (() => Promise<Db>) | undefined;
  readonly idempotency?: Pick<Idempotency, 'begin' | 'finish' | 'release'> | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly authz: ReturnType<typeof createAuthzGuard>;
  readonly ports: { portsFor(module: string): PortRegistry };
  /** module name -> createServices(deps) result (ctx.services). */
  readonly services?: Readonly<Record<string, unknown>> | undefined;
  readonly shared: SharedCore;
  readonly log: PortLog;
  readonly metrics: PortMetrics;
  /** LD-190 / CR-C9-T26-002: the CoreMetrics { inc, set, observe } boot.ts passes; exposed as ctx.metrics. Optional so existing callers/tests keep working. */
  readonly coreMetrics?: Pick<CoreMetrics, 'inc' | 'set' | 'observe'> | undefined;
  /** SEC-AUTHZ-2 (LD-261): stage 8a mode; absent = shadow (the default in every environment until SEC-AUTHZ-9). */
  readonly authzMode?: AuthzMode | undefined;
  /** SEC-AUTHZ-2: module name -> manifest systemPermissions (system actors). */
  readonly systemPermissions?: Readonly<Record<string, readonly string[]>> | undefined;
  /** SEC-AUTHZ-2: reviewed entries of authz-exceptions.json. */
  readonly authzExceptions?: readonly AuthzException[] | undefined;
}

export interface PipelineCall {
  readonly op: PipelineOp;
  /** Stage-4 result; undefined for a public operation (anonymous actor, no tenant). */
  readonly claims?: DbClaims | undefined;
  readonly requestId: string;
  readonly clientIp: string;
  /** LD-206 (AUTH-BFF-1): the BffKind the verifier returned for X-Lims-Bff-Key; undefined otherwise. */
  readonly bffKey?: BffKind | undefined;
  readonly userAgent?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly req: HandlerRequest;
  readonly handler: Handler;
  readonly log: HandlerContext['log'];
}

export type PipelineResult = HandlerResult;

/** Thrown inside the request transaction to force ROLLBACK of a >= 400 result; never leaves run(). No `code`: not retried, not mapped. */
class RollbackResult {
  readonly result: HandlerResult;
  constructor(result: HandlerResult) { this.result = result; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

  /** LD-204: identityAuth operation of module identity only (the flag the pipeline already carries); nothing else gets an actor from this path. */
  const needsIdentityActor = (c: PipelineCall): boolean => !c.claims && c.op.identityAuth === true && c.op.module === 'identity';

  function buildCtx(c: PipelineCall, az: RequestAuthz, tx: Tx | undefined, ctl: TxControl | undefined, onCommitOnError: () => void, systemActorId?: string): HandlerContext {
    const claims = tx ? c.claims : undefined;
    const actor = claims ? Object.freeze({
      type: claims.actor_type, id: claims.sub,
      ...(typeof claims.membership_id === 'string' ? { membershipId: claims.membership_id } : {}),
      ...(typeof claims.support_session_id === 'string' ? { supportSessionId: claims.support_session_id } : {}),
    }) : systemActorId ? Object.freeze({ type: 'system' as const, id: systemActorId }) : undefined;
    const noTx = (): never => { throw new LimsError('common.internal'); };
    // LD-241 / CR-C2-004 (C2 02-TRD 5.10, 7.2 step 3): PlatformAuthz reads platformRole and aal; set ONLY for a platform session
    // (claims.scope platform + a platform_ role), from the verified claims; every other session kind gets neither key.
    // [CONV] a platform session is also a user actor without a tenant (identity claims resolver shape); a patient/partner/tenant
    // claim set carrying stray platform keys gets nothing.
    const platform = claims?.scope === 'platform' && claims.actor_type === 'user' && claims.tenant_id === undefined
      && typeof claims.platform_role === 'string' && claims.platform_role.startsWith('platform_')
      ? { platformRole: claims.platform_role, ...(typeof claims.aal === 'string' ? { aal: claims.aal } : {}) }
      : undefined;
    // PLATFORM-WIRE-1 (LD-267, CR-C2-T21): the platform services also read platformStaffId / platformSessionId; same gate, verified claims only,
    // a missing or non-UUID claim leaves the key absent (the service then fails closed as before). Never from the request.
    const uuidClaim = (v: unknown): string | undefined => (typeof v === 'string' && UUID.test(v) ? v : undefined);
    const staffId = platform && uuidClaim((claims as Record<string, unknown>)['platform_staff_id']);
    const sessionId = platform && uuidClaim((claims as Record<string, unknown>)['lims_session_id']);
    const ctx: HandlerContext = Object.freeze({
      // RequestContext (IC §4.1)
      tenantId: claims?.tenant_id,
      actor,
      ...platform,
      ...(staffId ? { platformStaffId: staffId } : {}),
      ...(sessionId ? { platformSessionId: sessionId } : {}),
      requestId: c.requestId,
      tx,
      now: () => (tx ? tx.startedAt.toISOString() : new Date().toISOString()),
      ports: portsView(c.op.module, az),
      // §6.3
      db: Object.freeze({
        // PLATFORM-WIRE-1 (LD-267): platform session only; the repository's createDb().withTenantScope on this request's own tx
        // (module identity + x-context platform + allowlisted operationId, tx of this request, no nesting; claims restored afterwards).
        ...(platform && d.db ? { withTenantScope: <T>(t: unknown, tenantId: string, fn: () => Promise<T>): Promise<T> => d.db!.withTenantScope(t as Tx, tenantId, fn) } : {}),
        tx: <T>(fn: (rc: HandlerContext) => Promise<T>): Promise<T> => (tx ? tx.savepoint(() => fn(ctx)) : noTx()),
        // D-212: db.identityAuthTx refuses anything but identity + identity_auth + allowlisted op. The caller's input is ignored
        // (accepts (fn) per 02-TRD §6.3 and (input, fn) as module identity calls it): request id, ip and operation are the core's.
        identityAuthTx: <T>(a: unknown, b?: TxFn<T>): Promise<T> => {
          const fn = (typeof a === 'function' ? a : b) as TxFn<T>;
          if (!d.db || typeof fn !== 'function') return Promise.reject(new LimsError('common.internal'));
          // LD-204: module identity opens through the Db that carries the lazily read identity actor; every other module keeps d.db (which refuses).
          const open = c.op.module === 'identity' && d.identityAuthDb ? d.identityAuthDb() : Promise.resolve(d.db);
          return open.then((db) => db.identityAuthTx({
            requestId: c.requestId, clientIp: c.clientIp, userAgent: c.userAgent,
            operation: { module: c.op.module, operationId: c.op.operationId, context: c.op.context },
          }, fn));
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
      metrics: d.coreMetrics,                                            // LD-190: undefined only when a caller (test) wires none
      services: d.services?.[c.op.module],
      operationId: c.op.operationId,
      clientIp: c.clientIp,
      bffKey: c.bffKey,                                                  // LD-206: own key on every request, undefined when absent
      download: d.shared.download,
      commitOnError: () => { onCommitOnError(); },
      noRetry: () => { ctl?.noRetry(); },
    } as unknown as HandlerContext);
    if (platform) az.bind(ctx); // LD-271 option A: platform session only; PlatformAuthz.assertPlatform marks stage 9 after it passed
    return ctx;
  }

  // Stage 8a. [CONV] the core reads IdentityPort through the view of a module that PORT_CONSUMERS lists (the owner `identity` is not a consumer
  // of its own port, so its view would refuse); the wrapper (RequestAuthz.identity) still makes stage 9 see the call.
  const central = createAuthzCentral({
    mode: d.authzMode ?? 'shadow', log: d.log, metrics: d.metrics, systemPermissions: d.systemPermissions, exceptions: d.authzExceptions,
    identityPort: () => d.ports.portsFor('frontdesk')['IdentityPort'] as { assertRole(...a: any[]): any },
  });

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

    // LD-204 (AUTH-ACTOR-1): before stage 6 so a failed read leaves no idempotency state; fails closed (common.internal), handler never runs.
    let systemActorId: string | undefined;
    // No source wired (no database: boot wires one whenever a pool exists) = unchanged: ctx.actor stays undefined and the handler refuses itself.
    if (d.identityActor && needsIdentityActor(c)) systemActorId = await d.identityActor();

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
      const r = await c.handler(c.req, buildCtx(c, az, undefined, undefined, () => undefined, systemActorId)); // stage 8
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
          await central.check(op, claims, ctx, az); // stage 8a: a deny throws (enforce) before any handler read or write; shadow logs and goes on
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
