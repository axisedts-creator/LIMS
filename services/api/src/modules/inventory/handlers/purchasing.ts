// C12.T-11 handlers #80-#89 (02-TRD §5.5). Order, always:
//  * #80 (visible-branch list): permission gate (NO branchId; before any tx statement or validation) -> strict query -> service;
//  * #81 / #88 (branch(store)): strict body (tx untouched) -> service, which reads the store (404) and asserts the permission for its branch (403, P-B8);
//  * #82-#89 (branch(PO)): path id (400) -> If-Match (428 / 400) -> Idempotency-Key on #84 / #86 / #87 (P-8, 400 common.idempotency_key_required) -> strict body -> service,
//    which reads the PO (404), asserts the permission for its branch (403), then transition (409) -> If-Match version (409) -> body rules (422).
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { PERMISSIONS } from '../permissions.js';
import { isUuid } from '../repository/_base.js';
import * as svc from '../service/purchasing.service.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';
import { parseCancel, parseClose, parseNoBody, parsePoDraft, parsePoList, parseReorder, parseSent } from './purchasing.schemas.js';

const ok = (body: unknown) => ({ status: 200, body });
const pathId = (req: HandlerRequest): string => {
  const v = isObj(req.params) ? req.params['po_id'] : undefined;
  if (!isUuid(v)) throw invalid(fieldError('/po_id'));
  return v;
};
/** P-8: the key is mandatory on #84 / #86 / #87 (the C0 core also refuses it, x-idempotency: required); replay of a stored key is the pipeline's job. */
const requireKey = (req: HandlerRequest): void => {
  const k = isObj(req.headers) ? req.headers['idempotency-key'] : undefined;
  if (typeof k !== 'string' || k.trim() === '') throw new LimsError('common.idempotency_key_required');
};

export const purchasingHandlers: Readonly<Record<string, Handler>> = {
  listPurchaseOrders: async (req, ctx) => {
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERMISSIONS.itemRead });
    return ok(await svc.listPurchaseOrders(ctx, parsePoList(req.query)));
  },
  createPurchaseOrder: async (req, ctx) => ({ status: 201, body: await svc.createPurchaseOrder(ctx, parsePoDraft(req.body)) }),
  getPurchaseOrder: async (req, ctx) => ok(await svc.getPurchaseOrder(ctx, pathId(req))),
  replacePurchaseOrderDraft: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.replacePurchaseOrderDraft(ctx, id, v, parsePoDraft(req.body)));
  },
  approvePurchaseOrder: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    requireKey(req);
    parseNoBody(req.body);
    return ok(await svc.approvePurchaseOrder(ctx, id, v));
  },
  markPurchaseOrderSent: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.markPurchaseOrderSent(ctx, id, v, parseSent(req.body)));
  },
  cancelPurchaseOrder: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    requireKey(req);
    return ok(await svc.cancelPurchaseOrder(ctx, id, v, parseCancel(req.body)));
  },
  closePurchaseOrder: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    requireKey(req);
    return ok(await svc.closePurchaseOrder(ctx, id, v, parseClose(req.body)));
  },
  createPurchaseOrdersFromReorder: async (req, ctx) => ({ status: 201, body: await svc.createPurchaseOrdersFromReorder(ctx, parseReorder(req.body)) }),
  getPurchaseOrderPrintView: async (req, ctx) => ok(await svc.getPurchaseOrderPrintView(ctx, pathId(req))),
};
