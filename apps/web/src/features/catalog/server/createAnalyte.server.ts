import 'server-only';
// #29 createAnalyte (Idempotency-Key): analyte fields + initial_version. T0D-TESTMGMT-1 (LD-318): the parity fields of AnalyteCreate and
// AnalyteVersionDraftInput (contracts/openapi/catalog.yaml) are forwarded; only those fields, each validated (no mass assignment).
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, json, uuid } from './guard';
import { bool, int, oneOf, pick, str, upperCode, uuid as isUuid, bad, type V } from './shared';

export const RESULT_TYPES = ['numeric', 'text', 'ordinal', 'coded', 'attachment', 'narrative', 'boolean', 'test_footer', 'space', 'graph', 'html_descriptive'] as const;
export const RESULT_DISPLAY_TYPES = ['table', 'note_value_only', 'list_note', 'one_column', 'two_column', 'three_column', 'four_column', 'comment', 'hidden', 'table_with_subheader', 'merge_two_column'] as const;
const decimal: V = (v) => { if (typeof v !== 'string' || !/^-?\d{1,12}(\.\d{1,6})?$/.test(v)) throw bad(); return v; };
const ANALYTE_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

/** AnalyteVersionDraftInput / AnalyteVersionDraftUpdate fields (shared by create and draft edit). */
export const VERSION_FIELDS: Record<string, V> = {
  result_type: oneOf(...RESULT_TYPES), unit_code: str(1, 32), decimals: int(0, 6), method_id: isUuid, value_set_code: str(1, 32),
  formula_expression: str(1, 500), default_value: str(1, 500), long_text_value: str(1, 20000), high_low: decimal, require_verification: bool,
};
/** Analyte fields shared by AnalyteCreate and AnalyteUpdate. */
export const ANALYTE_FIELDS: Record<string, V> = {
  name: str(1, 120), print_name: str(0, 120), report_subheading: str(0, 80), sort_order: int(0, 9999), is_reportable: bool, trend_name: str(1, 120),
  specimen_type_id: isUuid, font: str(1, 60), result_display_type: oneOf(...RESULT_DISPLAY_TYPES), print_on_negative: bool, print_on_worksheet: bool,
  send_in_sms: bool, nabl: bool, accab_logo: bool, is_trend: bool,
};

export interface CreateAnalyteInput { code: string; name: string; print_name?: string; report_subheading?: string; initial_version: Record<string, unknown>; [k: string]: unknown }
export const createAnalyte = async (testId: string, input: CreateAnalyteInput, idempotencyKey: string) => {
  const body = pick(input, { code: upperCode(ANALYTE_CODE), ...ANALYTE_FIELDS, initial_version: (v) => pick(v, VERSION_FIELDS, ['result_type']) }, ['code', 'name', 'initial_version']);
  return serverFetch<{ id: string; code: string; draft_version_id?: string; version?: number }>(`/v1/catalog/tests/${uuid(testId)}/analytes`, {
    method: 'POST',
    headers: json({ 'idempotency-key': idemKey(idempotencyKey) }),
    body: JSON.stringify(body),
  });
};
