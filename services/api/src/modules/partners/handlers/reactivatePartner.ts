// SA6 reactivatePartner — POST /admin/partners/{partner_id}/reactivate (partners.partner.manage, If-Match). Logic in service/partner.service.ts.
import type { Handler } from '../../../core/module.js';
import { reactivate } from '../service/partner.service.js';

export const reactivatePartner: Handler = (req, ctx) => reactivate(req, ctx);
