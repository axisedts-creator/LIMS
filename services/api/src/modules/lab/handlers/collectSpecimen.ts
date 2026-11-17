// #4 POST /v1/lab/specimens/{specimen_id}/collect (If-Match "<version>"; S2; AC-03.1, AC-03.4; LD-25 entry_mode)
import type { Handler } from '../../../core/module.js';
import { collectSpecimen } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => collectSpecimen(ctx, req.params, req.headers, req.body);
