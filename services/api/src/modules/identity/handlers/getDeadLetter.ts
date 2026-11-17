// GET /platform/dead-letters/{dead_letter_id} (02-TRD §5.10; 08 A9.1). 200 + ETag.
import { bindDeadLetter, deadLetterId } from './dead-letter.http.js';

export const getDeadLetter = bindDeadLetter((s, ctx, req) => s.getDeadLetter(ctx, { deadLetterId: deadLetterId(req) }), { etag: true });
