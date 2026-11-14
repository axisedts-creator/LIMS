// H19 PUT /v1/homecollection/settings (If-Match "<version>")
import type { Handler } from '../../../core/module.js';
import { updateHomecollectionSettings } from '../settings.service.js';

export const handler: Handler = (req, ctx) => updateHomecollectionSettings(ctx, req.headers, req.body);
