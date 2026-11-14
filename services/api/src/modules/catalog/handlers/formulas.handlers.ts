// #36 validateFormula (02-TRD §5.2 row 36). Read-only POST: the core pipeline owns auth and the catalog.test.read floor; the service validates its own strict body.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createFormulasService } from '../service/formulas.service.js';
import type { Ctx } from '../service/masters.service.js';

export const formulasHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  validateFormula: (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await createFormulasService().validateFormula({ tenantId: c.tenantId, tx: c.tx, ...(c.now ? { now: c.now } : {}) }, req.body) };
  }) as Handler,
});
