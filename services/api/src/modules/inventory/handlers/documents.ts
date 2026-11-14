// C12.T-10 handlers #40-#48 (02-TRD §5.2 #40, §5.3 #41-#48). Order, always:
//  * #41 WITHOUT store_id (visible-branch list): permission gate (NO branchId; before any tx statement or validation) -> strict query -> service;
//  * #40: path id (400) -> If-Match (428 / 400) -> strict body (tx untouched) -> service (container 404 -> bench.record at its branch 403);
//  * #41 with store_id, #42-#48: strict path / query / body (tx untouched) -> service, which loads the store (or the document), answers 404 for an invisible branch, then assertRole({permission, branchId}) (P-B8).
//  * #48 is privileged (PE-1): the identity port refuses aal1 with auth.mfa_required; the handler lets that through untouched.
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import { isUuid } from '../repository/_base.js';
import * as docs from '../service/documents.service.js';
import { discardContainer } from '../service/lots.service.js';
import { parseAdjustment, parseDiscard, parseDocList, parseIssue, parseStoreReturn, parseSupplierReturn, parseWastage, parseWriteOff } from './documents.schemas.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';

const ok = (body: unknown) => ({ status: 200, body });
const created = (body: unknown) => ({ status: 201, body });
const pathId = (req: HandlerRequest, name: string): string => {
  const v = isObj(req.params) ? req.params[name] : undefined;
  if (!isUuid(v)) throw invalid(fieldError(`/${name}`));
  return v;
};
/** #41: the permission is checked first only when no store_id is named (tenant-wide list); with a store_id the store decides (404 beats 403). */
const namesStore = (req: HandlerRequest): boolean => isObj(req.query) && req.query['store_id'] !== undefined;

export const documentHandlers: Readonly<Record<string, Handler>> = {
  discardContainer: async (req, ctx) => {
    const id = pathId(req, 'container_id');
    const v = parseIfMatch(req.headers);
    return ok(await discardContainer(ctx, id, v, parseDiscard(req.body)));
  },
  listStockDocuments: async (req, ctx) => {
    if (!namesStore(req)) await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERMISSIONS.itemRead });
    return ok(await docs.listDocuments(ctx, parseDocList(req.query)));
  },
  getStockDocument: async (req, ctx) => ok(await docs.getDocument(ctx, pathId(req, 'document_id'))),
  createStockIssue: async (req, ctx) => created(await docs.createStockIssue(ctx, parseIssue(req.body))),
  createStoreReturn: async (req, ctx) => created(await docs.createStoreReturn(ctx, parseStoreReturn(req.body))),
  createSupplierReturn: async (req, ctx) => created(await docs.createSupplierReturn(ctx, parseSupplierReturn(req.body))),
  recordWastage: async (req, ctx) => created(await docs.recordWastage(ctx, parseWastage(req.body))),
  writeOffExpiredStock: async (req, ctx) => created(await docs.writeOffExpiredStock(ctx, parseWriteOff(req.body))),
  createStockAdjustment: async (req, ctx) => created(await docs.createStockAdjustment(ctx, parseAdjustment(req.body))),
};
