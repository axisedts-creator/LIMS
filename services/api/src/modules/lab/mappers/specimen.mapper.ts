// Specimen row -> SpecimenDto / SpecimenDetailDto (lab.yaml allowlist, 02-TRD §5.9, REQ-SEC-081) + keyset cursors (02-CV §4.3).
// Allowlist by construction: a column that is not named here (patient_id, creation_key, patient_sex, patient_age_days, collected_by_membership_id,
// created_by, tenant_id, rejection_comment unless the caller holds lab.specimen.reject ...) can never reach a response.
import { LimsError } from '../../../core/errors.js';

type Obj = Record<string, any>;
export interface TestRef { readonly test_id: string; readonly test_code: string }

export const isoUtc = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : new Date(v as string | number | Date).toISOString());
const omitNull = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export function specimenDto(row: Obj, tests: readonly TestRef[]): Obj {
  return omitNull({
    id: row['id'], version: Number(row['version']), barcode: row['barcode'], order_id: row['order_id'], registration_no: row['registration_no'],
    specimen_type_code: row['specimen_type_code'], container_code: row['container_code'], status: row['status'], priority: row['priority'],
    centre_id: row['centre_id'], processing_centre_id: row['processing_centre_id'], parent_specimen_id: row['parent_specimen_id'], replaces_specimen_id: row['replaces_specimen_id'],
    is_active: row['is_active'] === true, collected_at: isoUtc(row['collected_at']), in_transit_at: isoUtc(row['in_transit_at']), received_at: isoUtc(row['received_at']),
    rejected_at: isoUtc(row['rejected_at']), rejection_reason_code: row['rejection_reason_code'], collection_barcode_unverified: row['collection_barcode_unverified'] === true,
    label_print_count: Number(row['label_print_count'] ?? 0), tests: tests.map((t) => ({ test_id: t.test_id, test_code: t.test_code })),
  });
}

/** transitions = lab.specimen_transitions rows (from_status, to_status, occurred_at). */
export function specimenDetailDto(row: Obj, tests: readonly TestRef[], transitions: readonly Obj[], summary: Obj, withRejectionComment: boolean): Obj {
  return {
    ...specimenDto(row, tests),
    ...(withRejectionComment && typeof row['rejection_comment'] === 'string' && row['rejection_comment'] !== '' ? { rejection_comment: row['rejection_comment'] } : {}),
    transitions: transitions.map((t) => omitNull({ from_status: t['from_status'], to_status: t['to_status'], at: isoUtc(t['occurred_at']) })),
    results_summary: summary,
  };
}

/** Group the tests of many specimens by specimen id. */
export function groupTests(rows: readonly Obj[]): Map<string, TestRef[]> {
  const m = new Map<string, TestRef[]>();
  for (const r of rows) (m.get(r['specimen_id']) ?? m.set(r['specimen_id'], []).get(r['specimen_id'])!).push({ test_id: r['test_id'], test_code: r['test_code'] });
  return m;
}

// ---- cursors: base64url JSON [sort, key, id]; a cursor of another sort / shape is common.invalid_cursor ----
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^(-?infinity|[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.]+(Z|[+-][0-9]{2}(:[0-9]{2})?)?)$/;
export const encodeCursor = (sort: string, key: string, id: string): string => Buffer.from(JSON.stringify([sort, key, id]), 'utf8').toString('base64url');
export function decodeCursor(raw: unknown, sort: string): { key: string; id: string } {
  const invalid = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw invalid();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== sort || typeof v[1] !== 'string' || !KEY.test(v[1]) || typeof v[2] !== 'string' || !UUID.test(v[2])) throw invalid();
  return { key: v[1], id: v[2] };
}
