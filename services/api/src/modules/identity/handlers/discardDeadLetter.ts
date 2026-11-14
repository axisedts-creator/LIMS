// POST /platform/dead-letters/{dead_letter_id}/discard (02-TRD §5.10; 08 A6.4, A8.4). If-Match -> expectedVersion; reason_text required. 200 + ETag.
import { bindDeadLetter, deadLetterId, reasonText } from './dead-letter.http.js';
import { ifMatch } from './role.http.js';

export const discardDeadLetter = bindDeadLetter(
  (s, ctx, req) => s.discardDeadLetter(ctx, { deadLetterId: deadLetterId(req), expectedVersion: ifMatch(req), reasonText: reasonText(req) }),
  { etag: true },
);
