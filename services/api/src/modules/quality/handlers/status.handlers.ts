// #34 getQcStatusBoard (02-TRD §5.5, §5.10). Schema, auth and x-permission are enforced by the core pipeline from contracts/openapi/quality.yaml; this maps query -> service
// and fails closed without a request context. A list: no ETag. Tenant and actor come from the context only.
import type { Handler } from '../../../core/module.js';
import { createStatusService } from '../service/status.service.js';
import { obj, staff } from './setup.handlers.js';

const status = createStatusService();   // methods are looked up per call

export const statusHandlers = Object.freeze({
  getQcStatusBoard: staff((c, req) => {
    const q = obj(req.query);
    return status.getQcStatusBoard(c as any, { instrumentId: q['instrument_id'], status: q['status'], overdueOnly: q['overdue_only'], cursor: q['cursor'], limit: q['limit'] });
  }),
} satisfies Record<string, Handler>);
