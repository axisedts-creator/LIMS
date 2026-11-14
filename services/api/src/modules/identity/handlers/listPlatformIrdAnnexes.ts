// GET /platform/ird-annexes (02-TRD §5.10). No tenant_id = platform-level Annex 1 records only.
import { bindIrd, obj } from './ird.http.js';

export const listPlatformIrdAnnexes = bindIrd((s, ctx, req) => {
  const q = obj(req.query);
  return s.listPlatformIrdAnnexes(ctx, { tenantId: q['tenant_id'], annexCode: q['annex_code'], status: q['status'] });
});
