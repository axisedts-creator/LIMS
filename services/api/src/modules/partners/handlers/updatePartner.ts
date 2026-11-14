// SA4 updatePartner — PATCH /admin/partners/{partner_id} (partners.partner.manage, If-Match). Logic in service/partner.service.ts.
import type { Handler } from '../../../core/module.js';
import { update } from '../service/partner.service.js';

export const updatePartner: Handler = (req, ctx) => update(req, ctx);
