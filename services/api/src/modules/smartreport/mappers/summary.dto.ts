// Stored summary row -> SmartSummaryView / SmartSummaryListItem (02-TRD §5.1, REQ-SEC-081 field allowlist). Explicit allow-list, never a spread of the row:
// no tenant/patient ids, hashes, input versions, audit columns or raw llm_overlay. review_inputs and llm_text only when `approver` (smartreport.summary.approve).
// reviews[] carries action / actor_display_name / reason_code / at only — never the free-text comment (the view keeps reject_comment as a field of its own).
import { refRangeText } from '../domain/placeholders.js';
import type { Row } from '../repository/common.repo.js';

type Dto = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const has = (v: unknown): boolean => v !== null && v !== undefined;
const when = (key: string, v: unknown, f: (x: any) => unknown = (x) => x): Dto => (has(v) ? { [key]: f(v) } : {});

export interface ViewParts {
  readonly registrationNo: string;
  readonly names: ReadonlyMap<string, string>;
  readonly reviews: readonly Row[];
  readonly reportVersionNos: readonly number[];
  readonly llmEnabled: boolean;
  readonly approver: boolean;
  readonly reviewInputs?: readonly Dto[] | undefined;
}

export const reviewDto = (r: Row, names: ReadonlyMap<string, string>): Dto => ({
  action: r.action, ...when('actor_display_name', has(r.actor_membership_id) ? names.get(r.actor_membership_id) : undefined), ...when('reason_code', r.reason_code), at: iso(r.created_at),
});

/** One approved result as the reviewer sees it (values come from LabPort at read time, never stored). */
export function reviewInputDto(r: Row, analyteName: string, bandStatus: string, groupCode: string | undefined): Dto {
  const range = has(r.referenceRangeSnapshot) ? refRangeText(r.referenceRangeSnapshot) : undefined;
  return {
    result_id: r.resultId, analyte_id: r.analyteId, analyte_name: analyteName, value_text: String(r.valueNumeric ?? r.valueText ?? r.ordinalCode ?? ''),
    ...when('unit_code', r.unitCode), ...when('flag', r.flag), ...when('ref_range_text', range), band_status: bandStatus, ...when('group_code', groupCode),
  };
}

export function summaryView(row: Row, p: ViewParts): Dto {
  const c = row.content as Row;
  const items: Record<string, unknown> = p.approver && has(row.llm_overlay) && typeof row.llm_overlay.items === 'object' && row.llm_overlay.items !== null ? row.llm_overlay.items : {};
  const llm = (ref: string): Dto => (typeof items[ref] === 'string' ? { llm_text: items[ref] } : {});   // itemRef: deranged:<resultId> | advice:<blockId> | followup:<ruleId> (02-TRD §4.12)
  const hs = c.healthScore as Row | undefined;
  const name = (id: unknown): string | undefined => (has(id) ? p.names.get(id as string) : undefined);
  return {
    id: row.id, order_id: row.order_id, centre_id: row.centre_id, status: row.status, library_version_id: row.library_version_id,
    template_library_version: Number(row.template_library_version), formula_version: row.formula_version, language: row.language, built_at: iso(row.built_at),
    report_version_nos: [...p.reportVersionNos],
    ...when('approved_at', row.approved_at, iso), ...when('approved_by_membership_id', row.approved_by_membership_id), ...when('approved_by_display_name', name(row.approved_by_membership_id)),
    ...when('rejected_at', row.rejected_at, iso), ...when('rejected_by_display_name', name(row.rejected_by_membership_id)),
    ...when('reject_reason_code', row.reject_reason_code), ...when('reject_comment', row.reject_comment),
    ...when('superseded_at', row.superseded_at, iso), ...when('superseded_reason', row.superseded_reason), ...when('superseded_by_summary_id', row.superseded_by_summary_id),
    ...(hs && { health_score: { value: hs.value, band: hs.band, formula_version: hs.formulaVersion, panels_scored: hs.panelsScored } }),
    panels: (c.panels as Row[]).map((x) => ({ panel_code: x.panelCode, display_name: x.displayName, status: x.status, result_ids: x.resultIds })),
    deranged: (c.deranged as Row[]).map((x) => ({
      result_id: x.resultId, analyte_id: x.analyteId, analyte_name: x.analyteName, direction: x.direction, severity: x.severity, template_block_id: x.templateBlockId, text: x.text, ...llm(`deranged:${x.resultId}`),
    })),
    advice: (c.advice as Row[]).map((x) => ({ template_block_id: x.templateBlockId, text: x.text, ...llm(`advice:${x.templateBlockId}`) })),
    follow_ups: (c.followUps as Row[]).map((x) => ({
      rule_id: x.ruleId, suggested_test_code: x.suggestedTestCode, suggested_test_name: x.suggestedTestName, interval_days: x.intervalDays, text: x.text, ...llm(`followup:${x.ruleId}`),
    })),
    trends: (c.trends as Row[]).map((x) => ({
      analyte_id: x.analyteId, analyte_name: x.analyteName, ...when('unit_code', x.unitCode), direction: x.direction, point_result_ids: x.pointResultIds,
      points: (x.points as Row[]).map((q) => ({ result_id: q.resultId, approved_at: q.approvedAt, value_numeric: q.valueNumeric })),
    })),
    disclaimer_block_id: c.disclaimerBlockId, disclaimer_text: c.disclaimerText,
    counts: { deranged: row.deranged_count, critical: row.critical_count, unmapped_results: row.unmapped_result_count, ignored_duplicates: row.ignored_duplicate_count },
    llm: { enabled: p.llmEnabled, use_llm_text: row.use_llm_text === true, ...(p.approver ? when('last_run_id', row.llm_overlay?.run_id) : {}) },
    registration_no: p.registrationNo,
    ...(p.approver && p.reviewInputs ? { review_inputs: [...p.reviewInputs] } : {}),
    reviews: p.reviews.map((r) => reviewDto(r, p.names)), version: row.version,
  };
}

export const listItemDto = (row: Row, registrationNo: string): Dto => ({
  id: row.id, order_id: row.order_id, centre_id: row.centre_id, status: row.status, built_at: iso(row.built_at), ...when('health_score_band', row.health_score_band),
  deranged_count: row.deranged_count, critical_count: row.critical_count, registration_no: registrationNo, version: row.version,
});
