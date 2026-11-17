// F25 GET /v1/frontdesk/coded-sets/{set_name}
import type { Handler } from '../../../core/module.js';
import { listFrontdeskCodes } from '../service/settings.service.js';

export const handler: Handler = (req, ctx) => listFrontdeskCodes(ctx, req.params);
