// C12.T-08 handlers #11-#25 (02-TRD §5.1). Order, always:
//  * tenant-scope operations (#17-#22) and the two visible-branch lists (#11, #23): permission gate (NO branchId; before any tx statement or validation, so a stranger learns nothing) -> If-Match -> strict body / query -> service;
//  * store-scope operations (#12-#16, #24, #25): If-Match -> strict body / query (tx untouched) -> service, which loads the store, answers 404 for an invisible branch, then assertRole({permission, branchId}) (P-B8).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import * as svc from '../service/masters.service.js';
import { parseIfMatch } from './items.schemas.js';
import {
  parseBindingList, parseBindingPut, parseOptionalIfMatch, parseSettingPut, parseSettingsList, parseStoreCreate, parseStoreList, parseStorePatch, parseSupplierCreate, parseSupplierItemList,
  parseSupplierItemPut, parseSupplierList, parseSupplierPatch,
} from './masters.schemas.js';

type Params = Record<string, unknown>;
const params = (req: HandlerRequest): Params => (typeof req.params === 'object' && req.params !== null ? (req.params as Params) : {});
const id = (req: HandlerRequest, name: string): string => String(params(req)[name]); // a non-uuid is "no such row" in the service (404)
const gate = (ctx: HandlerContext, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const ok = (body: unknown) => ({ status: 200, body });
const created = (body: unknown) => ({ status: 201, body });

const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.masterManage;

export const masterHandlers: Readonly<Record<string, Handler>> = {
  listInventoryStores: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.listStores(ctx, parseStoreList(req.query)));
  },
  createInventoryStore: async (req, ctx) => created(await svc.createStore(ctx, parseStoreCreate(req.body))),
  getInventoryStore: async (req, ctx) => ok(await svc.getStoreFull(ctx, id(req, 'store_id'))),
  updateInventoryStore: async (req, ctx) => {
    const v = parseIfMatch(req.headers);
    return ok(await svc.patchStore(ctx, id(req, 'store_id'), v, parseStorePatch(req.body)));
  },
  listStoreItemSettings: async (req, ctx) => ok(await svc.listStoreItemSettings(ctx, id(req, 'store_id'), parseSettingsList(req.query))),
  putStoreItemSetting: async (req, ctx) => {
    const v = parseOptionalIfMatch(req.headers);
    return ok(await svc.putStoreItemSetting(ctx, id(req, 'store_id'), id(req, 'item_id'), v, parseSettingPut(req.body)));
  },
  listInventorySuppliers: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.listSuppliers(ctx, parseSupplierList(req.query)));
  },
  createInventorySupplier: async (req, ctx) => {
    await gate(ctx, MANAGE);
    return created(await svc.createSupplier(ctx, parseSupplierCreate(req.body)));
  },
  getInventorySupplier: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.getSupplierFull(ctx, id(req, 'supplier_id')));
  },
  updateInventorySupplier: async (req, ctx) => {
    await gate(ctx, MANAGE);
    const v = parseIfMatch(req.headers);
    return ok(await svc.patchSupplier(ctx, id(req, 'supplier_id'), v, parseSupplierPatch(req.body)));
  },
  listSupplierItems: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.listSupplierItemsOf(ctx, id(req, 'supplier_id'), parseSupplierItemList(req.query)));
  },
  putSupplierItem: async (req, ctx) => {
    await gate(ctx, MANAGE);
    const v = parseOptionalIfMatch(req.headers);
    return ok(await svc.putSupplierItemOf(ctx, id(req, 'supplier_id'), id(req, 'item_id'), id(req, 'pack_id'), v, parseSupplierItemPut(req.body)));
  },
  listInstrumentBindings: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.listBindings(ctx, parseBindingList(req.query)));
  },
  putInstrumentBinding: async (req, ctx) => {
    const v = parseOptionalIfMatch(req.headers);
    return ok(await svc.putBinding(ctx, id(req, 'instrument_id'), parseBindingPut(req.body), v));
  },
  deactivateInstrumentBinding: async (req, ctx) => ok(await svc.deactivateBinding(ctx, id(req, 'instrument_id'), parseIfMatch(req.headers))),
};
