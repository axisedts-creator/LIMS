// POST /platform/ird-annexes/{record_id}/transition (03-APP-FLOW §2.5; AC-E3.1-E3.3). If-Match required; 200 + ETag (IR7: the successor).
import { bindIrd, ifMatch, obj, recordId } from './ird.http.js';

export const transitionIrdAnnex = bindIrd((s, ctx, req) => {
  const b = obj(req.body);
  return s.transitionIrdAnnex(ctx, {
    recordId: recordId(req), expectedVersion: ifMatch(req), toStatus: b['to_status'],
    submittedOn: b['submitted_on'], completedOn: b['completed_on'], referenceNo: b['reference_no'], note: b['note'],
  });
}, { etag: true });
