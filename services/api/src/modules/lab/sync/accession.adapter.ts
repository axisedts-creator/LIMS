// T0B-SYNC-3 (LD-322, LD-325 b): offline adapter of accession.receive = receiveSpecimen (lab.specimen.receive), entity_id = specimen_id.
// Lab codes used offline (reserved_numbers.lab_codes) must lie in a block of this device (sync.number_out_of_block). Receiving has no
// captured time field, so the device time goes into the audit event of the operation.
import { receiveSpecimen } from '../service/specimen.service.js';
import { scopedRead, specimenMoveAdapter, type ReadSpecimen } from './specimenMove.js';

/** Default seam: lab.specimens of this tenant, visible only inside the actor's centre scope (as online). */
const readSpecimen = scopedRead('SELECT status, version, centre_id, processing_centre_id FROM lab.specimens WHERE tenant_id = $1 AND id = $2');

export function createAccessionReceiveAdapter(deps: { readSpecimen?: ReadSpecimen } = {}) {
  return specimenMoveAdapter({
    opType: 'accession.receive', permission: 'lab.specimen.receive', schema: 'ReceiveSpecimenRequest', from: ['collected', 'in_transit'], to: 'received',
    move: receiveSpecimen, readSpecimen: deps.readSpecimen ?? readSpecimen, body: (op) => op.payload, audit: true,
  });
}
export const accessionReceiveAdapter = createAccessionReceiveAdapter();
