import 'server-only';
// #29 createAnalyte (Idempotency-Key): analyte fields + initial_version.
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, json, uuid } from './guard';

export interface CreateAnalyteInput { code: string; name: string; print_name?: string; report_subheading?: string; initial_version: Record<string, unknown> }
export const createAnalyte = async (testId: string, input: CreateAnalyteInput, idempotencyKey: string) =>
  serverFetch<{ id: string; code: string; draft_version_id?: string }>(`/v1/catalog/tests/${uuid(testId)}/analytes`, {
    method: 'POST',
    headers: json({ 'idempotency-key': idemKey(idempotencyKey) }),
    body: JSON.stringify(input),
  });
