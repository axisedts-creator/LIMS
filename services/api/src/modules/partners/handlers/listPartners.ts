// SA1 listPartners — GET /admin/partners (partners.partner.read). Logic in service/partner.service.ts.
import type { Handler } from '../../../core/module.js';
import { list } from '../service/partner.service.js';

export const listPartners: Handler = (req, ctx) => list(req, ctx);
