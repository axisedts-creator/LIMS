// #13 POST /v1/lab/specimens/{specimen_id}/discard (If-Match "<version>"; S14, also from recollection_ordered: 08 A13 D-15; LD-25 entry_mode)
import type { Handler } from '../../../core/module.js';
import { discardSpecimen } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => discardSpecimen(ctx, req.params, req.headers, req.body);
