// GET /centres (02-TRD §5.5; AC-C1.2 picker uses is_active=true). 200, no ETag.
import { bindOrg, listQuery } from './branchCentre.http.js';
import { guarded } from './_guard.js';

export const listCentres = guarded('identity.centre.read', bindOrg((s, ctx, req) => s.listCentres(ctx, listQuery(req, { branch_id: 'branchId', kind: 'kind', is_active: 'isActive' }))));
