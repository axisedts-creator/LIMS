// POST /platform/dead-letters/{dead_letter_id}/replay (02-TRD §5.10; 08 A6.4, A9.3). If-Match -> expectedVersion; reason_text optional. 200 + ETag.
import { bindDeadLetter, deadLetterId, reasonText } from './dead-letter.http.js';
import { ifMatch } from './role.http.js';

export const replayDeadLetter = bindDeadLetter(
  (s, ctx, req) => s.replayDeadLetter(ctx, { deadLetterId: deadLetterId(req), expectedVersion: ifMatch(req), reasonText: reasonText(req) }),
  { etag: true },
);
