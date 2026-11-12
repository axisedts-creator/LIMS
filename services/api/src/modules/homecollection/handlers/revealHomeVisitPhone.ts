// H21 POST /v1/homecollection/visits/{visit_id}/phone-reveal (visit.assign). The phone is shown only on this explicit, audited reveal (REQ-SEC-081/096/097): H1 / H2 carry none.
// Load through the RLS repo (404) -> assertRole(visit.assign, centre of the visit) -> FrontdeskPort.getPatientDemographics (errors propagate) -> ONE access-log row home_visit.view / phone_reveal.
// The number is never stored, logged or put in the access-log row; this handler writes nothing else.
import type { Handler } from '../../../core/module.js';
import { HOMECOLLECTION_PERMISSIONS } from '../permissions.js';
import { ctxOf, loadVisit, uuidParam } from '../service/visitRead.service.js';

const PERM_VISIT_ASSIGN = HOMECOLLECTION_PERMISSIONS[1];   // 'homecollection.visit.assign'

export const handler: Handler = async (req, hctx) => {
  const ctx = ctxOf(hctx);
  const p = req.params as Record<string, unknown> | null;
  const visit = await loadVisit(ctx, uuidParam(p?.['visit_id'], '/visit_id'), PERM_VISIT_ASSIGN);
  const patient = await ctx.ports.FrontdeskPort['getPatientDemographics'](ctx, { patientId: visit['patient_id'], purpose: 'home_visit' });
  await ctx.audit.access({ action: 'home_visit.view', entityType: 'home_visit', entityId: visit['id'], centreId: visit['centre_id'], purpose: 'phone_reveal', outcome: 'allowed' });   // one row per reveal, no dedupe (review #18)
  const phone: unknown = patient?.phoneE164;
  return { status: 200, body: typeof phone === 'string' && phone !== '' ? { phone_e164: phone } : {} };   // absent, not null, when the patient has none
};
