// bumpRevision (02-TRD §3, F-19; AC-19.2/19.3): lock + increment catalog_state, stamp the root row, publish catalog.changed.v1,
// all in the caller's transaction. The row lock on catalog_state serialises writers, so revisions are gapless and follow commit order;
// a rollback discards the increment and the event together. Payload validity is enforced by the event schema (fails closed).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { createCatalogEvents } from '../events/publish.js';
import * as repo from '../repo/catalogState.repo.js';

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Ctx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly requestId: string; readonly tx: unknown }
/** `stampOrderableId`: the orderable to stamp when the entity is owned by one (an analyte stamps its test's orderable, 02-TRD §3). */
export interface BumpInput { readonly entityType: string; readonly entityId: string; readonly changeKind: string; readonly effectiveFrom: string; readonly stampOrderableId?: string }

const ROOT_STAMPED = new Set(['test', 'panel']);   // orderables.id = entityId; other owners' stamping lands with T-06+

export function createRevisionService(deps: { events: { publish(ctx: unknown, type: string, input: object): Promise<unknown> } }) {
  const catalogEvents = createCatalogEvents(deps.events);
  return {
    async bumpRevision(ctx: Ctx, input: BumpInput): Promise<{ revision: number }> {
      const tx = ctx.tx as Tx;
      let bumped = await repo.incrementRevision(tx, ctx.tenantId);
      if (!bumped) {
        await repo.ensureState(tx, ctx.tenantId, uuidv7(), ctx.actor.id);
        bumped = await repo.incrementRevision(tx, ctx.tenantId);
      }
      if (!bumped) throw new LimsError('common.internal');
      const { revision, rootId } = bumped;
      if (input.stampOrderableId) await repo.stampOrderable(tx, input.stampOrderableId, revision);
      else if (ROOT_STAMPED.has(input.entityType)) await repo.stampOrderable(tx, input.entityId, revision);
      await catalogEvents.catalogChanged(ctx, {
        catalog_revision: revision, entity_type: input.entityType, entity_id: input.entityId,
        change_kind: input.changeKind, effective_from: input.effectiveFrom,
      }, { catalogRootId: rootId });
      return { revision };
    },
  };
}
