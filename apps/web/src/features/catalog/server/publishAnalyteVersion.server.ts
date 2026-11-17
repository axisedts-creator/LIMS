import 'server-only';
// #34 publishAnalyteVersion (privileged: If-Match + Idempotency-Key; 403 auth.mfa_required passes through for the step-up retry).
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, ifMatch, json, reason, uuid } from './guard';
import type { AnalyteVersion, PublishBody } from './types';

export async function publishAnalyteVersion(versionId: string, version: number, body: PublishBody, idempotencyKey: string): Promise<AnalyteVersion> {
  const id = uuid(versionId);
  const headers = json({ 'if-match': ifMatch(version), 'idempotency-key': idemKey(idempotencyKey) });
  reason(body.change_reason);
  return serverFetch<AnalyteVersion>(`/v1/catalog/analyte-versions/${id}/publish`, { method: 'POST', headers, body: JSON.stringify(body) });
}
