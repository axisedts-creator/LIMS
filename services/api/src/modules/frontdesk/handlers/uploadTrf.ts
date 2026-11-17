// F20 POST /v1/frontdesk/trf-attachments (multipart: body.file + centre_id + order_id?; 02-TRD §5.1 F20)
import type { Handler } from '../../../core/module.js';
import { uploadTrf } from '../service/trf.service.js';

export const handler: Handler = (req, ctx) => uploadTrf(ctx, req.body);
