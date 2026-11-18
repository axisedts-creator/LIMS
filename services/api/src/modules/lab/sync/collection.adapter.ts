// T0B-SYNC-3 (LD-322, LD-325 b): offline adapter of collection.mark_collected = collectSpecimen (lab.specimen.collect), entity_id = specimen_id.
// The device time fills collected_at when the payload has none (the captured time field of the entity, done_when 1).
import { collectSpecimen } from '../service/specimen.service.js';
import { scopedRead, specimenMoveAdapter, type ReadSpecimen } from './specimenMove.js';

/** Default seam: lab.specimens of this tenant, visible only inside the actor's centre scope (as online). */
const readSpecimen = scopedRead('SELECT status, version, centre_id, processing_centre_id FROM lab.specimens WHERE tenant_id = $1 AND id = $2');

export function createCollectionMarkCollectedAdapter(deps: { readSpecimen?: ReadSpecimen } = {}) {
  return specimenMoveAdapter({
    opType: 'collection.mark_collected', permission: 'lab.specimen.collect', schema: 'CollectSpecimenRequest', from: ['ordered'], to: 'collected',
    move: collectSpecimen, readSpecimen: deps.readSpecimen ?? readSpecimen,
    body: (op) => ({ ...op.payload, collected_at: op.payload['collected_at'] ?? new Date(op.deviceCreatedAt).toISOString() }),
  });
}
export const collectionMarkCollectedAdapter = createCollectionMarkCollectedAdapter();
