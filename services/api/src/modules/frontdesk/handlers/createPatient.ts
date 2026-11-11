// F2 POST /v1/frontdesk/patients (Idempotency-Key required: replay is the core pipeline's).
import type { Handler } from '../../../core/module.js';
import { createPatient } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => createPatient(ctx, req.body);
