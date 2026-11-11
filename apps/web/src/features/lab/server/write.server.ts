import 'server-only';
// BFF calls for the collect / dispatch / receive screens. Barcode and registration no travel in POST bodies only (REQ-SEC-028, REQ-SEC-098).
// Bulk + reject send Idempotency-Key (required); receive sends it too (optional); receive/reject send If-Match "<version>".
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { BARCODE_RE, KEY_RE, OCCURRED_AT_RE, REGNO_RE, UUID_RE, type AmendBody, type BulkItem, type BulkRow, type DowntimeFields, type EnterEntry, type EnterResponse, type GridResult, type LookupKey, type RejectBody, type RejectResult, type ResultBulkRow, type ReturnBody, type Specimen, type VerifyItem } from './types';

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

// ── C5.T-20 result entry. LD-25 (2026-11-07): entry_mode / occurred_at / downtime_ref travel top-level in the bulk-enter body; the API re-checks every limit.
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const DEC_RE = /^-?[0-9]{1,18}(\.[0-9]{1,12})?$/;
const ORD_RE = /^[A-Z0-9_+-]{1,16}$/;
const valueOf = (v: Pick<EnterEntry, 'value_numeric' | 'value_text' | 'ordinal_code' | 'comment_codes' | 'comment_text'>) => {
  const n = [v.value_numeric, v.value_text, v.ordinal_code].filter((x) => x !== undefined).length;
  if (n > 1) throw bad();
  if (v.value_numeric !== undefined && !DEC_RE.test(v.value_numeric)) throw bad();
  if (v.value_text !== undefined && (typeof v.value_text !== 'string' || v.value_text.length > 2000)) throw bad();
  if (v.ordinal_code !== undefined && !ORD_RE.test(v.ordinal_code)) throw bad();
  if (v.comment_codes !== undefined && (!Array.isArray(v.comment_codes) || v.comment_codes.length > 10 || v.comment_codes.some((c) => !CODE_RE.test(c)))) throw bad();
  if (v.comment_text !== undefined && (typeof v.comment_text !== 'string' || v.comment_text.length > 1000)) throw bad();
  return {
    ...(v.value_numeric !== undefined ? { value_numeric: v.value_numeric } : {}),
    ...(v.value_text !== undefined ? { value_text: v.value_text } : {}),
    ...(v.ordinal_code !== undefined ? { ordinal_code: v.ordinal_code } : {}),
    ...(v.comment_codes?.length ? { comment_codes: v.comment_codes } : {}),
    ...(v.comment_text ? { comment_text: v.comment_text } : {}),
  };
};

export async function bulkEnterResults(list: EnterEntry[], key: string, downtime?: DowntimeFields): Promise<EnterResponse> {
  if (!Array.isArray(list) || list.length < 1 || list.length > 200) throw bad();
  const entries = list.map((e) => {
    if (!Number.isInteger(e?.version) || e.version < 1) throw bad();
    return { result_id: uuid(e.result_id), version: e.version, ...valueOf(e) };
  });
  let dt = {};
  if (downtime !== undefined) {
    if (downtime.entry_mode !== 'downtime_backentry' || typeof downtime.occurred_at !== 'string' || !OCCURRED_AT_RE.test(downtime.occurred_at)
      || typeof downtime.downtime_ref !== 'string' || downtime.downtime_ref.length < 1 || downtime.downtime_ref.length > 32) throw bad();
    dt = { entry_mode: downtime.entry_mode, occurred_at: downtime.occurred_at, downtime_ref: downtime.downtime_ref };
  }
  return post<EnterResponse>('/v1/lab/results/bulk-enter', { entries, ...dt }, { key });
}

export function returnResult(id: string, version: number, b: ReturnBody) {
  if (typeof b?.reason_code !== 'string' || !CODE_RE.test(b.reason_code)) throw bad();
  if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 500)) throw bad();
  return post<GridResult>(`/v1/lab/results/${uuid(id)}/return`, { reason_code: b.reason_code, ...(b.comment ? { comment: b.comment } : {}) }, { version });
}

export function amendResult(id: string, version: number, b: AmendBody, key: string) {
  if (typeof b?.amendment_reason_code !== 'string' || !CODE_RE.test(b.amendment_reason_code)) throw bad();
  if (b.amendment_reason_text !== undefined && (typeof b.amendment_reason_text !== 'string' || b.amendment_reason_text.length > 500)) throw bad();
  return post<GridResult>(
    `/v1/lab/results/${uuid(id)}/amend`,
    { ...valueOf(b), amendment_reason_code: b.amendment_reason_code, ...(b.amendment_reason_text ? { amendment_reason_text: b.amendment_reason_text } : {}) },
    { key, version },
  );
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
