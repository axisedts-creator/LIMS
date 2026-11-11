// #3 GET /v1/lab/specimens/{specimen_id} (02-TRD §5.1 row 3, §5.9)
import type { Handler } from '../../../core/module.js';
import { getSpecimen } from '../service/specimen.service.js';

export const handler: Handler = (req, ctx) => getSpecimen(ctx, req.params);
