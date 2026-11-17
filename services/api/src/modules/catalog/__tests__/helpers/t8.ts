// T-08 (C3) shared test setup = helpers/t8db.ts (world, fixtures, families) + the ranges service under test.
// SEAM (spec silent on names; see .orchestra/notes/C3.T-08-tests.md):
//   catalog/service/ranges.service.ts  export function createRangesService(deps: { events: { publish(ctx, type, input) } })
//     -> one method per operationId #37–#50, snake_case DTOs exactly as contracts/openapi/catalog.yaml (same conventions as createAnalyteVersionsService):
//        listReferenceRangeSets(ctx, { analyte_id, status? })                                           -> { data: RangeSet[] }  (newest first = version_no DESC)
//        createReferenceRangeSetDraft(ctx, { analyte_id, body? })      body = RangeSetDraftCreate | undefined                    -> RangeSet (the 201 body)
//        getReferenceRangeSet(ctx, { id })                                                                                       -> RangeSet
//        replaceReferenceRangeSetBands(ctx, { id, expectedVersion, body })   body = { bands }                                    -> RangeSet
//        publishReferenceRangeSet(ctx, { id, expectedVersion, body })        body = PublishRequest                               -> RangeSet
//        retireReferenceRangeSet(ctx, { id, expectedVersion, body })         body = RetireRequest                                -> RangeSet
//        discardReferenceRangeSetDraft(ctx, { id, expectedVersion })                                                             -> RangeSet
//        …and the same seven for critical limits: listCriticalLimitSets, createCriticalLimitSetDraft, getCriticalLimitSet, replaceCriticalLimitSetBands,
//        publishCriticalLimitSet, retireCriticalLimitSet, discardCriticalLimitSetDraft (CriticalSet / CriticalBand DTOs).
//     ctx = core HandlerContext subset { tenantId, actor, requestId, tx, now, events }; "now" is ctx.now() (ISO string), never the wall clock. Errors are LimsError.
//     The service does NOT check permissions (handlers/ranges.handlers.ts does, through IdentityPort.assertRole).
//   Draft writes (create / replace bands / discard) bump nothing and emit nothing; publish and retire bump the revision once in the SAME tx
//   (entityType 'reference_range' | 'critical_limit', entityId = the SET id, changeKind 'versioned', effective_from = the set's / the retire time) and stamp
//   orderables.revision of the analyte's OWNING test (02-TRD §3, §9.1).
//   Band order in a DTO = ORDER BY sort_order, id. A CriticalBand has no sort_order in the DTO: the service stores the array position as sort_order.
import { createEvents } from '../../../../core/events/publish.js';
import { createRangesService } from '../../service/ranges.service.js';
import { world8Db, type Setup8 } from './t8db.js';

export * from './t8db.js';
export type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;

/** World + the ranges service. `t6` ADDS rows (sets, bands, versions). */
export const setup8 = (s: Setup8 = {}) => {
  const db = world8Db(s);
  const svc = createRangesService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
export type Env8 = ReturnType<typeof setup8>;
