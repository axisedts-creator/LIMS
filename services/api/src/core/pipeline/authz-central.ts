// Pipeline stage 8a, central authorization (SEC-AUTHZ-2; LD-261 shadow by default, LD-189, LD-277;
// CR .orchestra/cr/SEC-AUTHZ-1.1.nonblocking.md; C0 02-TRD 6.2 stage 8a + 9, 07-SECURITY AB-5).
// Runs inside the request transaction (after stage 7) and before the handler. It asserts the operation's x-permission once, in one place;
// it never widens anything: it asks the same IdentityPort.assertRole the handlers use and returns its errors unchanged.
import { readFileSync } from 'node:fs';
import { LimsError } from '../errors.js';
import type { HandlerContext } from '../module.js';
import type { RequestAuthz } from '../ports/authz-guard.js';
import type { PortLog, PortMetrics } from '../ports/registry.js';

export type AuthzMode = 'shadow' | 'enforce';
export interface AuthzException { readonly operationId: string; readonly handlerPermission: string; readonly reason: string }

/** What stage 8a needs of an operation (PipelineOp has these fields). */
export interface CentralOp {
  readonly module: string; readonly operationId: string; readonly public: boolean;
  readonly permission?: string | undefined; readonly scheme?: string | undefined;
}
/** The verified claims fields stage 8a reads (never request input). */
export interface CentralClaims { readonly actor_type?: string; readonly credential_permission?: unknown }

/** Documented skip reasons: the operation is not this stage's business. null = the stage checks it. */
export function skipReason(op: CentralOp): string | null {
  if (op.public) return 'x-public';
  if (op.scheme === 'bffSession') return 'bffSession (identity session flow)';
  if (op.permission === undefined || op.permission === '') return 'no x-permission (stage 9 still applies)';
  if (op.permission.startsWith('platform.')) return 'platform.* (PlatformAuthz, task SEC-AUTHZ-3)';
  return null;
}

/** Loader check for authz-exceptions.json: a list of { operationId, handlerPermission, reason }, no duplicates, existing operationId when `ids` is given. */
export function validateAuthzExceptions(entries: unknown, ids?: ReadonlySet<string>): asserts entries is readonly AuthzException[] {
  if (!Array.isArray(entries)) throw new Error('authz-exceptions: must be a list');
  const seen = new Set<string>();
  for (const e of entries as unknown[]) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) throw new Error('authz-exceptions: entry is not an object');
    const { operationId, handlerPermission, reason } = e as Record<string, unknown>;
    if (typeof operationId !== 'string' || operationId === '') throw new Error('authz-exceptions: operationId is required');
    if (ids && !ids.has(operationId)) throw new Error(`authz-exceptions: ${operationId} is not an operationId of the contracts`);
    if (seen.has(operationId)) throw new Error(`authz-exceptions: ${operationId} is listed twice`);
    seen.add(operationId);
    if (typeof handlerPermission !== 'string' || handlerPermission === '') throw new Error(`authz-exceptions: ${operationId} needs a handlerPermission`);
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`authz-exceptions: ${operationId} needs a reason`);
  }
}

/** Reads and validates core/pipeline/authz-exceptions.json (boot fails on a bad file). */
export function loadAuthzExceptions(ids?: ReadonlySet<string>): readonly AuthzException[] {
  const list: unknown = JSON.parse(readFileSync(new URL('./authz-exceptions.json', import.meta.url), 'utf8'));
  validateAuthzExceptions(list, ids);
  return Object.freeze(list.map((e) => Object.freeze({ ...e })));
}

const forbidden = (): LimsError => new LimsError('auth.forbidden');

export function createAuthzCentral(o: {
  mode: AuthzMode; log: PortLog; metrics: PortMetrics;
  systemPermissions?: Readonly<Record<string, readonly string[]>> | undefined;
  exceptions?: readonly AuthzException[] | undefined;
  /** the IdentityPort as the core reads it (unwrapped; the stage wraps it per request unless the operation is exception-listed). */
  identityPort: () => { assertRole(...a: any[]): any };
}) {
  const exceptions = new Map((o.exceptions ?? []).map((e) => [e.operationId, e.handlerPermission]));

  /** Throws the assertRole / auth.forbidden error in enforce, logs and returns in shadow. */
  async function check(op: CentralOp, claims: CentralClaims | undefined, ctx: HandlerContext, az: RequestAuthz): Promise<void> {
    if (skipReason(op) !== null) return;
    const actorType = typeof claims?.actor_type === 'string' ? claims.actor_type : 'unknown';
    const exception = exceptions.get(op.operationId);
    const permission = exception ?? op.permission!;
    // LD-277: a checked operation counts as asserted for stage 9 (shadow and enforce), whatever the actor kind. Exception-listed operations keep
    // the current stage 9 behaviour. Marking goes through the guard wrapper over a no-op port, so authz-guard.ts needs no code change.
    const mark = (): void => { if (exception === undefined) void az.identity({ assertRole: () => undefined }).assertRole(); };
    if (actorType !== 'user') mark(); // the user path marks through the wrapper when it calls assertRole
    try {
      switch (actorType) {
        case 'user': {
          const port = exception === undefined ? az.identity(o.identityPort()) : o.identityPort();
          await port.assertRole(ctx, { permission }); // no centre or branch: baseline; handlers add scope
          return;
        }
        case 'system':
          if (o.systemPermissions?.[op.module]?.includes(permission)) return;
          throw forbidden();
        case 'device':
          if (typeof claims?.credential_permission === 'string' && claims.credential_permission === permission) return;
          throw forbidden();
        case 'patient': case 'partner': case 'portal':
          // ponytail: bearerJwt staff operations only; their own scheme (portalSession, patientPreAuth) is authenticated by its resolver, not decided here.
          if (op.scheme === undefined || op.scheme === 'bearerJwt') throw forbidden();
          return;
        default:
          throw forbidden();
      }
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      if (typeof code === 'string' && /^(auth|identity)\./.test(code)) {
        // a denial: auth.forbidden, auth.mfa_required, identity.support_session_required. No person id, token, email or tenant id in the line or label (LD-189).
        o.log.warn({ event: 'authz_central_deny', operation_id: op.operationId, actor_type: actorType, permission, mode: o.mode }, 'central authorization denied');
        try { o.metrics.inc('lims_core_authz_central_deny_total', { operation_id: op.operationId }); } catch { /* a metrics failure never changes the decision */ }
      } else if (o.mode === 'shadow') {
        o.log.warn({ event: 'authz_central_error', operation_id: op.operationId, actor_type: actorType, mode: o.mode }, 'central authorization could not decide');
      }
      if (o.mode === 'enforce') throw e; // fail closed: the dependency error propagates, the handler never runs
    }
  }

  return { check };
}
