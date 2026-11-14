import 'server-only';
// #33 updateAnalyteVersionDraft (If-Match). 409 catalog.version_in_use when the version is no longer a draft.
import { serverFetch } from '@/core/api/server-fetch';
import { ifMatch, json, uuid } from './guard';
import type { AnalyteVersion } from './types';

export const updateAnalyteVersionDraft = async (versionId: string, version: number, fields: Partial<Omit<AnalyteVersion, 'id' | 'status' | 'version' | 'version_no'>>) =>
  serverFetch<AnalyteVersion>(`/v1/catalog/analyte-versions/${uuid(versionId)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(fields) });
