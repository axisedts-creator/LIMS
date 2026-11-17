// lab.specimen.status_changed.v1 -> visit_specimens read model of every recent visit of the order (US-14-1/2; 02-TRD §8.2 row 4, §4.1; 03-IC §3.7).
// The event is the source: no LabPort call, no barcode (payload has none, table has no column), no log lines (07-SECURITY). The C0 wrapper did inbox dedupe + validation + tx.
// A per-(tenant, specimen) advisory lock serialises racing deliveries, so a loser sees the winner's committed row instead of a raw unique violation.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { getRouteById, updateRoute } from '../../../../../api/src/modules/homecollection/repository/routes.repo.js';
import { insertVisitSpecimen, listVisitSpecimensByVisit, updateVisitSpecimen } from '../../../../../api/src/modules/homecollection/repository/visitSpecimens.repo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOW_DAYS = 30;                                                                             // [CONV] 02-TRD §8.2: visits created within 30 days
const bad = (): LimsError => new LimsError('common.validation_failed');
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(); return v; };
const text = (v: unknown): string => { if (typeof v !== 'string' || !v) throw bad(); return v; };

export const onSpecimenStatusChanged: ConsumerHandler = async (event, ctx: any) => {
  if (event?.tenant_id !== ctx.tenantId) return;                                                    // tenant isolation: foreign event = no-op
  const p = event.payload ?? {}, seq = event.aggregate?.seq;
  if (!Number.isInteger(seq) || seq < 0) throw bad();
  const specimenId = uuid(p['specimen_id']), orderId = uuid(p['order_id']), type = text(p['specimen_type_code']), status = text(p['to_status']);
  const replaces = p['replaces_specimen_id'] == null ? null : uuid(p['replaces_specimen_id']);
  const tenant: string = ctx.tenantId, tx = ctx.tx;

  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenant}:homecollection.specimen:${specimenId}`]);
  const since = new Date(new Date(ctx.now()).getTime() - WINDOW_DAYS * 86_400_000);
  const { rows: visits } = await tx.query(
    'SELECT id, centre_id, route_id FROM homecollection.visits WHERE tenant_id = $1 AND order_id = $2 AND created_at >= $3 ORDER BY created_at, id', [tenant, orderId, since]);
  if (visits.length === 0) return;                                                                  // US-14-2: no visit for the order -> inbox only

  const now = new Date(ctx.now()), routes = new Set<string>();
  for (const v of visits) {
    const row = (await listVisitSpecimensByVisit(tx, tenant, v.id)).find((r) => r['specimen_id'] === specimenId);
    if (!row) {
      await insertVisitSpecimen(tx, tenant, { id: uuidv7(), centre_id: v.centre_id, visit_id: v.id, specimen_id: specimenId, order_id: orderId, specimen_type_code: type, status,
        is_active: true, replaces_specimen_id: replaces, last_seq: seq, refreshed_at: now });
    } else if (seq > row['last_seq']) {                                                              // stale / equal seq changes nothing
      if (!(await updateVisitSpecimen(tx, tenant, row['id'], row['version'], { status, last_seq: seq, refreshed_at: now }))) throw new LimsError('common.version_conflict');
    } else continue;
    if (v.route_id) routes.add(v.route_id);
  }
  for (const id of routes) {                                                                        // TRD §4.1: the phlebotomist snapshot changed, once per route
    const route = await getRouteById(tx, tenant, id);
    if (route && !(await updateRoute(tx, tenant, id, route['version'], {}))) throw new LimsError('common.version_conflict');
  }
};
