// #7 POST /v1/lab/specimens/{specimen_id}/receive (If-Match "<version>"; S4; AC-04.1, AC-04.3; 08 A13 D-13; LD-25 entry_mode)
import type { Handler } from '../../../core/module.js';
import { receiveSpecimen } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => receiveSpecimen(ctx, req.params, req.headers, req.body);
