// DTO allowlists of 02-TRD §5.10 for #36-#41, #44, #45: only listed fields leave; no tenant_id / *_by ids / updated_* / retire_reason / unknown columns;
// no null on the wire (absent optional = key omitted). Timestamps are ISO-8601 UTC strings.
type Row = Record<string, any>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const opt = (k: string, v: unknown, f: (x: any) => unknown = (x) => x): Row => (v === null || v === undefined ? {} : { [k]: f(v) });
/** Shown when the user directory cannot name an id (never the raw id: it is an internal identifier). */
export const UNKNOWN_USER = 'Unknown user';

export type Labels = ReadonlyMap<string, string>;
const label = (labels: Labels, id: unknown): string => (typeof id === 'string' ? labels.get(id) : undefined) ?? UNKNOWN_USER;

/** The lifecycle timestamps shared by the version DTO and its list summary. */
const lifecycle = (r: Row, labels: Labels): Row => ({
  ...opt('simulation_started_at', r['simulation_started_at'], iso),
  ...opt('simulation_stopped_at', r['simulation_stopped_at'], iso),
  ...opt('activated_at', r['activated_at'], iso),
  ...(r['activated_by'] ? { activated_by_display: label(labels, r['activated_by']) } : {}),
  ...opt('retired_at', r['retired_at'], iso),
});

export const versionSummaryDto = (r: Row, labels: Labels): Row => ({
  id: r['id'], version_no: r['version_no'], status: r['status'], rule_count: r['rule_count'],
  created_at: iso(r['created_at']), created_by_display: label(labels, r['created_by']), ...lifecycle(r, labels),
});

export const versionDto = (r: Row, labels: Labels): Row => ({
  id: r['id'], rule_set_id: r['rule_set_id'], version_no: r['version_no'], version: r['version'], status: r['status'],
  definition: r['definition'], rule_count: r['rule_count'],
  created_at: iso(r['created_at']), created_by_display: label(labels, r['created_by']), ...lifecycle(r, labels),
});

export const ruleSetDto = (set: Row, versions: Row[], labels: Labels): Row => ({
  id: set['id'], version: set['version'],
  ...opt('active_version_id', set['active_version_id']), ...opt('simulating_version_id', set['simulating_version_id']),
  versions: versions.map((v) => versionSummaryDto(v, labels)),
});

/** Every user id a DTO of these rows will name. */
export const userIdsOf = (rows: Row[]): string[] =>
  [...new Set(rows.flatMap((r) => [r['created_by'], r['activated_by']]).filter((x): x is string => typeof x === 'string'))];
