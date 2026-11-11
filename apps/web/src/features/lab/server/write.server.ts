import 'server-only';
// BFF calls for the collect / dispatch / receive screens. Barcode and registration no travel in POST bodies only (REQ-SEC-028, REQ-SEC-098).
// Bulk + reject send Idempotency-Key (required); receive sends it too (optional); receive/reject send If-Match "<version>".
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { BARCODE_RE, KEY_RE, REGNO_RE, UUID_RE, type AssignBody, type BulkItem, type BulkRow, type DiscardBody, type ExceptionAction, type IngestException, type LookupKey, type RejectBody, type RejectResult, type ResultBulkRow, type Specimen, type VerifyItem } from './types';

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

const FLAGS = ['delta', 'critical', 'unit_mismatch', 'instrument_flag'];
/** #28 bulkVerifyResults / bulk-approve: Idempotency-Key required; 403 auth.mfa_required passes through for the step-up retry with the SAME key. Approve never carries acknowledged_flags. */
async function bulkResults(op: 'verify' | 'approve', list: VerifyItem[], key: string): Promise<ResultBulkRow[]> {
  if (!Array.isArray(list) || list.length < 1 || list.length > 200) throw bad();
  const body = list.map((i) => {
    const o: VerifyItem = { id: uuid(i?.id), version: i.version };
    if (!Number.isInteger(o.version) || o.version < 1) throw bad();
    if (op === 'verify' && i.acknowledged_flags?.length) {
      if (!Array.isArray(i.acknowledged_flags) || i.acknowledged_flags.some((f) => !FLAGS.includes(f))) throw bad();
      o.acknowledged_flags = i.acknowledged_flags;
    }
    return o;
  });
  return (await post<{ results: ResultBulkRow[] }>(`/v1/lab/results/bulk-${op}`, { items: body }, { key })).results;
}
export const bulkVerifyResults = (list: VerifyItem[], key: string) => bulkResults('verify', list, key);
export const bulkApproveResults = (list: VerifyItem[], key: string) => bulkResults('approve', list, key);

/** C5.T-23 #41 reapply: body {} (the tenant and the actor are never sent). */
export const reapplyException = (id: string) => post<ExceptionAction>(`/v1/lab/ingest-exceptions/${uuid(id)}/reapply`, {});

/** #42 discard: reason_code from lab.exception_discard_reasons, comment <= 300 (omitted when empty). */
export function discardException(id: string, b: DiscardBody) {
  if (typeof b?.reason_code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(b.reason_code)) throw bad();
  if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 300)) throw bad();
  return post<IngestException>(`/v1/lab/ingest-exceptions/${uuid(id)}/discard`, { reason_code: b.reason_code, ...(b.comment ? { comment: b.comment } : {}) });
}

/** #40 assign: Idempotency-Key required; override_analyte only when true. */
export function assignException(id: string, b: AssignBody, key: string) {
  const body = { result_id: uuid(b?.result_id), ...(b.override_analyte === true ? { override_analyte: true } : {}) };
  return post<ExceptionAction>(`/v1/lab/ingest-exceptions/${uuid(id)}/assign`, body, { key });
}

export const receiveSpecimen =(id: string, version: number, centreId: string, key: string) =>
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
