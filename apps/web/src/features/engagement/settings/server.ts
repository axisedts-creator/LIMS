import 'server-only';
// BFF for /engagement/settings: T1 getEngagementSettings (GET) and T2 updateEngagementSettings (PUT, If-Match "<version>"), permission engagement.settings.manage.
// LD-255 (ADMINPAGE-ENG-1). The API enforces the permission and the aal2 step-up; the only other call is the C2 centre list for the home-collection centre Select.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { EngagementSettings, EngagementSettingsBody } from './model';

const PATH = '/v1/engagement/settings';

export const getEngagementSettings = () => serverFetch<EngagementSettings>(PATH);

export function updateEngagementSettings(version: number, body: EngagementSettingsBody) {
  if (!Number.isInteger(version) || version < 1) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  return serverFetch<EngagementSettings>(PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
    body: JSON.stringify(body),
  });
}

/** C2 listCentres (identity.centre.read, not an engagement permission): a failure only means the Select shows the current centre alone. */
export const listCentreOptions = () =>
  serverFetch<{ data?: { centre_id?: string; id?: string; name: string }[] }>('/v1/identity/centres').then(
    (r) => (r.data ?? []).map((c) => ({ value: (c.centre_id ?? c.id) as string, label: c.name })),
    () => [] as { value: string; label: string }[],
  );
