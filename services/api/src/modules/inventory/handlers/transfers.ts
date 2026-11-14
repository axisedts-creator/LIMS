// C12.T-13 handlers #56-#62 (02-TRD §5.5). Order, always:
//  * #56 (visible-branch list): permission gate (NO branchId; before any tx statement or validation) -> strict query -> service;
//  * #57-#62: path id (400) -> If-Match (428 / 400) -> strict body (tx untouched) -> service, which loads the row, answers 404 for an invisible transfer / store, then assertRole({permission, branchId})
//    for the end it acts on (scope.service: assertStoreAccess for #57, assertTransferAccess for #58-#62, P-B3 / P-B8).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import { isUuid } from '../repository/_base.js';
import * as svc from '../service/transfers.service.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';
import { parseCancel, parseDispatch, parseReceive, parseTransferCreate, parseTransferList, parseTransferReplace } from './transfers.schemas.js';

const ok = (body: unknown) => ({ status: 200, body });
const pathId = (req: HandlerRequest): string => {
  const v = isObj(req.params) ? req.params['transfer_id'] : undefined;
  if (!isUuid(v)) throw invalid(fieldError('/transfer_id'));
  return v;
};
const gate = (ctx: HandlerContext, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });

export const transferHandlers: Readonly<Record<string, Handler>> = {
  listTransfers: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.itemRead);
    return ok(await svc.listTransfers(ctx, parseTransferList(req.query)));
  },
  createTransfer: async (req, ctx) => ({ status: 201, body: await svc.createTransfer(ctx, parseTransferCreate(req.body)) }),
  getTransfer: async (req, ctx) => ok(await svc.getTransfer(ctx, pathId(req))),
  replaceTransferDraft: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.replaceTransferDraft(ctx, id, v, parseTransferReplace(req.body)));
  },
  dispatchTransfer: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    parseDispatch(req.body);
    return ok(await svc.dispatchTransfer(ctx, id, v));
  },
  receiveTransfer: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.receiveTransfer(ctx, id, v, parseReceive(req.body)));
  },
  cancelTransfer: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.cancelTransfer(ctx, id, v, parseCancel(req.body)));
  },
};
