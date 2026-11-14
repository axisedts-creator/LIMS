// F5 POST /v1/frontdesk/patients/{patient_id}/consents (append-only; Idempotency-Key required)
import type { Handler } from '../../../core/module.js';
import { recordPatientConsent } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => recordPatientConsent(ctx, req.params, req.body);
