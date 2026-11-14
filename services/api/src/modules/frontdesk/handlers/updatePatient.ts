// F4 PATCH /v1/frontdesk/patients/{patient_id} (If-Match "<version>")
import type { Handler } from '../../../core/module.js';
import { updatePatient } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => updatePatient(ctx, req.params, req.headers, req.body);
