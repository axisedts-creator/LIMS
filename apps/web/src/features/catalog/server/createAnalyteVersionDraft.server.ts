import 'server-only';
// #32 createAnalyteVersionDraft (Idempotency-Key). 409 common.version_conflict when a draft already exists.
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, json, uuid } from './guard';
import type { AnalyteVersion } from './types';

export const createAnalyteVersionDraft = async (analyteId: string, idempotencyKey: string, copyFromVersionNo?: number) =>
  serverFetch<AnalyteVersion>(`/v1/catalog/analytes/${uuid(analyteId)}/versions`, {
    method: 'POST',
    headers: json({ 'idempotency-key': idemKey(idempotencyKey) }),
    body: JSON.stringify(copyFromVersionNo === undefined ? {} : { copy_from_version_no: copyFromVersionNo }),
  });
