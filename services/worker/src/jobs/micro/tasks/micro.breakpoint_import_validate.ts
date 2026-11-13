// Task micro.breakpoint_import_validate (02-TRD §9, §9.1; 01-PRD AC-12.2, AC-12.4; 07-SECURITY S-12, S-13).
// uploaded -> validating is committed on its own (ctx.db.tx) so a failed attempt leaves `validating`; a retry finds `validating` and issues no status UPDATE
// (the guard has no validating -> validating, review m#20). Rows / bands / issues / counts / final status are written in ONE task transaction (ctx.tx):
// a crash rolls everything back, nothing needs deleting on retry. Parse-level and validation outcomes END the job (resolve); only an unexpected
// failure rejects, and on the final attempt the set becomes `invalid` + `file.processing_failed` (never carrying the underlying error text).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadMicroConfig } from '../../../../../api/src/modules/micro/config.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import type { JobContext, TaskHandler } from '../../../core/manifest.js';
import { parseBreakpointFile, type ParsedIssue, type ParsedRow } from '../csv/breakpoint-file.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 1000;                                              // rows per INSERT: 12 binds x 1,000 << 65,535
const PROCESSING_FAILED = 'The import file could not be processed.';

interface SetRow { id: string; standard: string; status: string; file_object_path: string }
type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
interface Storage { read(bucket: string, path: string): Promise<Uint8Array> }

const SELECT_SET = 'SELECT id, standard, status, file_object_path FROM micro.breakpoint_sets WHERE tenant_id = $1 AND id = $2';
const START = "UPDATE micro.breakpoint_sets SET status = 'validating', validation_started_at = now(), updated_at = now(), updated_by = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'uploaded'";
const FINISH = "UPDATE micro.breakpoint_sets SET status = $3, validated_at = now(), row_count = $4, band_count = $5, error_count = $6, warning_count = $7, updated_at = now(), updated_by = $8, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'validating'";

async function insertBatches(q: Query, table: string, cols: readonly string[], tuples: unknown[][]): Promise<void> {
  for (let i = 0; i < tuples.length; i += BATCH) {
    const chunk = tuples.slice(i, i + BATCH);
    const params: unknown[] = [];
    const values = chunk.map((t) => `(${t.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`).join(', ');
    await q(`INSERT INTO micro.${table} (${cols.join(', ')}) VALUES ${values}`, params);
  }
}

const ISSUE_COLS = ['id', 'tenant_id', 'set_id', 'line_no', 'severity', 'code', 'field', 'message', 'created_by'] as const;
const issueTuples = (tenantId: string, setId: string, actor: string, issues: readonly ParsedIssue[]) =>
  issues.map((i) => [uuidv7(), tenantId, setId, i.line_no, i.severity, i.code, i.field, i.message, actor]);

interface Dict { has(code: string): boolean; active(code: string): boolean }
/** Global rows merged with the tenant's own (tenant shadows global by code). */
async function dictionary(q: Query, tenantId: string, global: string, tenant: string): Promise<Dict> {
  const map = new Map<string, boolean>();
  for (const r of (await q(`SELECT code, is_active FROM micro.${global}`)).rows) map.set(String(r.code), r.is_active !== false);
  for (const r of (await q(`SELECT code, is_active FROM micro.${tenant} WHERE tenant_id = $1`, [tenantId])).rows) map.set(String(r.code), r.is_active !== false);
  return { has: (c) => map.has(c), active: (c) => map.get(c) === true };
}

/** Dictionary / standard checks the file layer cannot do. Issues are per row (first line of the key) or per band line. */
async function checkDictionaries(q: Query, tenantId: string, standard: string, rows: readonly ParsedRow[]): Promise<ParsedIssue[]> {
  if (rows.length === 0) return [];
  const [organisms, groups, antibiotics, sites] = await Promise.all([
    dictionary(q, tenantId, 'g_cs_organisms', 'cs_organisms'), dictionary(q, tenantId, 'g_cs_organism_groups', 'cs_organism_groups'),
    dictionary(q, tenantId, 'g_cs_antibiotics', 'cs_antibiotics'), dictionary(q, tenantId, 'g_cs_specimen_sites', 'cs_specimen_sites'),
  ]);
  const categories = new Set<string>();
  for (const r of (await q('SELECT standard, code, is_active FROM micro.g_cs_ast_interpretations')).rows) if (r.standard === standard && r.is_active !== false) categories.add(String(r.code));
  const restricted = new Map<string, Set<string>>();
  for (const r of (await q('SELECT standard, antibiotic_code, allowed_codes, is_active FROM micro.g_ast_category_restrictions')).rows) {
    if (r.standard === standard && r.is_active !== false) restricted.set(String(r.antibiotic_code), new Set<string>(r.allowed_codes));
  }

  const out: ParsedIssue[] = [];
  const add = (line: number, severity: 'error' | 'warning', code: string, field: string, message: string) => { out.push({ line_no: line, severity, code, field, message }); };
  const check = (d: Dict, value: string | null, line: number, field: string, unknown: string) => {
    if (value === null) return;
    if (!d.has(value)) add(line, 'error', unknown, field, `${field} is not in the code list.`);
    else if (!d.active(value)) add(line, 'warning', 'row.code_inactive', field, `${field} refers to an inactive code.`);
  };
  for (const r of rows) {
    if (r.organism_scope === 'organism') check(organisms, r.organism_code, r.line_no, 'organism_code', 'row.organism_unknown');
    else if (r.organism_scope === 'group') check(groups, r.organism_code, r.line_no, 'organism_code', 'row.group_unknown');
    check(antibiotics, r.antibiotic_code, r.line_no, 'antibiotic_code', 'row.antibiotic_unknown');
    check(sites, r.specimen_site_code, r.line_no, 'specimen_site_code', 'row.site_unknown');
    const allowed = restricted.get(r.antibiotic_code);
    for (const b of r.bands) {
      if (!categories.has(b.category_code)) add(b.line_no, 'error', 'row.category_invalid', 'category_code', 'category_code is not a category of the standard of this set.');
      else if (allowed && !allowed.has(b.category_code)) add(b.line_no, 'error', 'row.category_restricted', 'category_code', 'category_code is not allowed for this antibiotic.');
    }
  }
  return out;
}

async function persistFailure(ctx: JobContext, tenantId: string, setId: string): Promise<void> {
  await ctx.db.tx(async (c) => {
    const q = c.tx.query.bind(c.tx) as Query;
    const cur: SetRow | undefined = (await q(SELECT_SET, [tenantId, setId])).rows[0];
    if (!cur || (cur.status !== 'uploaded' && cur.status !== 'validating')) return;
    if (cur.status === 'uploaded') await q(START, [tenantId, setId, ctx.actor.id]);
    await insertBatches(q, 'breakpoint_import_issues', ISSUE_COLS, issueTuples(tenantId, setId, ctx.actor.id, [{ line_no: null, severity: 'error', code: 'file.processing_failed', field: null, message: PROCESSING_FAILED }]));
    await q(FINISH, [tenantId, setId, 'invalid', 0, 0, 1, 0, ctx.actor.id]);
  });
}

export const breakpointImportValidate: TaskHandler = async (payload, ctx) => {
  const tenantId = String(payload.tenant_id ?? ''), setId = String(payload.set_id ?? '');
  if (!UUID.test(tenantId) || !UUID.test(setId) || ctx.tenantId !== tenantId) {
    ctx.log.warn({ task: 'micro.breakpoint_import_validate', reason: 'bad_payload_or_tenant' }, 'micro breakpoint import skipped');
    return;                                                       // a retry cannot fix this
  }
  const q = ctx.tx.query.bind(ctx.tx) as Query;
  const set: SetRow | undefined = (await q(SELECT_SET, [tenantId, setId])).rows[0];
  if (!set || (set.status !== 'uploaded' && set.status !== 'validating')) return;   // not visible, or already finished: duplicate delivery

  try {
    if (set.status === 'uploaded') {
      const moved = await ctx.db.tx(async (c) => (await (c.tx.query.bind(c.tx) as Query)(START, [tenantId, setId, ctx.actor.id])).rowCount ?? 0);
      if (moved === 0) return;                                    // lost a race with a discard
    }
    if (set.file_object_path !== `${tenantId}/breakpoints/${setId}.csv`) throw new LimsError('common.internal', 'micro breakpoint file path mismatch');
    const bytes = await (ctx.storage as Storage).read('micro-imports', set.file_object_path);
    const cfg = loadMicroConfig(process.env);
    const parsed = parseBreakpointFile(bytes, { maxLines: cfg.importMaxLines, timeoutMs: cfg.importTimeoutMs });
    const issues: ParsedIssue[] = [...parsed.issues, ...await checkDictionaries(q, tenantId, set.standard, parsed.rows)];
    issues.sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0));

    const badLines = new Set(issues.filter((i) => i.severity === 'error' && i.line_no !== null).map((i) => i.line_no));
    const keep = parsed.rows.filter((r) => !badLines.has(r.line_no) && !r.bands.some((b) => badLines.has(b.line_no)));
    const errors = issues.filter((i) => i.severity === 'error').length, warnings = issues.length - errors;
    const bandCount = keep.reduce((n, r) => n + r.bands.length, 0);

    const rowIds = keep.map(() => uuidv7());
    const actor = ctx.actor.id;
    await insertBatches(q, 'breakpoint_rows', ['id', 'tenant_id', 'set_id', 'line_no', 'organism_scope', 'organism_code', 'antibiotic_code', 'method', 'specimen_site_code', 'qualifier_code', 'created_by'],
      keep.map((r, i) => [rowIds[i], tenantId, setId, r.line_no, r.organism_scope, r.organism_code, r.antibiotic_code, r.method, r.specimen_site_code, r.qualifier_code, actor]));
    await insertBatches(q, 'breakpoint_bands', ['id', 'tenant_id', 'set_id', 'row_id', 'band_no', 'category_code', 'lower_value', 'lower_inclusive', 'upper_value', 'upper_inclusive', 'note', 'created_by'],
      keep.flatMap((r, i) => r.bands.map((b) => [uuidv7(), tenantId, setId, rowIds[i], b.band_no, b.category_code, b.lower_value, b.lower_inclusive, b.upper_value, b.upper_inclusive, b.note, actor])));
    await insertBatches(q, 'breakpoint_import_issues', ISSUE_COLS, issueTuples(tenantId, setId, actor, issues));
    const done = await q(FINISH, [tenantId, setId, errors > 0 ? 'invalid' : 'validated', keep.length, bandCount, errors, warnings, actor]);
    if ((done.rowCount ?? 0) !== 1) throw new LimsError('common.internal', 'micro breakpoint set is no longer validating');
    ctx.log.info({ task: 'micro.breakpoint_import_validate', set_id: setId, status: errors > 0 ? 'invalid' : 'validated', error_count: errors, warning_count: warnings }, 'micro breakpoint import validated');
  } catch (e) {
    ctx.log.error({ task: 'micro.breakpoint_import_validate', set_id: setId, attempt: ctx.attempt, error_name: e instanceof Error ? e.name : 'unknown' }, 'micro breakpoint import attempt failed');
    if (ctx.attempt >= ctx.maxAttempts) await persistFailure(ctx, tenantId, setId);   // the task tx is rolled back by the worker; this one is independent
    throw e;                                                      // retry, or dead letter after the final attempt (02-CV §7.5)
  }
};
