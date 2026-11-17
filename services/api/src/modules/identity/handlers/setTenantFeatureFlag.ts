// PUT tenant feature flag (02-TRD §5.6; AC-C5.2, AC-C5.4). If-Match; only is_enabled is forwarded; 200 + ETag.
import { bindSettings, ifMatch, obj } from './settings.http.js';

export const setTenantFeatureFlag = bindSettings(
  (s, ctx, req) => s.setTenantFeatureFlag(ctx, { flagCode: obj(req.params)['flag_code'], isEnabled: obj(req.body)['is_enabled'], expectedVersion: ifMatch(req) }),
  { etag: true },
);
