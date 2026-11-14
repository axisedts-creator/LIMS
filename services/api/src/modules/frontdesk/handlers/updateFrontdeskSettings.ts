// F24 PUT /v1/frontdesk/settings (If-Match "<version>")
import type { Handler } from '../../../core/module.js';
import { updateFrontdeskSettings } from '../service/settings.service.js';

export const handler: Handler = (req, ctx) => updateFrontdeskSettings(ctx, req.headers, req.body);
