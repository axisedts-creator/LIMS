// C5 T-14 — ResultDto mapper (02-TRD §5.9 allowlist, REQ-SEC-081; §4.3 "mappers read the current version for approved rows", finding C5 #10) + contract check against contracts/openapi/lab.yaml.
// SEAM: ../result.mapper.ts exports toResultDto(row): the lab.v_result_current row (snake_case lab.results columns + cur_* columns, 05-SCHEMA §3) -> ResultDto (snake_case, contract names).
//   Absent values are OMITTED (the schema has no nullable fields). calc.provenance = formula_provenance serialised as JSON text (<= 8000 chars, lab.yaml "[CONV] rule 3").
//   verified_by / approved_by = verified_by_membership_id / approved_by_membership_id. critical.critical_event_id from critical_event_id.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { toResultDto } from '../result.mapper.js';

const spec: any = parse(readFileSync(fileURLToPath(new URL('../../../../../../../contracts/openapi/lab.yaml', import.meta.url)), 'utf8'));
const DTO = spec.components.schemas.ResultDto;
const keysOf = (o: any) => Object.keys(o.properties);
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;

const base = (over: Record<string, unknown> = {}) => ({
  id: u(1), tenant_id: u(0xa001), centre_id: u(0xa201), processing_centre_id: u(0xa202), order_id: u(2), order_item_id: u(3), order_test_id: u(4), specimen_id: u(5), patient_id: u(6),
  test_id: u(7), analyte_id: u(8), analyte_code: 'HB', department_id: u(9), is_reportable: true, result_type: 'numeric', status: 'resulted', origin: 'manual',
  value_numeric: '13.4', value_text: null, ordinal_code: null, unit_code: 'g/dL', manual_abnormal: false, flag: 'N', ref_range_id: u(10), ref_range_version: 2, ref_low: '12.0', ref_high: '16.0', ref_text: null, ref_unit_code: 'g/dL',
  range_unavailable_age_unknown: false, delta_status: 'not_applicable', delta_rule_id: null, delta_prev_value: null, delta_abs: null, delta_pct: null, delta_prev_at: null, is_critical: false, critical_event_id: null,
  calc_status: null, calc_reason: null, formula_provenance: null, comment_codes: [], comment_text: null, unit_mismatch: false, instrument_id: null, instrument_flags: null, on_hold: false, hold_id: null,
  qc_review_required: false, current_version_no: 1, verified_at: null, verified_by_membership_id: null, approved_at: null, approved_by_membership_id: null,
  version: 4, is_active: true, created_at: '2026-06-15T05:00:00Z', created_by: u(0xc1), updated_at: '2026-06-15T05:00:00Z', updated_by: u(0xc1),
  cur_value_numeric: null, cur_flag: null, ...over,
});

describe('T-14 toResultDto — allowlist (REQ-SEC-081)', () => {
  it('output keys are a subset of ResultDto.properties and every required property is present', () => {
    const dto: any = toResultDto(base() as never);
    for (const k of Object.keys(dto)) expect(keysOf(DTO), k).toContain(k);
    for (const k of DTO.required) expect(dto, k).toHaveProperty(k);
  });
  it('internal columns never leak (tenant_id, centre ids, patient_id, created_by/updated_by, hold_id, manual_abnormal, formula_provenance raw, order_test_id, department_id, is_active)', () => {
    const s = JSON.stringify(toResultDto(base({ hold_id: u(0xf1), formula_provenance: { secret: 'x' }, calc_status: 'computed' }) as never));
    for (const k of ['tenant_id', 'centre_id', 'processing_centre_id', 'patient_id', 'created_by', 'updated_by', 'hold_id', 'manual_abnormal', 'order_test_id', 'department_id', 'is_active', 'created_at', 'updated_at']) expect(s, k).not.toContain(`"${k}"`);
    for (const v of [u(0xa001), u(0xa201), u(6), u(0xc1), u(0xf1)]) expect(s).not.toContain(v);
  });
  it('maps names: version <- row version, verified_by/approved_by <- *_membership_id, reference_range_snapshot / delta / critical / calc sub-objects use only contract keys', () => {
    const dto: any = toResultDto(base({
      status: 'verified', verified_at: '2026-06-15T05:10:00Z', verified_by_membership_id: u(0xd1), flag: 'H', is_critical: true, critical_event_id: u(0xe1),
      delta_status: 'fail', delta_prev_value: '10.0', delta_abs: '3.4', delta_pct: '34.0', delta_prev_at: '2026-06-01T05:00:00Z',
      calc_status: 'computed', calc_reason: null, formula_provenance: { expression: 'A+B', inputs: [] }, instrument_id: u(0xf2), instrument_flags: ['H'],
    }) as never);
    expect(dto).toMatchObject({ id: u(1), version: 4, status: 'verified', origin: 'manual', analyte_code: 'HB', verified_by: u(0xd1), verified_at: '2026-06-15T05:10:00Z', flag: 'H', instrument_id: u(0xf2) });
    expect(dto.reference_range_snapshot).toEqual({ range_id: u(10), range_version: 2, low: '12.0', high: '16.0', unit_code: 'g/dL' });
    expect(dto.delta).toEqual({ status: 'fail', prev_value: '10.0', abs: '3.4', pct: '34.0', prev_at: '2026-06-01T05:00:00Z' });
    expect(dto.critical).toEqual({ is_critical: true, critical_event_id: u(0xe1) });
    expect(Object.keys(dto.calc).sort()).toEqual(['provenance', 'status']);
    expect(typeof dto.calc.provenance).toBe('string');
    expect(JSON.parse(dto.calc.provenance)).toMatchObject({ expression: 'A+B' });
    expect(dto.calc.provenance.length).toBeLessThanOrEqual(8000);
  });
  it('no null anywhere (absent value fields are omitted); a pending row has no value/flag/snapshot', () => {
    const dto: any = toResultDto(base({ status: 'pending', origin: 'manual', value_numeric: null, flag: null, ref_range_id: null, ref_range_version: null, ref_low: null, ref_high: null, unit_code: null }) as never);
    expect(JSON.stringify(dto)).not.toContain('null');
    for (const k of ['value_numeric', 'value_text', 'ordinal_code', 'flag', 'reference_range_snapshot', 'verified_at', 'approved_at']) expect(dto, k).not.toHaveProperty(k);
    expect(dto).toMatchObject({ on_hold: false, qc_review_required: false, unit_mismatch: false, range_unavailable_age_unknown: false, critical: { is_critical: false } });
  });
  it('on_hold / qc_review_required / unit_mismatch are surfaced (AC-08.7: the UI and verify see the hold)', () => {
    expect(toResultDto(base({ on_hold: true, qc_review_required: true, unit_mismatch: true }) as never)).toMatchObject({ on_hold: true, qc_review_required: true, unit_mismatch: true });
  });
  it('S-14: comment text is returned verbatim as data (escaping is the renderer\'s job)', () => {
    expect((toResultDto(base({ comment_text: '<script>alert(1)</script>', comment_codes: ['HEMOLYSED'] }) as never) as any)).toMatchObject({ comment_text: '<script>alert(1)</script>', comment_codes: ['HEMOLYSED'] });
  });
  it('contract: enums and bounds of the DTO fields hold for a fully populated row', () => {
    const dto: any = toResultDto(base({ status: 'approved', flag: 'LL', current_version_no: 2, approved_at: '2026-06-15T06:00:00Z', approved_by_membership_id: u(0xd2), cur_value_numeric: '6.0', cur_flag: 'LL', cur_ref_range_id: u(10), cur_ref_range_version: 2, cur_ref_low: '12.0', cur_ref_high: '16.0' }) as never);
    expect(DTO.properties.status.enum).toContain(dto.status);
    expect(DTO.properties.flag.enum).toContain(dto.flag);
    expect(dto.current_version_no).toBe(2);
  });
});

describe('T-14 toResultDto — approved rows read the CURRENT version (cur_*; finding C5 #10)', () => {
  it('value, unit, flag, range snapshot, range_unavailable_age_unknown, delta and critical come from cur_* when status = approved', () => {
    const dto: any = toResultDto(base({
      status: 'approved', value_numeric: '13.4', flag: 'N', unit_code: 'g/dL', approved_at: '2026-06-15T06:00:00Z', approved_by_membership_id: u(0xd2), current_version_no: 2,
      cur_value_numeric: '14.9', cur_value_text: null, cur_ordinal_code: null, cur_unit_code: 'g/L', cur_flag: 'H',
      cur_ref_range_id: u(0x11), cur_ref_range_version: 5, cur_ref_low: '13.0', cur_ref_high: '14.0', cur_ref_text: null, cur_range_unavailable_age_unknown: true,
      cur_is_critical: true, cur_critical_event_id: u(0xe2), cur_delta_status: 'fail', cur_delta_prev_value: '13.4', cur_delta_abs: '1.5', cur_delta_pct: '11.2', cur_delta_prev_at: '2026-06-10T00:00:00Z',
    }) as never);
    expect(dto).toMatchObject({ value_numeric: '14.9', unit_code: 'g/L', flag: 'H', range_unavailable_age_unknown: true });
    expect(dto.reference_range_snapshot).toMatchObject({ range_id: u(0x11), range_version: 5, low: '13.0', high: '14.0' });
    expect(dto.critical).toEqual({ is_critical: true, critical_event_id: u(0xe2) });
    expect(dto.delta).toMatchObject({ status: 'fail', prev_value: '13.4', abs: '1.5' });
  });
  it('a non-approved row ignores cur_* (stale join values never win)', () => {
    const dto: any = toResultDto(base({ status: 'resulted', value_numeric: '13.4', cur_value_numeric: '99.9', cur_flag: 'HH' }) as never);
    expect(dto).toMatchObject({ value_numeric: '13.4', flag: 'N' });
  });
});

describe('T-14 contract: bulkEnterResults response schema in lab.yaml', () => {
  const op = spec.paths['/v1/lab/results/bulk-enter'].post;
  const resp = op.responses['200'].content['application/json'].schema;
  it('operation facts the handler relies on: permission, idempotency, per-row codes, 200 item shape', () => {
    expect(op['x-permission']).toBe('lab.result.enter');
    expect(op['x-idempotency']).toBe('required');
    for (const c of ['lab.result_value_invalid', 'lab.result_locked', 'lab.result_invalid_transition', 'common.version_conflict']) expect(op['x-error-codes']).toContain(c);
    expect(resp.required).toEqual(['results', 'recomputed']);
    expect(resp.properties.results.items.properties.outcome.enum).toEqual(['ok', 'error']);
    expect(Object.keys(resp.properties.results.items.properties).sort()).toEqual(['code', 'outcome', 'result', 'result_id']);
    expect(resp.properties.results.maxItems).toBe(200);
  });
});
