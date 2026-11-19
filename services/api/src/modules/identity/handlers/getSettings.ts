// GET /settings (02-TRD §5.6). 200 TenantSettingsDto + ETag.
import { bindSettings } from './settings.http.js';
import { guarded } from './_guard.js';

export const getSettings = guarded('identity.settings.manage', bindSettings((s, ctx) => s.getSettings(ctx, {}), { etag: true }));
