// T0B-SYNC-3 (LD-322, LD-325 b): offline adapter of accession.receive = receiveSpecimen (lab.specimen.receive), entity_id = specimen_id.
// Lab codes used offline (reserved_numbers.lab_codes) must lie in a block of this device (sync.number_out_of_block). Receiving has no
// captured time field, so the device time goes into the audit event of the operation.
import { receiveSpecimen } from '../service/specimen.service.js';
import { specimenMoveAdapter, type ReadSpecimen } from './specimenMove.js';

/** Default seam: the specimen as the request sees it (RLS decides visibility; tenant_id named as everywhere). */
const readSpecimen: ReadSpecimen = async (ctx, id) =>
  (await (ctx as any).tx.query('SELECT status, version FROM lab.specimens WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id])).rows[0];

export function createAccessionReceiveAdapter(deps: { readSpecimen?: ReadSpecimen } = {}) {
  return specimenMoveAdapter({
    opType: 'accession.receive', permission: 'lab.specimen.receive', schema: 'ReceiveSpecimenRequest', from: ['collected', 'in_transit'], to: 'received',
    move: receiveSpecimen, readSpecimen: deps.readSpecimen ?? readSpecimen, body: (op) => op.payload, audit: true,
  });
}
export const accessionReceiveAdapter = createAccessionReceiveAdapter();
