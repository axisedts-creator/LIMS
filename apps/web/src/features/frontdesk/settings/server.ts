import 'server-only';
// BFF for /frontdesk/settings: F24 getFrontdeskSettings (GET) and updateFrontdeskSettings (PUT, If-Match "<version>"), permission frontdesk.settings.manage.
// LD-255 (ADMINPAGE-FD-1). The API enforces the permission and the aal2 step-up; this file only calls the one operation.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { FrontdeskSettings, FrontdeskSettingsBody } from './model';

const PATH = '/v1/frontdesk/settings';

export const getFrontdeskSettings = () => serverFetch<FrontdeskSettings>(PATH);

export function updateFrontdeskSettings(version: number, body: FrontdeskSettingsBody) {
  if (!Number.isInteger(version) || version < 1) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  return serverFetch<FrontdeskSettings>(PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
    body: JSON.stringify(body),
  });
}
