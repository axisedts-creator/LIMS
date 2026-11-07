// GET /settings (02-TRD §5.6). 200 TenantSettingsDto + ETag.
import { bindSettings } from './settings.http.js';

export const getSettings = bindSettings((s, ctx) => s.getSettings(ctx, {}), { etag: true });
