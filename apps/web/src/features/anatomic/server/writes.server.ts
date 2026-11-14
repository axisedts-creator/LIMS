import 'server-only';
// C11 writes for the T-19 case workspace. Bodies are rebuilt field by field (no mass assignment); row versions go in If-Match (02-CONVENTIONS §4);
// x-idempotency: required operations carry the client's Idempotency-Key. LD-140 (2026-11-13): no UI in this file.
import { serverFetch } from '@/core/api/server-fetch';
import { bad, idemKey, ifMatch, jsonInit, uuid } from './shared';
import type { AccessionInput, CancelInput, CaseDetail, GrossInput, GrossRecord, Part, PartInput, TransitionOp } from './types';

const OPS: readonly TransitionOp[] = ['start-processing', 'mark-ready'];
const API = '/v1/anatomic/cases';

const str = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad();
  return v;
};
const opt = (v: unknown, max: number) => (v === undefined ? undefined : str(v, 0, max));

/** startAnatomicProcessing (A9) / markAnatomicCaseReady (A10). */
export function transitionCase(caseId: string, op: TransitionOp, v: number, key: string) {
  if (!OPS.includes(op)) throw bad();
  return serverFetch<CaseDetail>(`${API}/${uuid(caseId)}/${op}`, { method: 'POST', headers: { 'if-match': ifMatch(v), 'idempotency-key': idemKey(key) } });
}

/** cancelAnatomicCase (A11). */
export function cancelCase(caseId: string, v: number, input: CancelInput, key: string) {
  const reason = str(input.reason_code, 1, 64);
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(reason)) throw bad();
  const text = opt(input.reason_text, 500);
  return serverFetch<CaseDetail>(`${API}/${uuid(caseId)}/cancel`, jsonInit('POST', { reason_code: reason, ...(text ? { reason_text: text } : {}) }, { 'if-match': ifMatch(v), 'idempotency-key': idemKey(key) }));
}

/** accessionAnatomicCase (A4): every existing part must be listed. */
export function accessionCase(caseId: string, v: number, input: AccessionInput, key: string) {
  if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 52) throw bad();
  const history = opt(input.clinical_history_text, 4000);
  const body = {
    ...(history ? { clinical_history_text: history } : {}),
    ...(input.assigned_pathologist_membership_id ? { assigned_pathologist_membership_id: uuid(input.assigned_pathologist_membership_id) } : {}),
    parts: input.parts.map((p) => {
      const description = opt(p.description_text, 1000);
      return { part_id: uuid(p.part_id), site_text: str(p.site_text, 1, 200), ...(description ? { description_text: description } : {}) };
    }),
  };
  return serverFetch<CaseDetail>(`${API}/${uuid(caseId)}/accession`, jsonInit('POST', body, { 'if-match': ifMatch(v), 'idempotency-key': idemKey(key) }));
}

const partBody = (input: PartInput) => {
  const description = opt(input.description_text, 1000);
  return { site_text: str(input.site_text, 1, 200), ...(description ? { description_text: description } : {}) };
};

/** addAnatomicPart (A6). */
export const addPart = (caseId: string, input: PartInput, key: string) =>
  serverFetch<Part>(`${API}/${uuid(caseId)}/parts`, jsonInit('POST', partBody(input), { 'idempotency-key': idemKey(key) }));

/** updateAnatomicPart (A7). */
export const updatePart = (caseId: string, partId: string, v: number, input: PartInput) =>
  serverFetch<Part>(`${API}/${uuid(caseId)}/parts/${uuid(partId)}`, jsonInit('PUT', partBody(input), { 'if-match': ifMatch(v) }));

/** saveAnatomicGross (A8): If-Match "0" creates the record. */
export function saveGross(caseId: string, partId: string, v: number, input: GrossInput) {
  const dims = input.dimensions_mm;
  if (dims !== undefined && (!Array.isArray(dims) || dims.length < 1 || dims.length > 3 || !dims.every((d) => /^[0-9]{1,4}(\.[0-9])?$/.test(d)))) throw bad();
  if (input.weight_g !== undefined && !/^[0-9]{1,5}(\.[0-9]{1,2})?$/.test(input.weight_g)) throw bad();
  if (input.pieces_count !== undefined && (!Number.isInteger(input.pieces_count) || input.pieces_count < 0 || input.pieces_count > 999)) throw bad();
  if (typeof input.is_complete !== 'boolean') throw bad();
  const body = {
    gross_text: str(input.gross_text, 0, 20000),
    ...(input.pieces_count !== undefined ? { pieces_count: input.pieces_count } : {}),
    ...(dims ? { dimensions_mm: dims } : {}),
    ...(input.weight_g !== undefined ? { weight_g: input.weight_g } : {}),
    is_complete: input.is_complete,
  };
  return serverFetch<GrossRecord>(`${API}/${uuid(caseId)}/parts/${uuid(partId)}/gross`, jsonInit('PUT', body, { 'if-match': ifMatch(v) }));
}

/** uploadAnatomicImage (I1): png/jpeg ≤ 15 MB; the client checks are hints, the API re-checks type, size and scan (REQ-SEC-083). */
export function uploadGrossImage(caseId: string, form: FormData, key: string) {
  const file = form.get('file');
  if (!(file instanceof Blob) || !['image/png', 'image/jpeg'].includes(file.type) || file.size === 0 || file.size > 15 * 1024 * 1024) throw bad();
  const out = new FormData();
  out.set('file', file, file instanceof File ? file.name : 'image');
  out.set('kind', 'gross');
  out.set('part_id', uuid(form.get('part_id')));
  return serverFetch<{ id: string }>(`${API}/${uuid(caseId)}/images`, { method: 'POST', headers: { 'idempotency-key': idemKey(key) }, body: out });
}
