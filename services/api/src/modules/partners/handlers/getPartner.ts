// SA3 getPartner — GET /admin/partners/{partner_id} (partners.partner.read). Logic in service/partner.service.ts.
import type { Handler } from '../../../core/module.js';
import { get } from '../service/partner.service.js';

export const getPartner: Handler = (req, ctx) => get(req, ctx);
