// TAT percentile reads over analytics.tat_facts (02-TRD §6.6; PRD US-11.2/5; 07-SECURITY P1, P4, injection).
// One bound SELECT per call: tenant $1, segments $2, [from, to) $3/$4 on business_date, scope $5 (all) / $6 (centres), optional filters $7+.
// Nothing from input is part of the statement text — group keys come from a closed allow-list. Scope is mandatory.
// Percentiles are returned UNROUNDED (the mapper rounds half-up, TRD §6.6); an all-anomaly group keeps NULL stats (never 0).
import { TAT_SEGMENTS } from '../domain/columns.js';
import { checkScope, int, type RollupScope, type RollupsTx } from './rollups.repo.js';

export type TatSegment = (typeof TAT_SEGMENTS)[number];
// bs_month is not here: medians are not additive, so the service queries each B.S.-month sub-range with group_by none.
export type TatGroupBy = 'none' | 'centre' | 'processing_branch' | 'priority' | 'specimen_type' | 'day' | 'ad_month';

export interface TatRow {
  segment: TatSegment; key: string | null; n: number; median_seconds: number | null; p90_seconds: number | null; max_seconds: number | null; anomalies: number;
}
export interface TatArgs {
  readonly tenantId: string; readonly from: string; readonly to: string; readonly scope: RollupScope; readonly segments: readonly TatSegment[];
  readonly priority?: 'routine' | 'urgent' | undefined; readonly specimenTypeCodes?: readonly string[] | undefined;
  readonly processingBranchIds?: readonly string[] | undefined; readonly groupBy: TatGroupBy;
}

// SQL fragments are constants selected by allow-list key, never built from input.
const KEY_SQL: Readonly<Record<TatGroupBy, string | null>> = {
  none: null,
  centre: 'centre_id',
  processing_branch: 'processing_branch_id',
  priority: 'priority',
  specimen_type: 'specimen_type_code',
  day: 'business_date',
  ad_month: "date_trunc('month', business_date)::date",
};

function stat(v: unknown, col: string): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RangeError(`tat: ${col} is not a number`);
  return n;
}

export async function tatRows(tx: RollupsTx, a: TatArgs): Promise<TatRow[]> {
  const scope = checkScope(a.scope);
  if (typeof a.groupBy !== 'string' || !Object.hasOwn(KEY_SQL, a.groupBy)) throw new TypeError('tat: groupBy outside the allow-list');
  if (!Array.isArray(a.segments) || a.segments.some((s) => !(TAT_SEGMENTS as readonly string[]).includes(s))) throw new TypeError('tat: segment outside the allow-list');
  if (a.priority !== undefined && a.priority !== 'routine' && a.priority !== 'urgent') throw new TypeError('tat: priority outside routine|urgent');
  if (!scope.all && scope.centreIds.length === 0) return []; // empty restricted scope sees nothing

  const values: unknown[] = [a.tenantId, [...a.segments], a.from, a.to, scope.all, [...scope.centreIds]];
  let filters = '';
  const bind = (v: unknown): string => { values.push(v); return `$${values.length}`; };
  if (a.priority !== undefined) filters += ` AND priority = ${bind(a.priority)}`;
  if (a.specimenTypeCodes?.length) filters += ` AND specimen_type_code = ANY (${bind([...a.specimenTypeCodes])})`;
  if (a.processingBranchIds?.length) filters += ` AND processing_branch_id = ANY (${bind([...a.processingBranchIds])})`;

  const key = KEY_SQL[a.groupBy];
  const sql = `SELECT segment, ${key ? `${key}::text` : 'NULL::text'} AS key,
       count(*) FILTER (WHERE NOT is_anomaly) AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds) FILTER (WHERE NOT is_anomaly) AS median_seconds,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_seconds) FILTER (WHERE NOT is_anomaly) AS p90_seconds,
       max(duration_seconds) FILTER (WHERE NOT is_anomaly) AS max_seconds,
       count(*) FILTER (WHERE is_anomaly) AS anomalies
FROM analytics.tat_facts
WHERE tenant_id = $1 AND segment = ANY ($2) AND business_date >= $3 AND business_date < $4
  AND ($5 OR (centre_id IS NOT NULL AND centre_id = ANY ($6)))${filters}
GROUP BY segment${key ? `, ${key}` : ''} ORDER BY segment${key ? `, ${key}` : ''}`;
  const { rows } = await tx.query(sql, values);
  return rows.map((r) => ({
    segment: r.segment as TatSegment,
    key: r.key === null || r.key === undefined ? null : String(r.key),
    n: int(r.n, 'n'),
    median_seconds: stat(r.median_seconds, 'median_seconds'),
    p90_seconds: stat(r.p90_seconds, 'p90_seconds'),
    max_seconds: stat(r.max_seconds, 'max_seconds'),
    anomalies: int(r.anomalies, 'anomalies'),
  }));
}
