// P2 searchPartnerOrderables — GET /price-list/orderables (partners.manifest.submit). Logic in service/manifest.service.ts.
import type { Handler } from '../../../core/module.js';
import { searchOrderables } from '../service/manifest.service.js';

export const searchPartnerOrderables: Handler = (req, ctx) => searchOrderables(req, ctx);
