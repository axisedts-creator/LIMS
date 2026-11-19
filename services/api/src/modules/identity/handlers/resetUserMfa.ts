// POST /users/{membership_id}/reset-mfa (02-TRD §5.3; US-B5). If-Match required; 200 User + ETag.
import { bindUser, versioned } from './user.http.js';
import { guarded } from './_guard.js';

export const resetUserMfa = guarded('identity.user.manage', bindUser((s, ctx, req) => s.resetUserMfa(ctx, versioned(req, { reason_text: 'reasonText' })), { etag: true }));
