import 'server-only';
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { bad, int, pick, uuid } from './shared';
import type { Doctor } from './types';

const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/; // [CONV] merge keys are ≥ 8 characters

/** POST /doctors/{id}/merge — merges `id` (the source) into `into_doctor_id`. Body is exactly {into_doctor_id}. */
export async function mergeDoctor(id: string, version: number, input: unknown, idempotencyKey?: string): Promise<Doctor> {
  uuid(id);
  int(1, Number.MAX_SAFE_INTEGER)(version);
  const body = pick(input, { into_doctor_id: uuid }, ['into_doctor_id']);
  if (String(body['into_doctor_id']).toLowerCase() === id.toLowerCase()) throw bad(); // a doctor cannot be merged into itself
  if (idempotencyKey !== undefined && !KEY_RE.test(idempotencyKey)) throw bad();
  return serverFetch<Doctor>(`/v1/catalog/doctors/${id}/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"`, 'idempotency-key': idempotencyKey ?? randomUUID() },
    body: JSON.stringify(body),
  });
}
