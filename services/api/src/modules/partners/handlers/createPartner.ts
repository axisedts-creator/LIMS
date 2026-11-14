// SA2 createPartner — POST /admin/partners (partners.partner.manage, privileged). Logic in service/partner.service.ts.
import type { Handler } from '../../../core/module.js';
import { create } from '../service/partner.service.js';

export const createPartner: Handler = (req, ctx) => create(req, ctx);
