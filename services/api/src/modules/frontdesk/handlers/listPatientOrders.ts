// F6 GET /v1/frontdesk/patients/{patient_id}/orders (keyset cursor)
import type { Handler } from '../../../core/module.js';
import { listPatientOrders } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => listPatientOrders(ctx, req.params, req.query);
