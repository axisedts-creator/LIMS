// #9 POST /v1/lab/specimens/{specimen_id}/reject (If-Match "<version>"; S11, + S12 when recollection_required: 08 A13 D-5, D-12, D-13)
import type { Handler } from '../../../core/module.js';
import { rejectSpecimen } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => rejectSpecimen(ctx, req.params, req.headers, req.body);
