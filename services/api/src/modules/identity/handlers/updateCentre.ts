// PATCH /centres/{centre_id} (02-TRD §5.5). If-Match required; code immutable; 200 + ETag.
import { CENTRE_PATCH, bindOrg, centreId, ifMatch, pick } from './branchCentre.http.js';

export const updateCentre = bindOrg(
  (s, ctx, req) => s.updateCentre(ctx, { centreId: centreId(req), expectedVersion: ifMatch(req), ...pick(req.body, CENTRE_PATCH) }),
  { etag: true },
);
