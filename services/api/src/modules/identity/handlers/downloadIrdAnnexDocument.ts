// GET /platform/ird-annexes/{record_id}/documents/{document_id}/content (P-2, P-19). Bytes and headers come from the service (storage.read + P-2 headers), unchanged.
import { bindIrd, obj, recordId } from './ird.http.js';

export const downloadIrdAnnexDocument = bindIrd((s, ctx, req) =>
  s.downloadIrdAnnexDocument(ctx, { recordId: recordId(req), documentId: obj(req.params)['document_id'] }));
