// F21a GET /v1/frontdesk/trf-attachments/{attachment_id}/content (clean only; ctx.download.stream, trf.view access-log row; 08 A13 P-2)
import type { Handler } from '../../../core/module.js';
import { getTrfAttachmentContent } from '../service/trf.service.js';

export const handler: Handler = (req, ctx) => getTrfAttachmentContent(ctx, req.params);
