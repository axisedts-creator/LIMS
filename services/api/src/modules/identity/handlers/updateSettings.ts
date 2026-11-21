// PATCH /settings (02-TRD §5.6; US-C2, AC-C3.1-3.3). If-Match; the wire body is the patch (field checks in the service); 200 + ETag.
import { bindSettings, ifMatch } from './settings.http.js';
import { guarded } from './_guard.js';

export const updateSettings = guarded('identity.settings.manage', bindSettings((s, ctx, req) => s.updateSettings(ctx, { expectedVersion: ifMatch(req), patch: req.body }), { etag: true }));
