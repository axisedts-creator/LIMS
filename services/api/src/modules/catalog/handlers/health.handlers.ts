// #1 getCatalogRevision, #4 getCatalogHealthReport (02-TRD §5 rows 1, 4; PRD §7 metric). Read-only; auth / x-permission are the core pipeline's,
// the handlers only fail closed without an authenticated context. Single-table SELECTs with an explicit tenant_id bind (REQ-SEC-024); lists are computed in JS.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
type RCtx = { tenantId: string; tx: Tx; now?: () => Date };
const MAX = 200;                                   // catalog.yaml: CatalogHealthReport lists maxItems 200
const NARRATIVE_FAMILY = new Set(['microbiology', 'narrative', 'molecular']);
const sel = async (tx: Tx, text: string, values: unknown[]): Promise<any[]> => (await tx.query(text, values)).rows;

function bind(run: (c: RCtx, req: HandlerRequest) => Promise<unknown>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<RCtx>;
    if (typeof c.tenantId !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    return { status: 200, body: await run(c as RCtx, req) };
  };
}

async function revision({ tx, tenantId }: RCtx) {
  const [r] = await sel(tx, 'SELECT catalog_revision, global_release_seen FROM catalog.catalog_state WHERE tenant_id = $1', [tenantId]);
  return { catalog_revision: r ? Number(r.catalog_revision) : 0, global_release_seen: r ? Number(r.global_release_seen) : 0 };   // bigint arrives as a string
}

async function healthReport({ tx, tenantId, now }: RCtx) {
  const at = new Date(now ? now() : Date.now()).getTime();   // ctx.now() may yield a Date or an ISO string
  const q = (table: string, cols: string, extra = '', more: unknown[] = []) => sel(tx, `SELECT ${cols} FROM catalog.${table} WHERE tenant_id = $1${extra}`, [tenantId, ...more]);

  const [orderables, tests, specimen, analytes, versions, sets, lists, taxRules] = await Promise.all([
    q('orderables', 'id', ' AND is_active = true'), q('tests', 'id, workflow_type', ' AND is_active = true'), q('test_specimen_types', 'test_id'),
    q('analytes', 'id, test_id, code, is_active'), q('analyte_versions', 'analyte_id, result_type, formula_inputs', ' AND status = $2', ['published']),
    q('reference_range_sets', 'analyte_id', ' AND status = $2', ['published']), q('price_lists', 'id', ' AND owner_kind = $2', ['default']),
    q('tax_rules', 'effective_from, effective_to', ' AND scope = $2', ['tenant_default']),
  ]);

  const listIds = lists.map((l) => l.id as string);
  const pubVersions = listIds.length ? await q('price_list_versions', 'id', ' AND status = $2 AND price_list_id = ANY($3)', ['published', listIds]) : [];
  const vIds = pubVersions.map((v) => v.id as string);
  const items = vIds.length ? await q('price_list_items', 'orderable_id', ' AND price_list_version_id = ANY($2)', [vIds]) : [];

  const priced = new Set(items.map((i) => i.orderable_id as string));
  const hasSpecimen = new Set(specimen.map((s) => s.test_id as string));
  const active = analytes.filter((a) => a.is_active !== false);
  const activeCodes = new Set(active.map((a) => a.code as string));
  const publishedRanges = new Set(sets.map((s) => s.analyte_id as string));
  const resultTypesOf = (testId: string) => {
    const mine = new Set(analytes.filter((a) => a.test_id === testId).map((a) => a.id as string));
    return new Set(versions.filter((v) => mine.has(v.analyte_id)).map((v) => v.result_type as string));
  };
  const numeric = new Set(versions.filter((v) => v.result_type === 'numeric').map((v) => v.analyte_id as string));
  const unmapped = new Set<string>();
  for (const v of versions) for (const code of (v.formula_inputs ?? []) as string[]) if (!activeCodes.has(code)) unmapped.add(code);

  const missingAnalyte = tests.filter((t) => {
    const need = t.workflow_type === 'attachment' ? 'attachment' : NARRATIVE_FAMILY.has(t.workflow_type) ? 'narrative' : undefined;
    return need !== undefined && !resultTypesOf(t.id).has(need);
  });

  const lists4 = {
    active_orderables_without_default_price: orderables.filter((o) => !priced.has(o.id)).map((o) => o.id as string),
    analytes_without_reference_range: active.filter((a) => numeric.has(a.id) && !publishedRanges.has(a.id)).map((a) => a.id as string),
    tests_without_specimen_type: tests.filter((t) => !hasSpecimen.has(t.id)).map((t) => t.id as string),
    tests_missing_required_analyte: missingAnalyte.map((t) => t.id as string),
    unmapped_formula_inputs: [...unmapped].sort(),
  };
  let truncated = false;
  const cut = Object.fromEntries(Object.entries(lists4).map(([k, v]) => {
    if (v.length > MAX) truncated = true;
    return [k, [...v].sort().slice(0, MAX)];
  }));
  const taxOk = taxRules.some((r) => new Date(r.effective_from).getTime() <= at && (r.effective_to == null || at < new Date(r.effective_to).getTime()));
  return { ...cut, tax_default_configured: taxOk, truncated };
}

export const healthHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getCatalogRevision: bind(revision),
  getCatalogHealthReport: bind(healthReport),
});
