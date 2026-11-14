// DB rows -> CultureSummaryDto / CultureDetailDto children / ReportVersionSummaryDto / ReportVersionDto (02-TRD §5.6 allowlists, REQ-SEC-081).
// Only the listed fields are copied; optional fields are omitted when NULL, never null (closed schemas). Times are ISO UTC ms (02-CV §4.8).
type Row = Record<string, any>;
type Obj = Record<string, unknown>;

export const NO_NAME = '—';
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();
/** Copy the keys of `row` that are present (not null/undefined) into `out`, converting times to ISO. */
function opt(out: Obj, row: Row, keys: readonly string[], times: readonly string[] = []): Obj {
  for (const k of keys) if (row[k] !== null && row[k] !== undefined) out[k] = times.includes(k) ? iso(row[k]) : row[k];
  return out;
}

/** 02-TRD §4.1 "Read overdue": status in {incubating, growth_detected} and next_read_due_at < now. */
export const isReadOverdue = (row: Row, now: Date): boolean =>
  (row['status'] === 'incubating' || row['status'] === 'growth_detected') && row['next_read_due_at'] != null && new Date(row['next_read_due_at']).getTime() < now.getTime();

export function cultureSummaryDto(row: Row, test: { code: string; name: string }, now: Date): Obj {
  const out: Obj = {
    id: row['id'], version: row['version'], status: row['status'], order_id: row['order_id'], order_item_id: row['order_item_id'], specimen_id: row['specimen_id'],
    patient_id: row['patient_id'], centre_id: row['centre_id'], test_id: row['test_id'], test_code: test.code, test_name: test.name,
    specimen_type_code: row['specimen_type_code'], received_at: iso(row['received_at']), is_read_overdue: isReadOverdue(row, now),
    current_report_version_no: row['current_report_version_no'], chain_cancelled: row['chain_cancelled'], open_instrument_record_count: Number(row['open_instrument_record_count'] ?? 0),
  };
  opt(out, row, ['specimen_site_code', 'outcome_code', 'planted_at', 'next_read_due_at', 'final_due_at', 'last_report_phase'], ['planted_at', 'next_read_due_at', 'final_due_at']);
  if (row['barcode_snapshot'] != null) out['barcode'] = row['barcode_snapshot'];   // only from barcode_snapshot (TRD §5.6)
  return out;
}

export const plateDto = (r: Row): Obj =>
  opt({ id: r['id'], version: r['version'], plate_no: r['plate_no'], media_code: r['media_code'], planted_at: iso(r['planted_at']), status: r['status'] },
    r, ['incubation_text', 'parent_plate_id', 'source_isolate_id']);

export function observationDto(r: Row, recordedBy: string, isCorrected: boolean): Obj {
  const out = opt({ id: r['id'], kind: r['kind'], observed_at: iso(r['observed_at']) }, r, ['plate_id', 'growth_code', 'quantity_text', 'finding_text']);
  // LD-149 (2026-11-13): hours_since_planting is the stored 2-decimal value as a JSON number (02-TRD §4.1), never floored.
  if (r['hours_since_planting'] != null) out['hours_since_planting'] = Number(r['hours_since_planting']);
  out['recorded_by_display'] = recordedBy;
  if (r['corrects_observation_id'] != null) out['corrects_observation_id'] = r['corrects_observation_id'];
  out['is_corrected'] = isCorrected;
  return out;
}

export function astDto(r: Row, antibioticDisplay: string): Obj {
  const out: Obj = { id: r['id'], version: r['version'], antibiotic_code: r['antibiotic_code'], antibiotic_display: antibioticDisplay, method: r['method'] };
  opt(out, r, ['raw_value', 'raw_qualifier']);
  if (r['raw_numeric'] != null) out['raw_numeric'] = String(r['raw_numeric']);   // DecimalString, never a JS number
  opt(out, r, ['unit_code', 'category_code', 'standard', 'standard_version', 'standard_source', 'interpretation_raw', 'interpretation_source', 'breakpoint_set_id']);
  out['suggestion_overridden'] = r['suggestion_overridden'];
  out['source'] = r['source'];
  opt(out, r, ['instrument_id', 'instrument_result_time'], ['instrument_result_time']);
  Object.assign(out, { is_reportable: r['is_reportable'], report_visibility: r['report_visibility'], off_panel: r['off_panel'] });
  return opt(out, r, ['panel_sort_order', 'entered_at'], ['entered_at']);
}

export function isolateDto(r: Row, organismDisplay: string | undefined, panel: Row | undefined, ast: Obj[]): Obj {
  const out: Obj = { id: r['id'], version: r['version'], isolate_seq: r['isolate_seq'], status: r['status'] };
  opt(out, r, ['organism_code']);
  if (organismDisplay !== undefined) out['organism_display'] = organismDisplay;
  opt(out, r, ['organism_source', 'identified_at', 'colony_description', 'quantity_text'], ['identified_at']);
  out['is_reportable'] = r['is_reportable'];
  opt(out, r, ['withdraw_reason_code']);
  if (panel) out['ast_panel'] = { id: panel['id'], code: panel['code'], version_no: panel['version_no'], display: panel['display'] };
  opt(out, r, ['ast_method']);
  out['ast'] = ast;
  return out;
}

export const transitionDto = (r: Row, actor: string): Obj => {
  const out = opt({}, r, ['from_status']);
  out['to_status'] = r['to_status'];
  opt(out, r, ['reason_code']);
  return { ...out, occurred_at: iso(r['occurred_at']), actor_display: actor };
};

export function versionSummaryDto(r: Row, signedBy: string): Obj {
  const out = opt({ version_no: r['version_no'], report_phase: r['report_phase'], version_kind: r['version_kind'] }, r, ['outcome_code']);
  Object.assign(out, { flag: r['flag'], is_critical: r['is_critical'], signed_by_display: signedBy, signed_at: iso(r['signed_at']), lab_status_at_submit: r['lab_status_at_submit'] });
  return opt(out, r, ['amendment_reason_code']);
}

/** ReportVersionDto: the stored snapshot (05-SCHEMA §6 item schemas) is returned as stored. */
export function versionDto(r: Row, signedBy: string): Obj {
  const out = versionSummaryDto(r, signedBy);
  out['culture_summary_text'] = r['culture_summary_text'];
  out['isolates'] = r['isolates'] ?? [];
  out['ast'] = r['ast'] ?? [];
  opt(out, r, ['comments_text', 'early_final_reason', 'amendment_reason_text']);
  return { ...out, lab_result_id: r['lab_result_id'], lab_result_version_no: r['lab_result_version_no'] };
}

export const protocolBlock = (p: Row): Obj => ({
  id: p['id'], code: p['code'], version_no: p['version_no'], display: p['display'],
  read_schedule_hours: p['read_schedule_hours'], final_no_growth_hours: p['final_no_growth_hours'], requires_gram_stain: p['requires_gram_stain'],
});

/** CultureDetailDto.lab_result from a LabPort result line (camelCase port shape). */
export const labResultDto = (l: Row): Obj =>
  opt({ result_id: l['resultId'], status: l['status'], version_no: l['versionNo'] }, { verified_at: l['verifiedAt'], approved_at: l['approvedAt'] }, ['verified_at', 'approved_at'], ['verified_at', 'approved_at']);
