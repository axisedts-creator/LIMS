// SA5 suspendPartner — POST /admin/partners/{partner_id}/suspend (partners.partner.manage, If-Match). Logic in service/partner.service.ts.
import type { Handler } from '../../../core/module.js';
import { suspend } from '../service/partner.service.js';

export const suspendPartner: Handler = (req, ctx) => suspend(req, ctx);
