// POST /centres/{centre_id}/reactivate (02-TRD §5.5). Refused under an inactive branch; 200 + ETag.
import { bindOrg, centreId, ifMatch } from './branchCentre.http.js';
import { guarded } from './_guard.js';

export const reactivateCentre = guarded('identity.centre.manage', bindOrg((s, ctx, req) => s.reactivateCentre(ctx, { centreId: centreId(req), expectedVersion: ifMatch(req) }), { etag: true }));
