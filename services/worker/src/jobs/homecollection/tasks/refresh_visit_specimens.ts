// homecollection.refresh_visit_specimens {tenant_id, visit_id} (02-TRD §10, 10 attempts): LabPort.lookupSpecimens -> visit_specimens upsert. Port errors propagate (queue retry).
import type { TaskHandler } from '../../../core/manifest.js';
import { refreshVisitSpecimens as refresh } from '../../../../../api/src/modules/homecollection/specimen.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const refreshVisitSpecimens: TaskHandler = async (payload, ctx: any) => {
  if (payload?.tenant_id !== ctx.tenantId) return;
  const visitId = payload['visit_id'];
  if (typeof visitId !== 'string' || !UUID.test(visitId)) return;
  await refresh(ctx, visitId);
};
