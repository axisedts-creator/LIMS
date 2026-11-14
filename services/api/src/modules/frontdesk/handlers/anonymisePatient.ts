// F7 POST /v1/frontdesk/patients/{patient_id}/anonymise (If-Match "<version>", Idempotency-Key; privileged, aal2)
import type { Handler } from '../../../core/module.js';
import { anonymisePatient } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => anonymisePatient(ctx, req.params, req.headers, req.body);
