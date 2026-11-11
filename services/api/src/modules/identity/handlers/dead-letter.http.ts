// Shared request -> dead-letter service glue for the T24 platform handlers (02-TRD §5.10). Platform authz is the service's; this only fails
// closed without an authenticated platform request context and sets ETag "<version>". The default platform_events writer is wired here
// (identity.platform_events insert of ird.repo) so the service itself imports no repository.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createIrdRepo } from '../repository/ird.repo.js';
import { createDeadLetterService, type DeadLetterCtx, type Result } from '../service/dead-letter.service.js';
import { obj } from './role.http.js';

type Svc = ReturnType<typeof createDeadLetterService>;
const repo = createIrdRepo();
const svc = createDeadLetterService({ platformEvents: { insert: (tx, e) => repo.insertPlatformEvent(tx, e) } });

export function bindDeadLetter(fn: (s: Svc, ctx: DeadLetterCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<DeadLetterCtx>;
    if (typeof c?.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as DeadLetterCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  };
}
export const deadLetterId = (req: HandlerRequest) => obj(req.params)['dead_letter_id'];
/** reason_text from the body; a non-object body -> undefined; a non-string value is forwarded as-is for the service to reject. */
export const reasonText = (req: HandlerRequest) => obj(req.body)['reason_text'];
