// Period + scope resolution for every report endpoint (02-TRD §4; PRD US-15.2, US-02.3–5; 07-SECURITY REQ-SEC-013/017, P1, P5).
import { LimsError } from '../../../core/errors.js';
import { intersect, type Scope } from '../domain/scope.js';

export { resolvePeriod, type Period, type PeriodQuery } from '../domain/period.js';
export type { Scope } from '../domain/scope.js';

/** Max ids per filter (02-TRD §4, ScopeQuery maxItems 20). */
export const MAX_FILTER_IDS = 20;

interface ActorProfile { readonly centreScope: { readonly all: boolean; readonly centreIds: readonly string[] } }
/** Structural subset of HandlerContext used here (ports + core repo are added by their tasks). */
export interface ScopeContext {
  readonly ports: { readonly IdentityPort: { getActor(ctx: never): Promise<ActorProfile> } };
  readonly core: {
    branches(ctx: never): Promise<readonly { readonly id: string }[]>;
    centres(ctx: never, input?: { branchId?: string }): Promise<readonly { readonly id: string }[]>;
  };
}
export interface ScopeRequest { readonly centreIds?: readonly string[] | undefined; readonly branchIds?: readonly string[] | undefined }

// getActor memo: per request (= per ctx object), never shared across requests. Concurrent calls share the promise.
const actors = new WeakMap<object, Promise<ActorProfile>>();
function actorOf(ctx: ScopeContext): Promise<ActorProfile> {
  let p = actors.get(ctx);
  if (!p) { p = ctx.ports.IdentityPort.getActor(ctx as never).catch(asApiError); actors.set(ctx, p); }
  return p;
}

/** Port errors may be the contracts' LimsError class (same code space, other class): re-wrap so the API error mapper renders them. */
export function asApiError(e: unknown): never {
  const o = e as { code?: unknown; detail?: unknown } | null;
  if (!(e instanceof LimsError) && typeof o?.code === 'string') {
    throw new LimsError(o.code, typeof o.detail === 'string' ? o.detail : undefined);
  }
  throw e;
}

const notFound = (): LimsError => new LimsError('common.not_found'); // one shape for foreign/unknown/other-tenant: no oracle, id never echoed

function checkLimit(ids: readonly string[] | undefined, path: string): readonly string[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > MAX_FILTER_IDS) {
    throw new LimsError('common.validation_failed', 'Too many ids', [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  return ids;
}

export async function resolveScope(ctx: ScopeContext, requested: ScopeRequest): Promise<Scope> {
  const centreIds = checkLimit(requested.centreIds, 'centre_id'); // limits first: no lookup for an oversized request
  const branchIds = checkLimit(requested.branchIds, 'branch_id');

  const { centreScope } = await actorOf(ctx);
  let scope: Scope = { all: centreScope.all, centreIds: centreScope.all ? [] : [...centreScope.centreIds] };

  if (centreIds.length) {
    // Restricted callers: membership in their scope is the check (a foreign centre is 404). All-centre callers: the id must
    // exist in the caller's tenant (07 P1) — one tenant-filtered list, so hostile strings never reach a query.
    const known = new Set(centreScope.all ? (await ctx.core.centres(ctx as never).catch(asApiError)).map((c) => c.id) : centreScope.centreIds);
    if (centreIds.some((id) => !known.has(id))) throw notFound();
    scope = intersect(scope, { all: false, centreIds });
  }

  if (branchIds.length) {
    const known = new Set((await ctx.core.branches(ctx as never).catch(asApiError)).map((b) => b.id));
    if (branchIds.some((id) => !known.has(id))) throw notFound();
    const inBranches: string[] = [];
    for (const branchId of new Set(branchIds)) {
      for (const c of await ctx.core.centres(ctx as never, { branchId }).catch(asApiError)) inBranches.push(c.id);
    }
    scope = intersect(scope, { all: false, centreIds: inBranches }); // ∩ caller scope: a branch never widens it (07 P5)
  }

  return scope.all ? { all: true, centreIds: [] } : { all: false, centreIds: [...scope.centreIds] };
}
