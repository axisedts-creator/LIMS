// H18 GET /v1/homecollection/settings
import type { Handler } from '../../../core/module.js';
import { getHomecollectionSettings } from '../settings.service.js';

export const handler: Handler = (_req, ctx) => getHomecollectionSettings(ctx);
