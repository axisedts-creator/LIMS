// F21a GET /v1/frontdesk/trf-attachments/{attachment_id}/content (clean only; ctx.download.stream, trf.view access-log row; 08 A13 P-2)
// T0B-FILESTREAM-1 (LD-312): the request headers go along for Range / If-None-Match / If-Range.
import type { Handler } from '../../../core/module.js';
import type { RequestHeaders } from '../../../core/storage/stream.js';
import { getTrfAttachmentContent } from '../service/trf.service.js';

export const handler: Handler = (req, ctx) => getTrfAttachmentContent(ctx, req.params, req.headers as RequestHeaders);
