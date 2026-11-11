// #2 GET /v1/lab/specimens (keyset cursor; 02-TRD §5.1 row 2)
import type { Handler } from '../../../core/module.js';
import { listSpecimens } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => listSpecimens(ctx, req.query);
