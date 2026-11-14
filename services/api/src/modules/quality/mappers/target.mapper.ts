// DTO allowlist of 02-TRD §5.10 for #20-#25 (QcTargetDto): only listed fields leave; no tenant_id / *_by ids / retire_reason / raw basis_* columns / updated_* / is_active;
// no null on the wire (absent optional = key omitted). Timestamps are ISO-8601 UTC strings; mean/sd are DecimalStrings passed through untouched.
import { abs, parseDecimal, roundDp, toDecimalString } from '../../../../../../packages/shared-ts/src/decimal/index.js';
import { cvPct } from '../domain/target-stats.js';
import { UNKNOWN_USER, type Labels } from './autoverify.mapper.js';

type Row = Record<string, any>;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const opt = (k: string, v: unknown, f: (x: any) => unknown = (x) => x): Row => (v === null || v === undefined ? {} : { [k]: f(v) });
const label = (labels: Labels, id: unknown): string => (typeof id === 'string' ? labels.get(id) : undefined) ?? UNKNOWN_USER;

/** cv_pct = sd / |mean| * 100 to 4 places, display only; omitted when mean = 0 (undefined). */
function cv(mean: string, sd: string): Row {
  const m = parseDecimal(mean), s = parseDecimal(sd), c = m && s ? cvPct(abs(m), s) : undefined;
  return c ? { cv_pct: toDecimalString(roundDp(c, 4)) } : {};
}

/** Every user id a DTO of these rows will name. */
export const targetUserIds = (rows: Row[]): string[] =>
  [...new Set(rows.flatMap((r) => [r['created_by'], r['activated_by']]).filter((x): x is string => typeof x === 'string'))];

export const targetDto = (r: Row, labels: Labels): Row => ({
  id: r['id'], version: r['version'], plan_id: r['plan_id'], lot_id: r['lot_id'], level_id: r['level_id'],
  mean: r['mean'], sd: r['sd'], ...cv(r['mean'], r['sd']), unit_code: r['unit_code'], source: r['source'],
  ...(r['source'] === 'established' && r['basis_n'] != null
    ? { basis: { n: r['basis_n'], from: iso(r['basis_from']), to: iso(r['basis_to']), observation_ids_sha256: r['basis_observation_ids_sha256'] } } : {}),
  status: r['status'], ...opt('effective_from', r['effective_from'], iso), ...opt('effective_to', r['effective_to'], iso), ...opt('note', r['note']),
  created_by_display: label(labels, r['created_by']),
  ...(r['activated_by'] ? { activated_by_display: label(labels, r['activated_by']) } : {}),
});
