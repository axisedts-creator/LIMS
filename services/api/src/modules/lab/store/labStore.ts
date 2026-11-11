// labStore(tx): the ONE builder of the production lab stores (LD-124, 2026-11-12, C5 T-32). Handlers use `ctx.store ?? labStore(ctx.tx)`; a test that injects ctx.store is untouched.
// Every store method still takes (tx, tenantId, ...) (the service seams); the builder only checks that it was handed the request transaction and never opens one itself.
import { LimsError } from '../../../core/errors.js';
import { criticalStore } from './critical.store.js';

export function labStore(tx: unknown) {
  if (typeof (tx as { query?: unknown } | null)?.query !== 'function') throw new LimsError('common.internal');
  return { ...criticalStore() };
}
export type LabStore = ReturnType<typeof labStore>;
