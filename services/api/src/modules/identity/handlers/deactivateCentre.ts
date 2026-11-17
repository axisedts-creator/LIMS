// POST /centres/{centre_id}/deactivate (02-TRD §5.5; AC-C1.2). Row kept, memberships untouched; 200 + ETag.
import { bindOrg, centreId, ifMatch } from './branchCentre.http.js';

export const deactivateCentre = bindOrg((s, ctx, req) => s.deactivateCentre(ctx, { centreId: centreId(req), expectedVersion: ifMatch(req) }), { etag: true });
