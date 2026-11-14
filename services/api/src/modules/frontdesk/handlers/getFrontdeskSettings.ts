// F24 GET /v1/frontdesk/settings
import type { Handler } from '../../../core/module.js';
import { getFrontdeskSettings } from '../service/settings.service.js';

export const handler: Handler = (_req, ctx) => getFrontdeskSettings(ctx);
