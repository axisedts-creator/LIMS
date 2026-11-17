// labStore(tx, ctx): the ONE builder of the production lab stores (LD-124, 2026-11-12, C5 T-32). Handlers use `ctx.store ?? labStore(ctx.tx, ctx)`; a test that injects ctx.store is untouched.
// Every store method still takes (tx, tenantId, ...) (the service seams); the builder only checks that it was handed the request transaction and never opens one itself.
// [CONV] the optional `ctx` (the handler ctx) supplies what the roll-up and the shared ingest members need: actor, clock, event publisher. Without it those members fail closed (500).
import { LimsError } from '../../../core/errors.js';
import { sqlExceptionStore } from '../service/exception.service.js';
import { resultSideStore } from '../service/result-side.store.js';
import { criticalStore } from './critical.store.js';
import { resultsStore, type StoreCtx } from './results.store.js';
import { worklistStore } from './worklist.store.js';

export function labStore(tx: unknown, ctx?: StoreCtx) {
  if (typeof (tx as { query?: unknown } | null)?.query !== 'function') throw new LimsError('common.internal');
  const results = resultsStore(ctx);
  // the exception queue reuses the T-22/T-24 ingest store; it needs the actor synchronously, so only with a request ctx
  const exceptions = ctx && typeof ctx.actor?.id === 'string' && typeof ctx.now === 'function'
    ? sqlExceptionStore(ctx.actor.id, { ...resultSideStore({ tenantId: ctx.tenantId, requestId: ctx.requestId ?? '', tx: tx as never, now: () => ctx.now().toISOString(),
      actor: { type: ctx.actor.type ?? 'user', ...ctx.actor }, ports: ctx.ports }), ...results, getResultForAssign: results.getResultForAssign })
    : {};
  return { ...exceptions, ...criticalStore(), ...worklistStore(), ...results };
}
export type LabStore = ReturnType<typeof labStore>;
