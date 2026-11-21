// #48-#50 (TAT alerts; 02-TRD §5.7). Schema, auth, x-permission and Idempotency-Key (required on #50) are enforced by the core pipeline from contracts/openapi/quality.yaml;
// these map request -> service, set ETag, and fail closed without a request context. Bodies are passed unchanged (the service validates and rejects unknown fields).
// Tenant and actor come from the context only; nothing from path/query/header/body is ever read as tenant_id. #49 / #50 carry the item version as ETag (If-Match of #50); a list has none.
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { createTatService } from '../service/tat.service.js';
import { ifMatch, obj, staff } from './setup.handlers.js';

const tat = createTatService();   // methods are looked up per call

const itemId = (req: HandlerRequest) => obj(req.params)['tat_item_id'];
const E = { etag: true } as const;

export const tatHandlers = Object.freeze({
  listTatAlerts: staff((c, req) => {
    const q = obj(req.query);
    return tat.listTatAlerts(c, { level: q['level'], acknowledged: q['acknowledged'], segment: q['segment'], departmentId: q['department_id'], centreId: q['centre_id'], priority: q['priority'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'] });
  }),
  getTatAlert: staff((c, req) => tat.getTatAlert(c, { tatItemId: itemId(req) }), E),
  acknowledgeTatAlert: staff((c, req) => tat.acknowledgeTatAlert(c, { tatItemId: itemId(req), expectedVersion: ifMatch(req), body: req.body }), E),
} satisfies Record<string, Handler>);
