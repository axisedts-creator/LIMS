// POST /platform/ird-annexes (02-TRD §5.10; IR1). 201 + ETag. Only the IrdAnnexCreateRequest fields are forwarded.
import { bindIrd, obj } from './ird.http.js';

export const createPlatformIrdAnnex = bindIrd((s, ctx, req) => {
  const b = obj(req.body);
  return s.createPlatformIrdAnnex(ctx, { softwareVersion: b['software_version'], notes: b['notes'] });
}, { etag: true });
