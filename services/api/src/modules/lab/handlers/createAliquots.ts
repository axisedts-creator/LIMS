// #11 POST /v1/lab/specimens/{specimen_id}/aliquots (If-Match "<version>"; S5, 1..10 aliquots; 08 A13 D-13)
import type { Handler } from '../../../core/module.js';
import { createAliquots } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => createAliquots(ctx, req.params, req.headers, req.body);
