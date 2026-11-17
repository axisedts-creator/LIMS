// HC-T06: visit_specimens read model refresh (02-TRD §4.1, §10 homecollection.refresh_visit_specimens; 05-SCHEMA visit_specimens).
// LabPort.lookupSpecimens({orderId}) -> upsert by (tenant, visit, specimen). Never DELETEs, never lowers last_seq, never stores the barcode (no column; never logged).
// A port failure throws before any write (the queue retries, 10 attempts). The route version moves only when a row really changed.
import { LimsError } from '../../core/errors.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { getRouteById, updateRoute } from './repository/routes.repo.js';
import type { Tx } from './repository/shared.repo.js';
import { getVisitById } from './repository/visits.repo.js';
import { insertVisitSpecimen, listVisitSpecimensByVisit, updateVisitSpecimen } from './repository/visitSpecimens.repo.js';

type Obj = Record<string, any>;
export const REFRESH_TASK = 'homecollection.refresh_visit_specimens';
export interface SpecimenCtx {
  readonly tenantId: string; readonly tx: Tx; now(): string | Date;
  readonly db: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly ports: { readonly LabPort: { lookupSpecimens(c: unknown, i: { orderId: string }): Promise<Obj[] | null | undefined> } };
}

/** Job key refresh:<visit_id> dedupes queued refreshes (02-TRD §10). Needs ctx.tx with matching tenant claims (app.enqueue_job). */
export async function enqueueSpecimenRefresh(c: { tenantId: string; tx: Tx }, visitId: string): Promise<void> {
  await c.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [REFRESH_TASK, JSON.stringify({ tenant_id: c.tenantId, visit_id: visitId }), `refresh:${visitId}`]);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export async function refreshVisitSpecimens(c: SpecimenCtx, visitId: string): Promise<void> {
  const visit = await getVisitById(c.tx, c.tenantId, visitId);
  if (!visit?.['order_id']) return;                                                                 // gone, or no order yet (booking visit before assign)
  const refs = await c.db.tx((x) => c.ports.LabPort.lookupSpecimens(x, { orderId: visit['order_id'] }));
  const now = new Date(c.now());
  const have = new Map((await listVisitSpecimensByVisit(c.tx, c.tenantId, visitId)).map((r) => [r['specimen_id'] as string, r]));
  let changed = false;
  for (const ref of refs ?? []) {
    const specimenId = str(ref?.['specimenId']), type = str(ref?.['specimenTypeCode']), status = str(ref?.['status']);
    if (!specimenId || !type || !status || ref['orderId'] !== visit['order_id']) continue;         // defence in depth: only this visit's order
    const next = { specimen_type_code: type, container_code: str(ref['containerCode']), status, is_active: ref['isActive'] !== false, replaces_specimen_id: str(ref['replacesSpecimenId']) };
    const row = have.get(specimenId);
    if (!row) {
      await insertVisitSpecimen(c.tx, c.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visitId, specimen_id: specimenId, order_id: visit['order_id'], ...next, last_seq: 0, refreshed_at: now });
      changed = true;
    } else {
      const same = (Object.keys(next) as Array<keyof typeof next>).every((k) => row[k] === next[k]);
      if (!(await updateVisitSpecimen(c.tx, c.tenantId, row['id'], row['version'], { ...next, refreshed_at: now }))) throw new LimsError('common.version_conflict');
      changed ||= !same;
    }
  }
  if (changed && visit['route_id']) {                                                               // TRD §4.1: the phlebotomist snapshot changed
    const route = await getRouteById(c.tx, c.tenantId, visit['route_id']);
    if (route && !(await updateRoute(c.tx, c.tenantId, route['id'], route['version'], {}))) throw new LimsError('common.version_conflict');
  }
}
