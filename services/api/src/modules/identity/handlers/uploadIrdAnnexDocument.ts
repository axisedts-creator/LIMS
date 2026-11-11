// POST /platform/ird-annexes/{record_id}/documents (02-TRD §5.10; P-19). Multipart file only; 201 IrdAnnexDocument.
import { bindIrd, obj, recordId } from './ird.http.js';

export const uploadIrdAnnexDocument = bindIrd((s, ctx, req) => s.uploadIrdAnnexDocument(ctx, { recordId: recordId(req), file: obj(req.body)['file'] }));
