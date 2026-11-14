import 'server-only';
// C11 T-22 reads and writes: assays (K8), molecular results (Q1), batches (Q2-Q7). Ids are validated (REQ-SEC-026/027), bodies are rebuilt field by field against the
// contract (additionalProperties: false, so display fields are never echoed back), row versions go in If-Match, required idempotency keys are forwarded.
// LD-140 (2026-11-13): no UI in this file.
import { serverFetch } from '@/core/api/server-fetch';
import { bad, idemKey, ifMatch, jsonInit, uuid } from './shared';
import type { Assay, Batch, BatchDetail, BatchInput, BatchQuery, MolecularInput, MolecularResult, Page } from './types';

const API = '/v1/anatomic';
const ASSAY_CODE = /^[A-Z0-9_]{1,32}$/;
const RESULT_CODE = /^[a-z0-9_]{1,32}$/;
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CURSOR = /^[A-Za-z0-9_.~=-]{1,512}$/;

const match = (v: unknown, re: RegExp) => {
  if (typeof v !== 'string' || !re.test(v)) throw bad();
  return v;
};
const text = (v: unknown, max: number) => {
  if (typeof v !== 'string' || v.length > max) throw bad();
  return v;
};
/** Empty optional strings are omitted, never sent as "". */
const optText = (v: unknown, max: number) => (v === undefined || v === '' ? undefined : text(v, max));
const optMatch = (v: unknown, re: RegExp) => (v === undefined || v === '' ? undefined : match(v, re));
const put = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));

/** listAnatomicAssays (K8): the picker only offers active assays, targets and values (the UI filters again). */
export const listAssays = async () => (await serverFetch<{ data: Assay[] }>(`${API}/assays`)).data;

/** listAnatomicBatches (Q2): only declared, validated filters reach the API; the Molecular tab asks for up to 200 batches. */
export function listBatches(q: BatchQuery, limit = 50) {
  const p = new URLSearchParams({ limit: String(limit) });
  if (q.status !== undefined) p.set('status', match(q.status, /^(open|closed)$/));
  if (q.assay_code !== undefined) p.set('assay_code', match(q.assay_code, ASSAY_CODE));
  if (q.cursor !== undefined) p.set('cursor', match(q.cursor, CURSOR));
  return serverFetch<Page<Batch>>(`${API}/batches?${p.toString()}`);
}

/** getAnatomicBatch (Q4). */
export const getBatch = (id: string) => serverFetch<BatchDetail>(`${API}/batches/${uuid(id)}`);

/** saveAnatomicMolecularResults (Q1): full replace of the case's results; If-Match = molecular_rev; no idempotency key (x-idempotency: none). */
export function saveMolecularResults(caseId: string, rev: number, results: readonly MolecularInput[]) {
  if (!Array.isArray(results) || results.length > 50) throw bad();
  const body = {
    results: results.map((r) => ({
      assay_code: match(r.assay_code, ASSAY_CODE),
      target_code: match(r.target_code, ASSAY_CODE),
      result_code: match(r.result_code, RESULT_CODE),
      ...put('value_decimal', optMatch(r.value_decimal, DECIMAL)),
      ...put('unit_code', optText(r.unit_code, 32)),
      ...put('method_text', optText(r.method_text, 200)),
      ...put('kit_name', optText(r.kit_name, 120)),
      ...put('kit_lot', optText(r.kit_lot, 64)),
      ...put('kit_expiry_on', optMatch(r.kit_expiry_on, ISO_DATE)),
      ...put('batch_id', r.batch_id === undefined ? undefined : uuid(r.batch_id)),
      ...put('comment_text', optText(r.comment_text, 1000)),
    })),
  };
  return serverFetch<{ molecular_rev: number; results: MolecularResult[] }>(`${API}/cases/${uuid(caseId)}/molecular-results`, jsonInit('PUT', body, { 'if-match': ifMatch(rev) }));
}

/** createAnatomicBatch (Q3). */
export function createBatch(input: BatchInput, key: string) {
  const capacity = input.capacity;
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity < 1 || capacity > 384)) throw bad();
  const body = {
    assay_code: match(input.assay_code, ASSAY_CODE),
    ...put('kit_name', optText(input.kit_name, 120)),
    ...put('kit_lot', optText(input.kit_lot, 64)),
    ...put('kit_expiry_on', optMatch(input.kit_expiry_on, ISO_DATE)),
    ...put('instrument_text', optText(input.instrument_text, 120)),
    ...put('run_at', optMatch(input.run_at, ISO_UTC)),
    ...put('capacity', capacity),
  };
  return serverFetch<Batch>(`${API}/batches`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}

/** addAnatomicBatchMembers (Q5): one member per scan; no If-Match (the API rejects a taken position with 409). */
export function addBatchMembers(batchId: string, members: readonly { case_id: string; position: number }[], key: string) {
  if (!Array.isArray(members) || members.length < 1 || members.length > 96) throw bad();
  const body = {
    members: members.map((m) => {
      if (!Number.isInteger(m.position) || m.position < 1 || m.position > 384) throw bad();
      return { case_id: uuid(m.case_id), position: m.position };
    }),
  };
  return serverFetch<BatchDetail>(`${API}/batches/${uuid(batchId)}/members`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}

/** removeAnatomicBatchMembers (Q6). */
export function removeBatchMembers(batchId: string, version: number, caseIds: readonly string[], key: string) {
  if (!Array.isArray(caseIds) || caseIds.length < 1 || caseIds.length > 96) throw bad();
  return serverFetch<BatchDetail>(`${API}/batches/${uuid(batchId)}/members/remove`, jsonInit('POST', { case_ids: caseIds.map(uuid) }, { 'if-match': ifMatch(version), 'idempotency-key': idemKey(key) }));
}

/** closeAnatomicBatch (Q7). */
export const closeBatch = (batchId: string, version: number, key: string) =>
  serverFetch<BatchDetail>(`${API}/batches/${uuid(batchId)}/close`, { method: 'POST', headers: { 'if-match': ifMatch(version), 'idempotency-key': idemKey(key) } });
