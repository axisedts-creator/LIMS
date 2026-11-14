// GET /centres (02-TRD §5.5; AC-C1.2 picker uses is_active=true). 200, no ETag.
import { bindOrg, listQuery } from './branchCentre.http.js';

export const listCentres = bindOrg((s, ctx, req) => s.listCentres(ctx, listQuery(req, { branch_id: 'branchId', kind: 'kind', is_active: 'isActive' })));
