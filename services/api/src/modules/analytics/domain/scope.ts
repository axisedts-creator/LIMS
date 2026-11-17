// Effective centre scope (02-TRD §4 `Scope`; PRD US-15). Pure.
import { LimsError } from '../../../core/errors.js';

export interface Scope { readonly all: boolean; readonly centreIds: readonly string[] }

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];

/** all∩all = all; all∩S = S; S∩T = S∩T (deduped, order of `a`). An empty restricted scope sees nothing and never widens. */
export function intersect(a: Scope, b: Scope): Scope {
  if (a.all && b.all) return { all: true, centreIds: [] };
  if (a.all) return { all: false, centreIds: uniq(b.centreIds) };
  if (b.all) return { all: false, centreIds: uniq(a.centreIds) };
  const inB = new Set(b.centreIds);
  return { all: false, centreIds: uniq(a.centreIds.filter((id) => inB.has(id))) };
}

/** A centre outside the caller scope is 404 common.not_found — same as a non-existent one, id never echoed (US-15.2). */
export function assertWithin(scope: Scope, requested: readonly string[]): void {
  if (scope.all) return;
  const own = new Set(scope.centreIds);
  if (requested.some((id) => !own.has(id))) throw new LimsError('common.not_found');
}
