// #5–#16 masters handlers (02-TRD §5). Schema, auth, x-permission and Idempotency-Key are the core pipeline's (catalog.yaml);
// these map request -> service and fail closed without an authenticated request context (same convention as C6 handlers).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createCommentsService } from '../service/comments.service.js';
import { createMastersService } from '../service/masters.service.js';

type Ctx = Parameters<ReturnType<typeof createMastersService>[string]>[0] & { events?: Parameters<typeof createMastersService>[0]['events'] };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (428); malformed -> 0 (400 from the service). */
export function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  return m ? Number(m[1]) : 0;
}

function bind(op: string, run: (call: (input: unknown) => Promise<any>, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events) throw new LimsError('auth.unauthenticated');
    const deps = { events: c.events };
    const fn = ({ ...createMastersService(deps), ...createCommentsService(deps) } as Record<string, (ctx: Ctx, input: unknown) => Promise<any>>)[op]!;
    return run((input) => fn(c as Ctx, input), req);
  };
}

// #5–#16 use path param `id`; units / value sets (#17–#22, T-05) use `unit_id` / `value_set_id`; comment codes (#57–#59, T-13) `comment_code_id` (catalog.yaml).
const RESOURCES: Array<[string, string]> = [['Department', 'id'], ['SpecimenType', 'id'], ['Container', 'id'], ['Method', 'id'], ['Unit', 'unit_id'], ['ValueSet', 'value_set_id'],
  ['CommentCode', 'comment_code_id']];
const entries: Array<[string, Handler]> = RESOURCES.flatMap(([R, param]) => [
  [`list${R}s`, bind(`list${R}s`, async (call, req) => ({ status: 200, body: await call(req.query) }))],
  [`create${R}`, bind(`create${R}`, async (call, req) => ({ status: 201, body: await call(req.body) }))],
  [`update${R}`, bind(`update${R}`, async (call, req) => ({
    status: 200, body: await call({ id: obj(req.params)[param], expectedVersion: ifMatch(req), patch: req.body }),
  }))],
] as Array<[string, Handler]>);

export const mastersHandlers: Readonly<Record<string, Handler>> = Object.freeze(Object.fromEntries(entries));
