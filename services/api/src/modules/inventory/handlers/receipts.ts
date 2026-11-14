// C12.T-12 handlers #49-#55 (02-TRD §5.4). Order, always:
//  * #49 WITHOUT store_id (visible-branch list) and #55: permission gate (NO branchId; before any tx statement or validation) -> strict query -> service. #55 asserts BOTH
//    inventory.report.export (privileged: the identity port answers auth.mfa_required below aal2, PE-1) and inventory.cost.read (the export is money-only);
//  * #49 with store_id, #50: strict query / body (tx untouched) -> service, which reads the store (404) and asserts the permission for its branch (403, P-B8);
//  * #51-#54: path id (400) -> If-Match (428 / 400) -> Idempotency-Key on #50 / #53 (P-8, 400 common.idempotency_key_required) -> strict body -> service,
//    which reads the GRN (404), asserts the permission for its branch (403), then transition (409) -> If-Match version (409) -> body / row rules.
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { PERMISSIONS } from '../permissions.js';
import { isUuid } from '../repository/_base.js';
import * as svc from '../service/receipts.service.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';
import { parseNoBody } from './purchasing.schemas.js';
import { parseGrnCancel, parseGrnCreate, parseGrnExport, parseGrnList, parseGrnReplace } from './receipts.schemas.js';

const ok = (body: unknown) => ({ status: 200, body });
const pathId = (req: HandlerRequest): string => {
  const v = isObj(req.params) ? req.params['grn_id'] : undefined;
  if (!isUuid(v)) throw invalid(fieldError('/grn_id'));
  return v;
};
/** P-8: the key is mandatory on #50 / #53 (the C0 core also refuses it, x-idempotency: required); replay of a stored key is the pipeline's job. */
const requireKey = (req: HandlerRequest): void => {
  const k = isObj(req.headers) ? req.headers['idempotency-key'] : undefined;
  if (typeof k !== 'string' || k.trim() === '') throw new LimsError('common.idempotency_key_required');
};
/** #49: the permission is checked first only when no store_id is named (tenant-wide list); with a store_id the store decides (404 beats 403). */
const namesStore = (req: HandlerRequest): boolean => isObj(req.query) && req.query['store_id'] !== undefined;

export const receiptHandlers: Readonly<Record<string, Handler>> = {
  listGoodsReceipts: async (req, ctx) => {
    if (!namesStore(req)) await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERMISSIONS.itemRead });
    return ok(await svc.listGoodsReceipts(ctx, parseGrnList(req.query)));
  },
  createGoodsReceipt: async (req, ctx) => {
    requireKey(req);
    return { status: 201, body: await svc.createGoodsReceipt(ctx, parseGrnCreate(req.body)) };
  },
  getGoodsReceipt: async (req, ctx) => ok(await svc.getGoodsReceipt(ctx, pathId(req))),
  replaceGoodsReceiptDraft: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.replaceGoodsReceiptDraft(ctx, id, v, parseGrnReplace(req.body)));
  },
  postGoodsReceipt: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    requireKey(req);
    parseNoBody(req.body);
    return ok(await svc.postGoodsReceipt(ctx, id, v));
  },
  cancelGoodsReceipt: async (req, ctx) => {
    const id = pathId(req);
    const v = parseIfMatch(req.headers);
    return ok(await svc.cancelGoodsReceipt(ctx, id, v, parseGrnCancel(req.body)));
  },
  exportGoodsReceiptsCsv: async (req, ctx) => {
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERMISSIONS.reportExport });
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERMISSIONS.costRead });
    return svc.exportGoodsReceiptsCsv(ctx, parseGrnExport(req.query));
  },
};
