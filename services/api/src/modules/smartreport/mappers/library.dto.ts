// Row -> DTO mappers for the library operations #1-#21 (smartreport.yaml components). Null columns are omitted; internal columns
// (tenant_id, library_version_id, is_active, audit columns, block_kind) never leave the API. Dates leave as ISO-8601 UTC (ms).
import { extractPlaceholders } from '../domain/placeholders.js';
import type { Row } from '../repository/common.repo.js';

export const PARAM_KEYS = ['score_enabled', 'credit_in_range_bp', 'credit_borderline_bp', 'credit_out_of_range_bp', 'credit_critical_bp', 'min_groups_scored',
  'band_good_min', 'band_fair_min', 'critical_forces_needs_attention', 'borderline_fraction_bp', 'min_mapped_results', 'trend_enabled', 'trend_max_points',
  'trend_lookback_days', 'trend_stable_bp', 'trends_max', 'advice_max_blocks', 'followup_max'] as const;

export interface Counts { blocks: number; rules: number; analyte_groups: number; groups_shown: number }
export type Names = ReadonlyMap<string, string>;

const iso = (v: unknown): string | undefined => (v == null ? undefined : (v instanceof Date ? v : new Date(String(v))).toISOString());
/** Copies the listed columns that are set (null / undefined are omitted). */
function pick(r: Row, keys: readonly string[], dates: readonly string[] = []): Row {
  const o: Row = {};
  for (const k of keys) { const v = dates.includes(k) ? iso(r[k]) : r[k]; if (v !== null && v !== undefined) o[k] = v; }
  return o;
}
const withName = (r: Row, names: Names): Row => {
  const n = typeof r.approved_by_membership_id === 'string' ? names.get(r.approved_by_membership_id) : undefined;
  return n === undefined ? {} : { approved_by_display_name: n };
};

export const versionSummaryDto = (r: Row, names: Names): Row => ({
  ...pick(r, ['id', 'version_no', 'status', 'language', 'approved_at', 'approved_by_membership_id'], ['approved_at']), ...withName(r, names), updated_at: iso(r.updated_at), version: r.version,
});

export const versionDto = (r: Row, counts: Counts, names: Names): Row => ({
  ...pick(r, ['id', 'version_no', 'status', 'language', 'formula_version']),
  params: Object.fromEntries(PARAM_KEYS.map((k) => [k, r[k]])),
  ...pick(r, ['source_version_id', 'change_summary', 'content_sha256', 'submitted_at', 'submitted_by_membership_id', 'approved_at', 'approved_by_membership_id',
    'approval_note', 'returned_at', 'return_comment', 'retired_at'], ['submitted_at', 'approved_at', 'returned_at', 'retired_at']),
  ...withName(r, names), counts, version: r.version, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

export const blockDto = (r: Row): Row => ({
  ...pick(r, ['id', 'block_key', 'kind', 'text_en', 'text_ne', 'note']),
  placeholders: [...new Set([r.text_en, r.text_ne].flatMap((t) => (typeof t === 'string' ? extractPlaceholders(t) : [])))],
  version: r.version, updated_at: iso(r.updated_at),
});

export const ruleDto = (r: Row): Row => pick(r, ['id', 'rule_kind', 'trigger_kind', 'analyte_id', 'group_code', 'direction', 'min_severity', 'priority', 'block_id', 'suggested_test_id', 'interval_days', 'version']);
export const mappingDto = (r: Row): Row => pick(r, ['analyte_id', 'group_code', 'include_in_score', 'trend_enabled', 'borderline_fraction_bp', 'trend_stable_bp', 'sort_order', 'version']);
export const groupSettingDto = (r: Row): Row => pick(r, ['group_code', 'display_en', 'display_ne', 'score_weight', 'sort_order', 'is_shown', 'version']);

/** Validation issue -> ValidationReport.issues[] item (detail = fixed text; never block text). */
export function issueDto(i: { code: string; severity: string; path: string; blockKey?: string; placeholder?: string; term?: string; direction?: string }): Row {
  const rule = /^\/rules\/([0-9a-f-]{36})$/i.exec(i.path);
  const extra = i.placeholder ?? i.term ?? i.direction;
  return {
    code: i.code, severity: i.severity, path: i.path.slice(0, 512), ...(i.blockKey !== undefined ? { block_key: i.blockKey } : {}), ...(rule ? { rule_id: rule[1] } : {}),
    detail: `${i.code.replaceAll('_', ' ')}${extra !== undefined ? `: ${extra}` : ''}`.slice(0, 200),
  };
}
