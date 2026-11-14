// Shared closed state-table helper for the C12 documents (03-APP-FLOW §3). Pure.
import { LimsError } from '../../../core/errors.js';

export type Edges<S extends string> = ReadonlyArray<readonly [from: S | null, to: S]>;

/** Map-backed (not an object) so '__proto__' / 'constructor' can never match. `null` = ∅ (creation). */
export function machine<S extends string>(edges: Edges<S>, errorCode: string) {
  const next = new Map<S | null, Set<S>>();
  for (const [f, t] of edges) next.set(f, (next.get(f) ?? new Set<S>()).add(t));
  const canTransition = (from: S | null, to: S): boolean => next.get(from)?.has(to) ?? false;
  const assertTransition = (from: S | null, to: S): void => {
    if (!canTransition(from, to)) throw new LimsError(errorCode);
  };
  return { canTransition, assertTransition };
}
