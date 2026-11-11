// PATCH /users/{membership_id} (02-TRD §5.3; US-B6; D-T7). If-Match required; 200 User + ETag.
import { bindUser, versioned } from './user.http.js';

export const updateUser = bindUser((s, ctx, req) => s.updateUser(ctx, versioned(req, {
  display_name: 'displayName', phone_e164: 'phoneE164', signatory_title: 'signatoryTitle', signatory_registration_no: 'signatoryRegistrationNo', unset: 'unset',
})), { etag: true });
