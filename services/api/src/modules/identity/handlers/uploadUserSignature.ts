// POST /users/{membership_id}/signature (02-TRD §5.3; US-B6; P-19). Path id + the multipart file only; 200 User + ETag.
import { obj } from './role.http.js';
import { bindUser, membershipId } from './user.http.js';

export const uploadUserSignature = bindUser((s, ctx, req) => s.uploadUserSignature(ctx, { membershipId: membershipId(req), file: obj(req.body)['file'] }), { etag: true });
