// #12 POST /v1/lab/specimens/{specimen_id}/store (If-Match "<version>"; S13; LD-25 entry_mode)
import type { Handler } from '../../../core/module.js';
import { storeSpecimen } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => storeSpecimen(ctx, req.params, req.headers, req.body);
