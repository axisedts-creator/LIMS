// C12.T-26 handlers #90 / #91 (02-TRD §5.9). #90: tenant-wide list gates inventory.item.read first; with a store_id the store decides (404 beats 403). #91: If-Match -> path id -> service (scope inside, P-B8).
import type { Handler } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import { isUuid } from '../repository/_base.js';
import * as svc from '../service/alerts.api.service.js';
import { parseAlertList } from './alerts.schemas.js';
import { fieldError, invalid, isObj, parseIfMatch } from './items.schemas.js';

export const alertHandlers: Readonly<Record<string, Handler>> = {
  listInventoryAlerts: async (req, ctx) => {
    if (!(isObj(req.query) && req.query['store_id'] !== undefined)) await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERMISSIONS.itemRead });
    return { status: 200, body: await svc.listAlerts(ctx, parseAlertList(req.query)) };
  },
  acknowledgeInventoryAlert: async (req, ctx) => {
    const v = parseIfMatch(req.headers);
    const id = isObj(req.params) ? req.params['alert_id'] : undefined;
    if (!isUuid(id)) throw invalid(fieldError('/alert_id'));
    return { status: 200, body: await svc.acknowledgeAlert(ctx, id, v) };
  },
};
