import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { members } from './specs';
import { int, pick, uuid } from './shared';
import type { Panel } from './types';

/** PUT /panels/{id}/members — replaces the whole membership; 422 catalog.panel_cycle / catalog.test_inactive surface as ApiError. */
export async function replacePanelMembers(id: string, version: number, input: unknown): Promise<Panel> {
  uuid(id);
  int(1, Number.MAX_SAFE_INTEGER)(version);
  const body = pick(input, { members }, ['members']);
  return serverFetch<Panel>(`/v1/catalog/panels/${id}/members`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
    body: JSON.stringify(body),
  });
}
