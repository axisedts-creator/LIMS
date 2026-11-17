// Authz guard, pipeline stage 9 (02-TRD §6.2, AC-0D-2.4, 07-SECURITY AB-5, 08 A25 D-212).
// The wrapper only records that IdentityPort.assertRole was called; it never decides access.
import { LimsError } from '../errors.js';
import type { PortLog, PortMetrics } from './registry.js';

export interface RequestAuthz {
  readonly asserted: boolean;
  identity<T extends { assertRole(...a: any[]): any }>(port: T): T;
  /** LD-271 option A: lets markAsserted(ctx) set this request's mark (the pipeline binds platform-session contexts only). */
  bind(ctx: object): void;
}
export interface AuthzCheckOp {
  readonly operationId: string;
  /** x-public. identity_auth operations carry x-public (D-212), so this is the only exemption. */
  readonly public: boolean;
  readonly identityAuth?: boolean;
  readonly status: number;
}

// LD-271 option A (FOUNDER 2026-11-16): PlatformAuthz.assertPlatform counts as the stage 9 assertion for platform.* operations.
// Keyed by the handler context the pipeline bound; an unbound context (fake ctx, any other session kind) marks nothing.
const ctxMarks = new WeakMap<object, () => void>();
/** Call ONLY after a platform check has passed (PlatformAuthz.assertPlatform). */
export function markAsserted(ctx: unknown): void {
  if (typeof ctx === 'object' && ctx !== null) ctxMarks.get(ctx)?.();
}

export function createAuthzGuard({ env, log, metrics }: { env: string; log: PortLog; metrics: PortMetrics }) {
  // State lives here, not on the request object, so handler code cannot flip it.
  const state = new WeakMap<RequestAuthz, { asserted: boolean }>();

  function forRequest(): RequestAuthz {
    const s = { asserted: false };
    const req: RequestAuthz = {
      get asserted() { return s.asserted; },
      identity<T extends { assertRole(...a: any[]): any }>(port: T): T {
        return new Proxy(port, {
          get(target, prop) {
            if (prop === 'assertRole') {
              return (...a: unknown[]) => { s.asserted = true; return target.assertRole(...a); };
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
      bind(ctx: object) { ctxMarks.set(ctx, () => { s.asserted = true; }); },
    };
    state.set(req, s);
    return Object.freeze(req);
  }

  function check(req: RequestAuthz, op: AuthzCheckOp): void {
    if (op.public) return;
    if (op.status < 200 || op.status >= 400) return;
    if (state.get(req)?.asserted) return;
    log.error({ event: 'authz_not_asserted', operationId: op.operationId }, 'non-public operation returned without assertRole');
    metrics.inc('lims_core_authz_not_asserted_total', { operation_id: op.operationId });
    if (env !== 'production') throw new LimsError('common.internal');
  }

  return { forRequest, check };
}
