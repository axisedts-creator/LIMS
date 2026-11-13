// SA7 resyncPartnerProjections — POST /admin/partners/{partner_id}/resync (partners.partner.manage). Logic in service/partner.service.ts.
import type { Handler } from '../../../core/module.js';
import { resync } from '../service/partner.service.js';

export const resyncPartnerProjections: Handler = (req, ctx) => resync(req, ctx);
