// #10 POST /v1/lab/specimens/{specimen_id}/recollect(If-Match "<version>"; S12 late recollection: 08 A13 D-5, D-6, D-12)
import type { Handler } from '../../../core/module.js';
import { requestRecollection } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => requestRecollection(ctx, req.params, req.headers, req.body);
