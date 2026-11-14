// F3 GET /v1/frontdesk/patients/{patient_id}
import type { Handler } from '../../../core/module.js';
import { getPatient } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => getPatient(ctx, req.params);
