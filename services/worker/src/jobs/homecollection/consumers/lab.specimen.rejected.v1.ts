// lab.specimen.rejected.v1 -> recollection visit + flag recollection_required (US-11-1/2; 02-TRD §8.2 row 5; 03-IC §3.8; 03-APP-FLOW V3).
// recollection_required = false -> nothing (the read model moves via status_changed). Idempotent per specimen: unique (tenant, recollection_of_specimen_id) + an advisory lock
// on (tenant, specimen), so redeliveries (same or new event_id) and races end with ONE visit, ONE flag, ONE transition. The parent visit and its order are never modified.
// Logs nothing: no patient id, barcode or address (07-SECURITY).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { insertVisitFlag } from '../../../../../api/src/modules/homecollection/repository/visitFlags.repo.js';
import { insertVisitTransition } from '../../../../../api/src/modules/homecollection/repository/visitTransitions.repo.js';
import { getVisitById, insertVisit } from '../../../../../api/src/modules/homecollection/repository/visits.repo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = (): LimsError => new LimsError('common.validation_failed');
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(); return v; };

export const onSpecimenRejected: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;                                                    // tenant isolation: foreign event = no-op
  const p = event.payload ?? {};
  if (p['recollection_required'] !== true) return;                                                  // US-11-2
  const specimenId = uuid(p['specimen_id']), orderId = uuid(p['order_id']), homeVisitId = p['home_visit_id'] == null ? null : uuid(p['home_visit_id']);
  const tenant: string = ctx.tenantId, tx = ctx.tx;

  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenant}:homecollection.recollection:${specimenId}`]);
  const done = await tx.query('SELECT 1 FROM homecollection.visits WHERE tenant_id = $1 AND recollection_of_specimen_id = $2', [tenant, specimenId]);
  if (done.rows.length > 0) return;                                                                 // redelivery / same specimen under a new event_id

  let parent = homeVisitId ? await getVisitById(tx, tenant, homeVisitId) : null;
  if (parent?.['order_id'] !== orderId) {                                                           // unknown, or a visit of ANOTHER order: never a parent
    parent = (await tx.query('SELECT * FROM homecollection.visits WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1', [tenant, orderId])).rows[0] ?? null;
  }
  if (!parent) return;                                                                              // no-visit order: ignored

  const visit = await insertVisit(tx, tenant, { id: uuidv7(), centre_id: parent['centre_id'], branch_id: parent['branch_id'], kind: 'recollection', status: 'unassigned',
    parent_visit_id: parent['id'], recollection_of_specimen_id: specimenId, patient_id: parent['patient_id'], order_id: orderId, home_address_id: parent['home_address_id'],
    address_text: parent['address_text'], landmark: parent['landmark'], latitude: parent['latitude'], longitude: parent['longitude'] });
  await insertVisitTransition(tx, tenant, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], from_status: null, to_status: 'unassigned', cause: 'consumer', at: new Date(ctx.now()) });
  await insertVisitFlag(tx, tenant, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], kind: 'recollection_required', status: 'open', related_id: specimenId });
};
