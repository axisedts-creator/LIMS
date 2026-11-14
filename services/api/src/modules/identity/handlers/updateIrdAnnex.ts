// PATCH /platform/ird-annexes/{record_id} (02-TRD §5.10). If-Match required; 200 + ETag. The service whitelists the patch keys.
import { bindIrd, ifMatch, obj, recordId } from './ird.http.js';

export const updateIrdAnnex = bindIrd(
  (s, ctx, req) => s.updateIrdAnnex(ctx, { recordId: recordId(req), expectedVersion: ifMatch(req), patch: obj(req.body) }),
  { etag: true },
);
