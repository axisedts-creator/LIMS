import 'server-only';
// BFF calls for the collect / dispatch / receive screens. Barcode and registration no travel in POST bodies only (REQ-SEC-028, REQ-SEC-098).
// Bulk + reject send Idempotency-Key (required); receive sends it too (optional); receive/reject send If-Match "<version>".
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { BARCODE_RE, KEY_RE, REGNO_RE, UUID_RE, type BulkItem, type BulkRow, type LookupKey, type RejectBody, type RejectResult, type Specimen } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const uuid = (v: unknown) => {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw bad();
  return v;
};
const post = <T>(path: string, body: unknown, o: { key?: string; version?: number } = {}) => {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && (!Number.isInteger(o.version) || o.version < 1)) throw bad();
  return serverFetch<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(o.key ? { 'idempotency-key': o.key } : {}), ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}) },
    body: JSON.stringify(body),
  });
};
const items = (list: BulkItem[]) => {
  if (!Array.isArray(list) || list.length < 1 || list.length > 200) throw bad();
  return list.map((i) => ({ id: uuid(i?.id), version: i.version }));
};

/** barcode → one SpecimenDto; registration_no → { data: [] } (unknown → empty list). Always returned as a list. */
export async function lookupSpecimens(k: LookupKey): Promise<Specimen[]> {
  if (typeof k !== 'object' || k === null) throw bad();
  if ('barcode' in k) {
    if (typeof k.barcode !== 'string' || !BARCODE_RE.test(k.barcode)) throw bad();
    return [await post<Specimen>('/v1/lab/specimens/lookup', { barcode: k.barcode })];
  }
  if (typeof k.registration_no !== 'string' || !REGNO_RE.test(k.registration_no)) throw bad();
  return (await post<{ data: Specimen[] }>('/v1/lab/specimens/lookup', { registration_no: k.registration_no })).data;
}

export async function bulkCollect(list: BulkItem[], key: string): Promise<BulkRow[]> {
  return (await post<{ results: BulkRow[] }>('/v1/lab/specimens/bulk-collect', { items: items(list) }, { key })).results;
}
export async function bulkDispatch(list: BulkItem[], key: string): Promise<BulkRow[]> {
  return (await post<{ results: BulkRow[] }>('/v1/lab/specimens/bulk-dispatch', { items: items(list) }, { key })).results;
}

export const receiveSpecimen = (id: string, version: number, centreId: string, key: string) =>
  post<Specimen>(`/v1/lab/specimens/${uuid(id)}/receive`, { processing_centre_id: uuid(centreId) }, { key, version });

export function rejectSpecimen(id: string, version: number, b: RejectBody, key: string) {
  if (typeof b?.reason_code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(b.reason_code)) throw bad();
  if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 500)) throw bad();
  if (typeof b.recollection_required !== 'boolean') throw bad();
  return post<RejectResult>(
    `/v1/lab/specimens/${uuid(id)}/reject`,
    { reason_code: b.reason_code, ...(b.comment ? { comment: b.comment } : {}), recollection_required: b.recollection_required },
    { key, version },
  );
}
