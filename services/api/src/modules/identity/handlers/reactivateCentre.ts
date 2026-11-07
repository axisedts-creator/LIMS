// POST /centres/{centre_id}/reactivate (02-TRD §5.5). Refused under an inactive branch; 200 + ETag.
import { bindOrg, centreId, ifMatch } from './branchCentre.http.js';

export const reactivateCentre = bindOrg((s, ctx, req) => s.reactivateCentre(ctx, { centreId: centreId(req), expectedVersion: ifMatch(req) }), { etag: true });
