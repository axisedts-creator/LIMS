// F1 POST /v1/frontdesk/patients/search. Schema/auth/x-permission are the core pipeline's; logic in service/patient.service.ts.
import type { Handler } from '../../../core/module.js';
import { searchPatients } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => searchPatients(ctx, req.body);
