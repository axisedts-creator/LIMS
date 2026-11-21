// POST /centres (02-TRD §5.5; AC-C1.1). 201 + ETag.
import { CENTRE_FIELDS, bindOrg, pick } from './branchCentre.http.js';
import { guarded } from './_guard.js';

export const createCentre = guarded('identity.centre.manage', bindOrg((s, ctx, req) => s.createCentre(ctx, pick(req.body, CENTRE_FIELDS)), { etag: true }));
