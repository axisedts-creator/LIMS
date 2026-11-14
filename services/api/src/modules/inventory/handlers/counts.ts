// C12.T-14 handlers #63-#68 (02-TRD §5.6). Order, always:
//  * #63 (visible-branch list): permission gate (NO branchId; before any tx statement or validation) -> strict query -> service;
//  * #64-#68: path id (400) -> If-Match (#67 #68: 428 / 400) -> strict body / query (tx untouched) -> service, which loads the row, answers 404 for an invisible count / store,
//    then assertRole({permission, branchId}) of the store's branch (P-B2 / P-B8).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import { isUuid } from '../repository/_base.js';
import * as svc from '../service/counts.service.js';
import { parseCountCancel, parseCountGet, parseCountList, parseCountOpen, parseCountPost, parseCountRecord } from './counts.schemas.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';

const ok = (body: unknown) => ({ status: 200, body });
const pathId = (req: HandlerRequest): string => {
  const v = isObj(req.params) ? req.params['count_id'] : undefined;
  if (!isUuid(v)) throw invalid(fieldError('/count_id'));
  return v;
};
const gate = (ctx: HandlerContext, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });

export const countHandlers: Readonly<Record<string, Handler>> = {
  listStockCounts: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.itemRead);
    return ok(await svc.listCounts(ctx, parseCountList(req.query)));
  },
  openStockCount: async (req, ctx) => ({ status: 201, body: await svc.openCount(ctx, parseCountOpen(req.body)) }),
  getStockCount: async (req, ctx) => {
    const id = pathId(req);
    return ok(await svc.getCount(ctx, id, parseCountGet(req.query)));
  },
  recordStockCountLines: async (req, ctx) => {
    const id = pathId(req);
    return ok(await svc.recordLines(ctx, id, parseCountRecord(req.body)));
  },
  postStockCount: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.postCount(ctx, id, v, parseCountPost(req.body)));
  },
  cancelStockCount: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    parseCountCancel(req.body);
    return ok(await svc.cancelCount(ctx, id, v));
  },
};
