// T0B-SYNC-3 (LD-322, LD-325 b): offline adapter of collection.mark_collected = collectSpecimen (lab.specimen.collect), entity_id = specimen_id.
// The device time fills collected_at when the payload has none (the captured time field of the entity, done_when 1).
import { collectSpecimen } from '../service/specimen.service.js';
import { specimenMoveAdapter, type ReadSpecimen } from './specimenMove.js';

/** Default seam: the specimen as the request sees it (RLS decides visibility; tenant_id named as everywhere). */
const readSpecimen: ReadSpecimen = async (ctx, id) =>
  (await (ctx as any).tx.query('SELECT status, version FROM lab.specimens WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id])).rows[0];

export function createCollectionMarkCollectedAdapter(deps: { readSpecimen?: ReadSpecimen } = {}) {
  return specimenMoveAdapter({
    opType: 'collection.mark_collected', permission: 'lab.specimen.collect', schema: 'CollectSpecimenRequest', from: ['ordered'], to: 'collected',
    move: collectSpecimen, readSpecimen: deps.readSpecimen ?? readSpecimen,
    body: (op) => ({ ...op.payload, collected_at: op.payload['collected_at'] ?? op.deviceCreatedAt }),
  });
}
export const collectionMarkCollectedAdapter = createCollectionMarkCollectedAdapter();
