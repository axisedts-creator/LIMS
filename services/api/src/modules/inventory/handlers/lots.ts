// C12.T-09 handlers #30-#39 (02-TRD §5.2). Order, always:
//  * tenant scope (#30-#33) and #34 / #35 WITHOUT store_id (visible branches): permission gate (NO branchId; before any tx statement or validation) -> If-Match -> strict body / query -> service;
//  * #32 / #33 are privileged (PE-1): the identity port refuses aal1 with auth.mfa_required, the handler lets that through untouched;
//  * store scope (#34 / #35 with store_id, #36-#39): If-Match -> strict body / query (tx untouched) -> service, which loads the store (or the container, then its store), answers 404 for an invisible
//    branch, then assertRole({permission, branchId}) (P-B8).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import * as svc from '../service/lots.service.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';
import {
  parseBalanceQuery, parseContainerFinish, parseContainerList, parseContainerOpen, parseFefoQuery, parseLotExpiry, parseLotList, parseLotStatus, parseMovementQuery,
} from './lots.schemas.js';
import { isUuid } from '../repository/_base.js';

const READ = PERMISSIONS.itemRead;
const ADJUST = PERMISSIONS.stockAdjust;
const gate = (ctx: HandlerContext, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const ok = (body: unknown) => ({ status: 200, body });
/** A path id must be a uuid: anything else is a malformed request (400), never a SQL error. */
const pathId = (req: HandlerRequest, name: string): string => {
  const v = isObj(req.params) ? req.params[name] : undefined;
  if (!isUuid(v)) throw invalid(fieldError(`/${name}`));
  return v;
};
/** #34 / #35: the permission is checked first only when no store_id is named (tenant-wide list); with a store_id the store decides (404 beats 403). */
const namesStore = (req: HandlerRequest): boolean => isObj(req.query) && req.query['store_id'] !== undefined;

export const lotHandlers: Readonly<Record<string, Handler>> = {
  listInventoryLots: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.listLots(ctx, parseLotList(req.query)));
  },
  getInventoryLot: async (req, ctx) => {
    await gate(ctx, READ);
    return ok(await svc.getLotFull(ctx, pathId(req, 'lot_id')));
  },
  setInventoryLotStatus: async (req, ctx) => {
    await gate(ctx, ADJUST);
    const v = parseIfMatch(req.headers);
    const id = pathId(req, 'lot_id');
    return ok(await svc.setLotStatus(ctx, id, v, parseLotStatus(req.body)));
  },
  correctInventoryLotExpiry: async (req, ctx) => {
    await gate(ctx, ADJUST);
    const v = parseIfMatch(req.headers);
    const id = pathId(req, 'lot_id');
    return ok(await svc.correctLotExpiry(ctx, id, v, parseLotExpiry(req.body)));
  },
  listStockBalances: async (req, ctx) => {
    if (!namesStore(req)) await gate(ctx, READ);
    return ok(await svc.listBalances(ctx, parseBalanceQuery(req.query)));
  },
  listStockMovements: async (req, ctx) => {
    if (!namesStore(req)) await gate(ctx, READ);
    return ok(await svc.listMovements(ctx, parseMovementQuery(req.query)));
  },
  getFefoSuggestion: async (req, ctx) => ok(await svc.fefoSuggestion(ctx, parseFefoQuery(req.query))),
  listOpenedContainers: async (req, ctx) => ok(await svc.listContainers(ctx, parseContainerList(req.query))),
  openContainer: async (req, ctx) => ({ status: 201, body: await svc.openContainer(ctx, parseContainerOpen(req.body)) }),
  finishContainer: async (req, ctx) => {
    const id = pathId(req, 'container_id');
    const v = parseIfMatch(req.headers);
    return ok(await svc.finishContainer(ctx, id, v, parseContainerFinish(req.body)));
  },
};
