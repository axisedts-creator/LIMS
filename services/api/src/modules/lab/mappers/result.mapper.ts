// ResultDto mapper (02-TRD §5.9 allowlist, REQ-SEC-081). Input = lab.v_result_current row (snake_case lab.results columns + cur_* from the latest
// result_versions row). Approved rows read the CURRENT version (cur_*; finding C5 #10); every other status ignores cur_* (stale join values never win).
// Output keys are copied from contracts/openapi/lab.yaml ResultDto; absent values are OMITTED (the schema has no nullable fields). Internals
// (tenant/centre/patient ids, created_by/updated_by, hold_id, manual_abnormal, order_test_id, department_id, ...) are never copied.
type Row = Record<string, any>;
type Dto = Record<string, unknown>;

const MAX_PROVENANCE = 8000;
const present = (v: unknown): boolean => v !== null && v !== undefined;
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);
const text = (v: unknown): string | undefined => (present(v) ? String(v) : undefined);
const put = (o: Dto, k: string, v: unknown): void => { if (present(v)) o[k] = v; };

/** ResultVersionDto (lab.yaml) from a lab.result_versions row: allowlist only (no tenant/centre/actor ids, no approver, no superseded_*; `superseded` = superseded_at set). */
export function toResultVersionDto(row: Row): Dto {
  const dto: Dto = { result_id: row['result_id'], version_no: row['version_no'], recorded_at: iso(row['created_at'] ?? row['approved_at']), superseded: present(row['superseded_at']) };
  put(dto, 'value_numeric', text(row['value_numeric']));
  for (const k of ['value_text', 'ordinal_code', 'unit_code', 'flag', 'comment_text', 'amendment_reason_code', 'amendment_reason_text']) put(dto, k, row[k]);
  if (present(row['ref_range_id'])) {
    const s: Dto = { range_id: row['ref_range_id'], range_version: row['ref_range_version'] };
    put(s, 'low', text(row['ref_low'])); put(s, 'high', text(row['ref_high'])); put(s, 'text', row['ref_text']);
    dto['reference_range_snapshot'] = s;
  }
  if (Array.isArray(row['comment_codes']) && row['comment_codes'].length > 0) dto['comment_codes'] = row['comment_codes'];
  return dto;
}

export function toResultDto(row: Row): Dto {
  const cur = row['status'] === 'approved';
  // approved: cur_<col> when the view supplied it (even null = "no value in the current version"), else the row column.
  const pick = (col: string): unknown => (cur && `cur_${col}` in row ? row[`cur_${col}`] : row[col]);

  const dto: Dto = {
    id: row['id'], version: row['version'], order_id: row['order_id'], order_item_id: row['order_item_id'],
    test_id: row['test_id'], analyte_id: row['analyte_id'], analyte_code: row['analyte_code'], status: row['status'], origin: row['origin'],
    range_unavailable_age_unknown: Boolean(pick('range_unavailable_age_unknown')),
    on_hold: Boolean(row['on_hold']), qc_review_required: Boolean(row['qc_review_required']), unit_mismatch: Boolean(row['unit_mismatch']),
    current_version_no: row['current_version_no'],
  };
  put(dto, 'specimen_id', row['specimen_id']);
  put(dto, 'value_numeric', text(pick('value_numeric')));
  put(dto, 'value_text', pick('value_text'));
  put(dto, 'ordinal_code', pick('ordinal_code'));
  put(dto, 'unit_code', pick('unit_code'));
  put(dto, 'flag', pick('flag'));

  if (present(pick('ref_range_id'))) {
    const s: Dto = { range_id: pick('ref_range_id'), range_version: pick('ref_range_version') };
    put(s, 'low', text(pick('ref_low'))); put(s, 'high', text(pick('ref_high'))); put(s, 'text', pick('ref_text'));
    put(s, 'unit_code', cur && 'cur_ref_unit_code' in row ? row['cur_ref_unit_code'] : row['ref_unit_code']);
    dto['reference_range_snapshot'] = s;
  }

  if (present(pick('delta_status'))) {
    const d: Dto = { status: pick('delta_status') };
    put(d, 'prev_value', text(pick('delta_prev_value'))); put(d, 'abs', text(pick('delta_abs'))); put(d, 'pct', text(pick('delta_pct')));
    put(d, 'prev_at', iso(pick('delta_prev_at')));
    dto['delta'] = d;
  }

  const critical: Dto = { is_critical: Boolean(pick('is_critical')) };
  put(critical, 'critical_event_id', pick('critical_event_id'));
  dto['critical'] = critical;

  if (present(row['calc_status'])) {
    const c: Dto = { status: row['calc_status'] };
    put(c, 'reason', row['calc_reason']);
    if (present(row['formula_provenance'])) {
      const p = typeof row['formula_provenance'] === 'string' ? row['formula_provenance'] : JSON.stringify(row['formula_provenance']);
      if (p.length <= MAX_PROVENANCE) c['provenance'] = p;
    }
    dto['calc'] = c;
  }

  if (Array.isArray(row['comment_codes']) && row['comment_codes'].length > 0) dto['comment_codes'] = row['comment_codes'];
  put(dto, 'comment_text', row['comment_text']);
  put(dto, 'instrument_id', row['instrument_id']);
  if (Array.isArray(row['instrument_flags']) && row['instrument_flags'].length > 0) dto['instrument_flags'] = row['instrument_flags'];
  put(dto, 'verified_at', iso(row['verified_at']));
  put(dto, 'verified_by', row['verified_by_membership_id']);
  put(dto, 'approved_at', iso(row['approved_at']));
  put(dto, 'approved_by', row['approved_by_membership_id']);
  return dto;
}
