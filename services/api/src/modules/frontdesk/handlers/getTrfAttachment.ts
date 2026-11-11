// F21 GET /v1/frontdesk/trf-attachments/{attachment_id} (metadata only, never a URL)
import type { Handler } from '../../../core/module.js';
import { getTrfAttachment } from '../service/trf.service.js';

export const handler: Handler = (req, ctx) => getTrfAttachment(ctx, req.params);
