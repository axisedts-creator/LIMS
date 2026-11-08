import 'server-only';
// #51 previewReferenceRange: a read-only POST. age_days is required by the API (0–73000).
import { serverFetch } from '@/core/api/server-fetch';
import { badRequest, json } from './guard';
import { SEXES, UUID_RE, type PreviewInput, type PreviewResult } from './types';

export async function previewReferenceRange(input: PreviewInput): Promise<PreviewResult> {
  const { analyte_id, sex, age_days, birth_on, specimen_type_code, at } = input;
  if (!UUID_RE.test(analyte_id) || !SEXES.includes(sex) || !Number.isInteger(age_days) || age_days < 0 || age_days > 73000) throw badRequest();
  return serverFetch<PreviewResult>('/v1/catalog/reference-ranges/preview', {
    method: 'POST',
    headers: json(),
    body: JSON.stringify({ analyte_id, sex, age_days, ...(birth_on ? { birth_on } : {}), ...(specimen_type_code ? { specimen_type_code } : {}), ...(at ? { at } : {}) }),
  });
}
