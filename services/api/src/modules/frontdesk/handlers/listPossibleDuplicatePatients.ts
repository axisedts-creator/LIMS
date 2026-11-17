// F26 GET /v1/frontdesk/patients/possible-duplicates?created_on&cursor&limit
import type { Handler } from '../../../core/module.js';
import { listPossibleDuplicates } from '../service/patient.service.js';

export const handler: Handler = (req, ctx) => listPossibleDuplicates(ctx, req.query);
