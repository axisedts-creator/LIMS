// C12.T-07 handlers #1-#10 (02-TRD §5.1). Order, always: permission gate (tenant scope, NO branchId; before any tx statement or validation, so a stranger learns nothing)
// -> If-Match -> strict body / query schema -> service. Reads need inventory.item.read, writes inventory.master.manage (not implied by each other).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import * as svc from '../service/items.service.js';
import { parseActive, parseBarcodeAdd, parseBarcodeLookup, parseIfMatch, parseItemCreate, parseItemPatch, parseListQuery, parsePackCreate, parsePackPatch } from './items.schemas.js';

type Params = Record<string, unknown>;
const params = (req: HandlerRequest): Params => (typeof req.params === 'object' && req.params !== null ? (req.params as Params) : {});
const id = (req: HandlerRequest, name: string): string => String(params(req)[name]); // a non-uuid is "no such row" in the service (404)
const gate = (ctx: HandlerContext, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const ok = (body: unknown) => ({ status: 200, body });
const created = (body: unknown) => ({ status: 201, body });

const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.masterManage;

export const itemHandlers: Readonly<Record<string, Handler>> = {
  listInventoryItems: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.listItems(ctx, parseListQuery(req.query)));
  },
  createInventoryItem: async (req, ctx) => {
    await gate(ctx, MANAGE);
    return created(await svc.createItem(ctx, parseItemCreate(req.body)));
  },
  getInventoryItem: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.getItemFull(ctx, id(req, 'item_id')));
  },
  updateInventoryItem: async (req, ctx) => {
    await gate(ctx, MANAGE);
    const v = parseIfMatch(req.headers);
    return ok(await svc.patchItem(ctx, id(req, 'item_id'), v, parseItemPatch(req.body)));
  },
  setInventoryItemActive: async (req, ctx) => {
    await gate(ctx, MANAGE);
    const v = parseIfMatch(req.headers);
    return ok(await svc.setItemActive(ctx, id(req, 'item_id'), v, parseActive(req.body)));
  },
  createInventoryItemPack: async (req, ctx) => {
    await gate(ctx, MANAGE);
    return created(await svc.createPack(ctx, id(req, 'item_id'), parsePackCreate(req.body)));
  },
  updateInventoryItemPack: async (req, ctx) => {
    await gate(ctx, MANAGE);
    const v = parseIfMatch(req.headers);
    return ok(await svc.patchPack(ctx, id(req, 'item_id'), id(req, 'pack_id'), v, parsePackPatch(req.body)));
  },
  addInventoryItemBarcode: async (req, ctx) => {
    await gate(ctx, MANAGE);
    return created(await svc.addBarcode(ctx, id(req, 'item_id'), parseBarcodeAdd(req.body)));
  },
  deactivateInventoryItemBarcode: async (req, ctx) => {
    await gate(ctx, MANAGE);
    return ok(await svc.deactivateBarcode(ctx, id(req, 'item_id'), id(req, 'barcode_id'), parseIfMatch(req.headers)));
  },
  lookupInventoryBarcode: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.lookupBarcode(ctx, parseBarcodeLookup(req.body)));
  },
};
