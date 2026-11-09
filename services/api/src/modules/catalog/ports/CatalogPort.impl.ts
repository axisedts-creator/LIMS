// CatalogPort real implementation: T-28a getTest, getPanel, resolveOrderables, referenceRangeFor, criticalLimitsFor; T-28b priceFor (03-IC §4.2 cases 6-8, 02-TRD §7.4-§7.6).
// Spec: 03-IC §4.2, 02-TRD §6.1 (method table), §6.3 (cache), §7.3 (band selection), §7.7 (panel expansion); contracts/ports/CatalogPort.ts.
// Read-only: every query runs on ctx.tx (no transaction control, no write, no lock). Tenant comes from ctx.tenantId only; every value is a bind parameter.
// Cache: time-independent bundles keyed (tenant, catalog_revision, kind, id); the revision is read ONCE per ctx (memoised) and asOf / at are applied in memory.
import type {
  AnalyteDefinition, CatalogPortV1, CriticalLimitsMatch, InstrumentCodeMapping, PanelDefinition, PriceQuote, ReferenceRangeMatch, ResolvedOrderables, TestDefinition,
} from '../../../../../../contracts/ports/CatalogPort.js';
import { LimsError } from '../../../core/errors.js';
import type { CatalogCache } from '../cache/catalogCache.js';
import { expandToTestIds, type PanelGraph } from '../domain/panelGraph.js';
import { isTaxCode, isTaxTypeUsable, localMidnight, taxTypeVersionAt } from '../domain/tax.js';
import { resolveCriticalLimits,resolveReferenceRange, selectSet, type RangeSet } from '../domain/rangeMatch.js';
import { currentRevision } from '../repo/catalogState.repo.js';
import { listStatus } from '../domain/priceMatch.js';
import { createQuoteService } from '../service/quote.service.js';

type Row = Record<string, any>;
type Ctx = { tenantId: string; tx: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }; now(): string | Date };
export type CatalogPortNonPrice = Pick<CatalogPortV1, 'getTest' | 'getPanel' | 'resolveOrderables' | 'referenceRangeFor' | 'criticalLimitsFor' | 'mapInstrumentCode'
  | 'getReferrer' | 'getCreditParty' | 'resolveCommentCodes'>;
export type CatalogPortImpl = CatalogPortNonPrice & Pick<CatalogPortV1, 'priceFor' | 'getTaxRate' | 'getPriceListStatus'>;
const CONTEXT_KEYS = [['priceListId', 'price_list_id'], ['creditPartyId', 'credit_party_id'], ['referrerId', 'referrer_id'], ['centreId', 'centre_id']] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const VERSIONS = ['published', 'superseded', 'retired'];       // statuses a version / set can be effective in (never draft / discarded)
const invalid = (what: string) => new LimsError('common.validation_failed', what);
const notFound = () => new LimsError('common.not_found');

// ---- input checks
const uuid = (v: unknown, what: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw invalid(what); return v; };
function instant(v: unknown, what: string): Date {
  if (typeof v !== 'string' || !ISO.test(v)) throw invalid(what);
  const d = new Date(v);
  if (Number.isNaN(+d)) throw invalid(what);
  return d;
}
const validDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00.000Z`).toJSON()?.startsWith(s) === true;   // toJSON() = null for an impossible date
const STAFF = ['user', 'system'];                                // actor types that may read contact / billing data (AB-19)
const staffOnly = (ctx: any) => { if (!STAFF.includes(ctx?.actor?.type)) throw new LimsError('auth.forbidden'); };
const upper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());   // ASCII only: no Unicode case-fold forgeries (ı -> I)
const MAX_HOPS = 10;                                             // merged-referrer chain bound (a cycle can never loop)
const nowOf = (ctx: Ctx): string => { const n = ctx.now(); return typeof n === 'string' ? n : n.toISOString(); };
const asOfOf = (ctx: Ctx, v: unknown) => instant(v ?? nowOf(ctx), 'asOf');

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
}
const byNum = (a: Row, b: Row, col = 'sort_order') => (a[col] ?? 100) - (b[col] ?? 100) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const opt = <K extends string, V>(k: K, v: V | null | undefined) => (v == null ? {} : ({ [k]: v } as Record<K, V>));

// ---- cached shapes (time-independent)
interface Req { specimenTypeCode: string; reportLabel?: string; containerCode?: string }
interface AnalyteVersion { status: string; effective_from: Date; effective_to: Date | null; def: Omit<AnalyteDefinition, 'id' | 'code' | 'name' | 'reportable' | 'sortOrder' | 'reportSubheading' | 'printName'> }
interface AnalyteBundle { base: Pick<AnalyteDefinition, 'id' | 'code' | 'name' | 'reportable' | 'sortOrder'> & { reportSubheading?: string; printName?: string }; versions: AnalyteVersion[] }
interface Tat { priority: string; segment: 'within_lab' | 'total'; seconds: number; from: Date; to: Date | null }
interface TestBundle {
  id: string; code: string; name: string; departmentId: string; departmentCode: string; departmentName: string; workflowType: TestDefinition['workflowType'];
  isActive: boolean; revision: number; usesExistingMaterial: boolean; reqs: Req[]; analytes: AnalyteBundle[]; tat: Tat[];
}
interface PanelNode { id: string; code: string; name: string; panelKind: PanelDefinition['panelKind']; sexRestriction?: 'male' | 'female'; isActive: boolean; revision: number; members: Array<{ kind: 'test' | 'panel'; id: string }> }
interface RangeBundle { versions: Array<{ status: string; effective_from: Date; effective_to: Date | null; unit_code: string | null; method_id: string | null }>; ref: RangeSet[]; crit: RangeSet[]; specimenIds: Record<string, string> }

export function createCatalogPort(deps: { cache: CatalogCache }): CatalogPortImpl {
  const { cache } = deps;
  const quotes = createQuoteService();
  const q = async (ctx: Ctx, text: string, values: unknown[]): Promise<Row[]> => (await ctx.tx.query(text, values)).rows;

  // The catalog_revision, read once per ctx (the cache-key revision, 02-TRD §6.3). A rejected read is not memoised.
  const revisions = new WeakMap<object, Promise<number>>();
  const revisionOf = (ctx: Ctx): Promise<number> => {
    let p = revisions.get(ctx);
    if (!p) { p = currentRevision(ctx.tx, ctx.tenantId); revisions.set(ctx, p); p.catch(() => revisions.delete(ctx)); }
    return p;
  };

  // ---- orderables (request-local row map so each id is fetched at most once per call)
  const fetchOrderables = async (ctx: Ctx, local: Map<string, Row>, ids: readonly string[]): Promise<void> => {
    const need = uniq(ids).filter((id) => !local.has(id));
    if (!need.length) return;
    for (const r of await q(ctx, 'SELECT id, kind, code, name, department_id, sex_restriction, is_active, revision FROM catalog.orderables WHERE tenant_id = $1 AND id = ANY($2)', [ctx.tenantId, need])) local.set(r.id, r);
  };

  // ---- tests (bulk: statement count does not depend on how many ids)
  async function loadTests(ctx: Ctx, local: Map<string, Row>, ids: readonly string[]): Promise<TestBundle[]> {
    const t = ctx.tenantId;
    await fetchOrderables(ctx, local, ids);
    const ords = ids.map((id) => local.get(id));
    if (ords.some((o) => !o || o.kind !== 'test')) throw notFound();
    const tests = new Map((await q(ctx, 'SELECT id, workflow_type, uses_existing_material, is_active FROM catalog.tests WHERE tenant_id = $1 AND id = ANY($2)', [t, ids])).map((r) => [r.id, r]));
    if (ids.some((id) => !tests.has(id))) throw notFound();
    const deptIds = uniq(ords.map((o) => o!.department_id).filter((x) => x != null));
    const depts = new Map((deptIds.length ? await q(ctx, 'SELECT id, code, name FROM catalog.departments WHERE tenant_id = $1 AND id = ANY($2)', [t, deptIds]) : []).map((r) => [r.id, r]));
    const spec = await q(ctx, 'SELECT test_id, specimen_type_id, container_id, is_preferred FROM catalog.test_specimen_types WHERE tenant_id = $1 AND test_id = ANY($2)', [t, ids]);
    const stIds = uniq(spec.map((r) => r.specimen_type_id)), ctIds = uniq(spec.map((r) => r.container_id).filter((x) => x != null));
    const sts = new Map((stIds.length ? await q(ctx, 'SELECT id, code, report_label FROM catalog.specimen_types WHERE tenant_id = $1 AND id = ANY($2)', [t, stIds]) : []).map((r) => [r.id, r]));
    const cts = new Map((ctIds.length ? await q(ctx, 'SELECT id, code FROM catalog.containers WHERE tenant_id = $1 AND id = ANY($2)', [t, ctIds]) : []).map((r) => [r.id, r]));
    const analytes = await q(ctx, 'SELECT id, test_id, code, name, print_name, report_subheading, sort_order, is_reportable FROM catalog.analytes WHERE tenant_id = $1 AND test_id = ANY($2)', [t, ids]);
    const aIds = analytes.map((a) => a.id);
    const vers = aIds.length ? await q(ctx, 'SELECT analyte_id, status, result_type, unit_code, decimals, method_id, value_set_code, formula_expression, formula_inputs, formula_input_units, effective_from, effective_to FROM catalog.analyte_versions WHERE tenant_id = $1 AND analyte_id = ANY($2) AND status = ANY($3)', [t, aIds, VERSIONS]) : [];
    const mIds = uniq(vers.map((v) => v.method_id).filter((x) => x != null));
    const methods = new Map((mIds.length ? await q(ctx, 'SELECT id, name FROM catalog.methods WHERE tenant_id = $1 AND id = ANY($2)', [t, mIds]) : []).map((r) => [r.id, r]));
    const ordinalCodes = uniq(vers.filter((v) => v.result_type === 'ordinal' && v.value_set_code != null).map((v) => v.value_set_code as string));
    const sets = await loadOrdinalSets(ctx, ordinalCodes);
    const tats = await q(ctx, 'SELECT test_id, priority, segment, target_seconds, effective_from, effective_to FROM catalog.tat_targets WHERE tenant_id = $1 AND test_id = ANY($2)', [t, ids]);

    return ids.map((id): TestBundle => {
      const o = local.get(id)!, tr = tests.get(id)!, d = depts.get(o.department_id);
      const reqs = spec.filter((r) => r.test_id === id).map((r) => ({ pref: r.is_preferred === true, st: sts.get(r.specimen_type_id)!, ct: r.container_id == null ? undefined : cts.get(r.container_id) }))
        .sort((a, b) => Number(b.pref) - Number(a.pref) || (a.st.code < b.st.code ? -1 : a.st.code > b.st.code ? 1 : 0))
        .map((r): Req => ({ specimenTypeCode: r.st.code, ...opt('reportLabel', r.st.report_label), ...opt('containerCode', r.ct?.code) }));
      return deepFreeze({
        id, code: o.code, name: o.name, departmentId: o.department_id, departmentCode: d?.code, departmentName: d?.name, workflowType: tr.workflow_type,
        isActive: tr.is_active === true, revision: Number(o.revision), usesExistingMaterial: tr.uses_existing_material === true, reqs,
        analytes: analytes.filter((a) => a.test_id === id).sort((a, b) => byNum(a, b)).map((a): AnalyteBundle => ({
          base: { id: a.id, code: a.code, name: a.name, reportable: a.is_reportable !== false, sortOrder: a.sort_order, ...opt('reportSubheading', a.report_subheading), ...opt('printName', a.print_name) },
          versions: vers.filter((v) => v.analyte_id === a.id).map((v): AnalyteVersion => ({ status: v.status, effective_from: v.effective_from, effective_to: v.effective_to, def: versionDef(v, methods, sets) })),
        })),
        tat: tats.filter((r) => r.test_id === id).map((r): Tat => ({ priority: r.priority, segment: r.segment, seconds: r.target_seconds, from: r.effective_from, to: r.effective_to })),
      });
    });
  }

  /** Active values per ordinal set code, sortOrder asc; a tenant set with the code shadows the global one. */
  async function loadOrdinalSets(ctx: Ctx, codes: readonly string[]): Promise<Map<string, Array<{ code: string; display: string; sortOrder: number }>>> {
    const out = new Map<string, Array<{ code: string; display: string; sortOrder: number }>>();
    if (!codes.length) return out;
    const own = await q(ctx, 'SELECT id, code FROM catalog.cs_value_sets WHERE tenant_id = $1 AND code = ANY($2) AND is_active = $3', [ctx.tenantId, codes, true]);
    const ownVals = own.length ? await q(ctx, 'SELECT value_set_id, code, display, sort_order FROM catalog.cs_value_set_values WHERE tenant_id = $1 AND value_set_id = ANY($2) AND is_active = $3', [ctx.tenantId, own.map((s) => s.id), true]) : [];
    const globalCodes = codes.filter((c) => !own.some((s) => s.code === c));
    const globVals = globalCodes.length ? await q(ctx, 'SELECT value_set_code, code, display, sort_order FROM catalog.g_value_set_values WHERE value_set_code = ANY($1) AND is_active = $2', [globalCodes, true]) : [];
    const shape = (rows: Row[]) => rows.sort((a, b) => a.sort_order - b.sort_order || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)).map((r) => ({ code: r.code, display: r.display, sortOrder: r.sort_order }));
    for (const s of own) out.set(s.code, shape(ownVals.filter((v) => v.value_set_id === s.id)));
    for (const c of globalCodes) out.set(c, shape(globVals.filter((v) => v.value_set_code === c)));
    return out;
  }

  const versionDef = (v: Row, methods: Map<string, Row>, sets: Map<string, Array<{ code: string; display: string; sortOrder: number }>>): AnalyteVersion['def'] => ({
    resultType: v.result_type,
    ...opt('unitCode', v.unit_code), ...opt('decimals', v.decimals), ...opt('methodName', methods.get(v.method_id)?.name),
    ...(v.formula_expression == null ? {} : { formula: { expression: v.formula_expression, inputAnalyteCodes: [...(v.formula_inputs ?? [])], ...(v.formula_input_units == null ? {} : { inputUnitCodes: { ...v.formula_input_units } }) } }),
    ...(v.result_type === 'ordinal' && v.value_set_code != null ? { ordinalSetCode: v.value_set_code, ordinalSetValues: (sets.get(v.value_set_code) ?? []).map((x) => ({ ...x })) } : {}),
  });

  /** TestDefinition at `asOf` from the cached bundle. Always builds fresh objects. */
  function definitionOf(b: TestBundle, asOf: Date): TestDefinition {
    const pref = b.reqs[0];
    const tatNow = (p: string) => b.tat.filter((r) => r.priority === p && +r.from <= +asOf && (r.to == null || +asOf < +r.to)).sort((x, y) => +y.from - +x.from)[0];
    const routine = tatNow('routine'), urgent = tatNow('urgent');
    const analytes = b.analytes.flatMap((a): AnalyteDefinition[] => {
      const v = selectSet(a.versions, asOf);
      if (!v) return [];
      const d = v.def;
      return [{
        id: a.base.id, code: a.base.code, name: a.base.name, resultType: d.resultType,
        ...opt('unitCode', d.unitCode), ...opt('decimals', d.decimals), ...opt('methodName', d.methodName),
        ...(d.formula ? { formula: { expression: d.formula.expression, inputAnalyteCodes: [...d.formula.inputAnalyteCodes], ...(d.formula.inputUnitCodes ? { inputUnitCodes: { ...d.formula.inputUnitCodes } } : {}) } } : {}),
        ...(d.ordinalSetCode ? { ordinalSetCode: d.ordinalSetCode, ordinalSetValues: (d.ordinalSetValues ?? []).map((x) => ({ ...x })) } : {}),
        reportable: a.base.reportable, sortOrder: a.base.sortOrder, ...opt('reportSubheading', a.base.reportSubheading), ...opt('printName', a.base.printName),
      }];
    });
    return {
      id: b.id, code: b.code, name: b.name, departmentId: b.departmentId, departmentCode: b.departmentCode, departmentName: b.departmentName,
      specimenTypeCodes: b.reqs.map((r) => r.specimenTypeCode), ...opt('containerCode', pref?.containerCode),
      workflowType: b.workflowType, analytes,
      ...(routine || urgent ? { tatTargetSeconds: { ...(routine ? { routine: routine.seconds } : {}), ...(urgent ? { urgent: urgent.seconds } : {}) } } : {}),
      isActive: b.isActive, revision: b.revision,
      ...opt('tatTargetSegment', (routine ?? urgent)?.segment), ...opt('specimenReportLabel', pref?.reportLabel), usesExistingMaterial: b.usesExistingMaterial,
    };
  }

  // ---- panels (bulk)
  async function loadPanels(ctx: Ctx, local: Map<string, Row>, ids: readonly string[]): Promise<PanelNode[]> {
    const t = ctx.tenantId;
    await fetchOrderables(ctx, local, ids);
    if (ids.some((id) => local.get(id)?.kind !== 'panel')) throw notFound();
    const panels = new Map((await q(ctx, 'SELECT id, panel_kind, is_active FROM catalog.panels WHERE tenant_id = $1 AND id = ANY($2)', [t, ids])).map((r) => [r.id, r]));
    if (ids.some((id) => !panels.has(id))) throw notFound();
    const members = await q(ctx, 'SELECT panel_id, member_orderable_id, sort_order FROM catalog.panel_members WHERE tenant_id = $1 AND panel_id = ANY($2)', [t, ids]);
    await fetchOrderables(ctx, local, members.map((m) => m.member_orderable_id));
    return ids.map((id): PanelNode => {
      const o = local.get(id)!, p = panels.get(id)!;
      return deepFreeze({
        id, code: o.code, name: o.name, panelKind: p.panel_kind, ...opt('sexRestriction', o.sex_restriction), isActive: p.is_active === true, revision: Number(o.revision),
        members: members.filter((m) => m.panel_id === id).sort((a, b) => a.sort_order - b.sort_order || (a.member_orderable_id < b.member_orderable_id ? -1 : 1))
          .flatMap((m) => { const k = local.get(m.member_orderable_id)?.kind; return k === 'test' || k === 'panel' ? [{ kind: k as 'test' | 'panel', id: m.member_orderable_id }] : []; }),
      });
    });
  }
  const panelDef = (n: PanelNode): PanelDefinition => ({ id: n.id, code: n.code, name: n.name, panelKind: n.panelKind, members: n.members.map((m) => ({ ...m })), ...opt('sexRestriction', n.sexRestriction), isActive: n.isActive, revision: n.revision });

  // ---- analyte ranges
  async function loadRanges(ctx: Ctx, analyteId: string): Promise<RangeBundle> {
    const t = ctx.tenantId;
    if (!(await q(ctx, 'SELECT id FROM catalog.analytes WHERE tenant_id = $1 AND id = $2', [t, analyteId])).length) throw notFound();
    const versions = await q(ctx, 'SELECT status, unit_code, method_id, effective_from, effective_to FROM catalog.analyte_versions WHERE tenant_id = $1 AND analyte_id = $2 AND status = ANY($3)', [t, analyteId, VERSIONS]);
    const sets = async (setTable: string, bandTable: string, bandCols: string): Promise<RangeSet[]> => {
      const ss = await q(ctx, `SELECT id, version_no, status, unit_code, method_id, effective_from, effective_to FROM catalog.${setTable} WHERE tenant_id = $1 AND analyte_id = $2 AND status = ANY($3)`, [t, analyteId, VERSIONS]);
      const bands = ss.length ? await q(ctx, `SELECT ${bandCols} FROM catalog.${bandTable} WHERE tenant_id = $1 AND set_id = ANY($2)`, [t, ss.map((s) => s.id)]) : [];
      return ss.map((s) => ({ ...s, bands: bands.filter((b) => b.set_id === s.id) } as RangeSet));
    };
    const AGE = 'sex, age_low_value, age_low_unit, age_high_value, age_high_unit, specimen_type_id, sort_order';
    const ref = await sets('reference_range_sets', 'reference_ranges', `id, set_id, ${AGE}, kind, low, high, normal_codes, display_text`);
    const crit = await sets('critical_limit_sets', 'critical_limits', `id, set_id, ${AGE}, low, high, abnormal_codes`);
    const stIds = uniq([...ref, ...crit].flatMap((s) => s.bands.map((b) => b.specimen_type_id)).filter((x): x is string => x != null));
    const sts = stIds.length ? await q(ctx, 'SELECT id, code FROM catalog.specimen_types WHERE tenant_id = $1 AND id = ANY($2)', [t, stIds]) : [];
    return deepFreeze({ versions: versions.map((v) => ({ status: v.status, effective_from: v.effective_from, effective_to: v.effective_to, unit_code: v.unit_code, method_id: v.method_id })), ref, crit, specimenIds: Object.fromEntries(sts.map((s) => [s.code, s.id])) });
  }

  interface RangeIn { analyteId: string; sex: string; ageDays?: number; specimenTypeCode?: string; birthOn?: string; at: Date }
  function rangeInput(input: any): RangeIn {
    if (!input || typeof input !== 'object') throw invalid('input');
    const analyteId = uuid(input.analyteId, 'analyteId');
    if (typeof input.sex !== 'string') throw invalid('sex');
    if (input.ageDays !== undefined && !(Number.isInteger(input.ageDays) && input.ageDays >= 0)) throw invalid('ageDays');
    if (input.specimenTypeCode !== undefined && typeof input.specimenTypeCode !== 'string') throw invalid('specimenTypeCode');
    if (input.birthOn !== undefined && !validDate(input.birthOn)) throw invalid('birthOn');
    return { analyteId, sex: input.sex, ...opt('ageDays', input.ageDays), ...opt('specimenTypeCode', input.specimenTypeCode), ...opt('birthOn', input.birthOn), at: instant(input.at, 'at') };
  }
  async function rangesFor(ctx: Ctx, i: RangeIn): Promise<{ b: RangeBundle; query: Parameters<typeof resolveReferenceRange>[0]['query'] }> {
    const rev = await revisionOf(ctx);
    const b = await cache.getOrLoad(ctx.tenantId, rev, 'ranges', i.analyteId, () => loadRanges(ctx, i.analyteId));
    const specimenTypeId = i.specimenTypeCode === undefined ? undefined : Object.hasOwn(b.specimenIds, i.specimenTypeCode) ? b.specimenIds[i.specimenTypeCode] : undefined;
    return { b, query: { sex: i.sex, at: i.at, ...opt('ageDays', i.ageDays), ...opt('birthOn', i.birthOn), ...opt('specimenTypeId', specimenTypeId) } };
  }

  // ---- cached entity access
  async function testBundle(ctx: Ctx, rev: number, id: string): Promise<TestBundle> {
    return cache.getOrLoad(ctx.tenantId, rev, 'test', id, async () => (await loadTests(ctx, new Map(), [id]))[0]!);
  }

  return {
    async getTest(ctx, input) {
      const id = uuid(input?.testId, 'testId');
      const asOf = asOfOf(ctx as Ctx, input.asOf);
      const b = await testBundle(ctx as Ctx, await revisionOf(ctx as Ctx), id);
      if (input.requireActive === true && !b.isActive) throw new LimsError('catalog.test_inactive');
      return definitionOf(b, asOf);
    },

    async getPanel(ctx, input) {
      const id = uuid(input?.panelId, 'panelId');
      asOfOf(ctx as Ctx, input.asOf);                                // validated; panels carry no time-dependent data
      const n = await cache.getOrLoad((ctx as Ctx).tenantId, await revisionOf(ctx as Ctx), 'panel', id, async () => (await loadPanels(ctx as Ctx, new Map(), [id]))[0]!);
      if (input.requireActive === true && !n.isActive) throw new LimsError('catalog.test_inactive');
      return panelDef(n);
    },

    async resolveOrderables(c, input): Promise<ResolvedOrderables> {
      const ctx = c as Ctx;
      if (!input || !Array.isArray(input.orderableIds) || input.orderableIds.length === 0) throw invalid('orderableIds');
      const inputIds = input.orderableIds.map((x: unknown) => uuid(x, 'orderableIds'));
      const asOf = asOfOf(ctx, input.asOf);
      const rev = await revisionOf(ctx), T = ctx.tenantId;
      const local = new Map<string, Row>();
      const nodes = new Map<string, PanelNode>(), tests = new Map<string, TestBundle>(), kind = new Map<string, 'test' | 'panel'>();

      // 1. classify the input ids (cache first, one orderables query for the rest)
      for (const id of uniq<string>(inputIds)) {
        const tb = cache.get<TestBundle>(T, rev, 'test', id), pn = tb ? undefined : cache.get<PanelNode>(T, rev, 'panel', id);
        if (tb) { tests.set(id, tb); kind.set(id, 'test'); } else if (pn) { nodes.set(id, pn); kind.set(id, 'panel'); }
      }
      const unknown = uniq<string>(inputIds).filter((id) => !kind.has(id));
      await fetchOrderables(ctx, local, unknown);
      for (const id of unknown) {
        const k = local.get(id)?.kind;
        if (k !== 'test' && k !== 'panel') throw notFound();
        kind.set(id, k);
      }

      // 2. walk the panels level by level (visited set: a cycle cannot loop the walk)
      const visited = new Set<string>(inputIds.filter((id: string) => kind.get(id) === 'panel'));
      const wantTests = new Set<string>(inputIds.filter((id: string) => kind.get(id) === 'test'));
      let level = [...visited];
      while (level.length) {
        const need = level.filter((id) => !nodes.has(id));
        for (const id of need) { const hit = cache.get<PanelNode>(T, rev, 'panel', id); if (hit) nodes.set(id, hit); }
        const cold = need.filter((id) => !nodes.has(id));
        if (cold.length) for (const n of await loadPanels(ctx, local, cold)) { nodes.set(n.id, n); cache.set(T, rev, 'panel', n.id, n); }
        const next: string[] = [];
        for (const id of level) {
          for (const m of nodes.get(id)!.members) {
            if (m.kind === 'test') wantTests.add(m.id);
            else if (!visited.has(m.id)) { visited.add(m.id); next.push(m.id); }
          }
        }
        level = next;
      }

      // 3. the tests (cache first, one bulk load for the rest)
      const coldTests: string[] = [];
      for (const id of wantTests) {
        if (tests.has(id)) continue;
        const hit = cache.get<TestBundle>(T, rev, 'test', id);
        if (hit) tests.set(id, hit); else coldTests.push(id);
      }
      if (coldTests.length) for (const b of await loadTests(ctx, local, coldTests)) { tests.set(b.id, b); cache.set(T, rev, 'test', b.id, b); }

      // 4. expand (cycle -> catalog.panel_cycle), then reject anything inactive
      const graph: PanelGraph = new Map([...nodes].map(([id, n]) => [id, n.members]));
      const orderables = inputIds.map((id: string) => {
        const k = kind.get(id)!;
        return { orderableId: id, kind: k, testIds: k === 'test' ? [id] : expandToTestIds(graph, { kind: 'panel', id }) };
      });
      if ([...visited].some((id) => !nodes.get(id)!.isActive) || [...tests.values()].some((b) => wantTests.has(b.id) && !b.isActive)) throw new LimsError('catalog.test_inactive');

      // 5. assemble
      const order = uniq<string>(orderables.flatMap((o: { testIds: string[] }) => o.testIds));
      const groups = new Map<string, { specimenTypeCode: string; containerCode?: string; testIds: string[] }>();
      for (const id of order) {
        const r = tests.get(id)!.reqs[0];
        if (!r) continue;                                            // uses_existing_material: no specimen requirement
        const key = JSON.stringify([r.specimenTypeCode, r.containerCode ?? null]);
        const g = groups.get(key) ?? { specimenTypeCode: r.specimenTypeCode, ...opt('containerCode', r.containerCode), testIds: [] as string[] };
        g.testIds.push(id); groups.set(key, g);
      }
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      return {
        orderables,
        tests: order.map((id) => definitionOf(tests.get(id)!, asOf)),
        specimenRequirements: [...groups.values()].sort((a, b) => cmp(a.specimenTypeCode, b.specimenTypeCode) || cmp(a.containerCode ?? '', b.containerCode ?? '')),
        catalogRevision: rev,
      };
    },

    /** Same engine as quotePrices (one rule set); prices are never cached, so a revision bump is visible at once. Read-only, tenant from ctx. */
    async priceFor(ctx, input): Promise<PriceQuote> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('input');
      const orderableId = uuid(input.orderableId, 'orderableId');
      if (input.priority !== 'routine' && input.priority !== 'urgent') throw invalid('priority');
      const at = instant(input.at, 'at').toISOString();
      const c = input.context as Record<string, unknown> | null | undefined;
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw invalid('context');
      const context: Record<string, string> = {};
      for (const [camel, snake] of CONTEXT_KEYS) if (c[camel] !== undefined) context[snake] = uuid(c[camel], `context.${camel}`);
      const { quotes: [r] } = await quotes.quotePrices(ctx as never, { items: [{ orderable_id: orderableId, priority: input.priority }], context, at });
      if (!r || r['error_code']) throw new LimsError(r?.['error_code'] ?? 'common.not_found');
      const t = r['tax'];
      return {
        orderableId: r['orderable_id'], priceListId: r['price_list_id'], priceListVersion: r['price_list_version'], source: r['source'],
        unitPrice: { amountPaisa: r['unit_price'].amount_paisa, currency: 'NPR' },
        ...(r['urgent_surcharge'] ? { urgentSurcharge: { amountPaisa: r['urgent_surcharge'].amount_paisa, currency: 'NPR' as const } } : {}),
        tax: { vat: t['vat'], ...opt('vatRateBp', t['vat_rate_bp']), ...opt('otherTaxCode', t['other_tax_code']), ...opt('otherTaxRateBp', t['other_tax_rate_bp']), ...opt('hsCode', t['hs_code']) },
      } as PriceQuote;
    },

    /** §7.6a. Reads only C3 tax-type rows on ctx.tx (VAT: global g_tax_types; else cs_tax_types of ctx.tenantId); uncached, so a rate edit is visible at once. */
    async getTaxRate(c, input): Promise<Awaited<ReturnType<CatalogPortV1['getTaxRate']>>> {
      const ctx = c as Ctx;
      const missing = () => new LimsError('catalog.tax_config_missing');
      const i = input && typeof input === 'object' ? (input as Row) : {};
      const taxCode: unknown = i['taxCode'];
      const t = localMidnight(i['on']);
      if (!isTaxCode(taxCode) || !t) throw missing();
      if (taxCode === 'VAT') {
        const [v] = await q(ctx, 'SELECT rate_bp, is_active FROM catalog.g_tax_types WHERE code = $1 AND is_active = $2', [taxCode, true]);
        if (!isTaxTypeUsable(v)) throw missing();
        return { taxCode, ratePercentBasisPoints: v!['rate_bp'], kind: 'vat', effectiveFrom: null };
      }
      const rows = await q(ctx, 'SELECT code, rate_bp, is_active, effective_from, effective_to FROM catalog.cs_tax_types WHERE tenant_id = $1 AND code = $2', [ctx.tenantId, taxCode]);
      const v = taxTypeVersionAt(rows as Array<{ code: string; effective_from: Date; effective_to: Date | null; is_active: boolean; rate_bp: number | null }>, taxCode, t);
      if (!isTaxTypeUsable(v)) throw missing();
      return { taxCode, ratePercentBasisPoints: v!.rate_bp!, kind: 'other', effectiveFrom: new Date(v!.effective_from).toISOString() };
    },

    /** §7.4a (08 A24.1). Uncached (two indexed reads on ctx.tx, tenant bound from ctx) so a version change is visible at once; unknown / other-tenant id -> common.not_found, nothing disclosed. */
    async getPriceListStatus(c, input) {
      const ctx = c as Ctx;
      const priceListId = uuid((input as Row | null | undefined)?.['priceListId'], 'priceListId');
      const [list] = await q(ctx, 'SELECT id, is_active FROM catalog.price_lists WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, priceListId]);
      if (!list) throw notFound();
      const vs = await q(ctx, 'SELECT status FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = $2', [ctx.tenantId, priceListId]);
      return { priceListId: list['id'], isActive: list['is_active'] === true, status: listStatus(vs.map((v) => v['status'])) };
    },

    async referenceRangeFor(ctx, input): Promise<ReferenceRangeMatch> {
      const i = rangeInput(input);
      const { b, query } = await rangesFor(ctx as Ctx, i);
      const m = resolveReferenceRange({ sets: b.ref, versions: b.versions, query });
      if (!m) throw new LimsError('catalog.no_reference_range');
      const codes = (m as { normalCodes?: readonly string[] }).normalCodes;
      return { ...m, ...(codes ? { normalCodes: [...codes] } : {}) } as ReferenceRangeMatch;
    },

    async criticalLimitsFor(ctx, input): Promise<CriticalLimitsMatch | undefined> {
      const i = rangeInput(input);
      const { b, query } = await rangesFor(ctx as Ctx, i);
      const m = resolveCriticalLimits({ sets: b.crit, versions: b.versions, query });
      const codes = (m as { abnormalCodes?: readonly string[] } | undefined)?.abnormalCodes;
      return m && ({ ...m, ...(codes ? { abnormalCodes: [...codes] } : {}) } as CriticalLimitsMatch);
    },

    /** CR-C3-001. Uncached, read-only. 'notification' (contact data) only for user|system actors (AB-19); a merged doctor reports its canonical id. */
    async getReferrer(c, input) {
      const ctx = c as Ctx;
      if (!input || typeof input !== 'object') throw invalid('input');
      if (input.purpose !== 'display' && input.purpose !== 'notification') throw invalid('purpose');
      const id = uuid(input.referrerId, 'referrerId');
      if (input.purpose === 'notification') staffOnly(ctx);
      const cols = `id, doctor_code, display_name, qualification, registration_no, is_verified, is_active, merged_into_id${input.purpose === 'notification' ? ', phone_e164, email' : ''}`;
      const r = (await q(ctx, `SELECT ${cols} FROM catalog.doctors WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, id]))[0];
      if (!r) throw notFound();
      let canonical: string = r.id, next: string | null = r.merged_into_id;
      for (let hop = 0; next != null; hop++) {
        if (hop >= MAX_HOPS) throw notFound();
        const d = (await q(ctx, 'SELECT id, merged_into_id FROM catalog.doctors WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, next]))[0];
        if (!d) throw notFound();
        canonical = d.id; next = d.merged_into_id;
      }
      const contact = { ...opt('phoneE164', r.phone_e164), ...opt('email', r.email) };
      return {
        referrerId: r.id, canonicalReferrerId: canonical, code: r.doctor_code, displayName: r.display_name,
        ...opt('qualification', r.qualification), ...opt('registrationNo', r.registration_no),
        isVerified: r.is_verified === true, isActive: r.is_active === true,
        ...(input.purpose === 'notification' && Object.keys(contact).length ? { contact } : {}),
      };
    },

    /** CR-C3-001. 'billing' (pan, address) and 'notification' (contact) only for user|system actors (AB-19). priceListId = the assigned list when it is active. */
    async getCreditParty(c, input) {
      const ctx = c as Ctx;
      if (!input || typeof input !== 'object') throw invalid('input');
      const purpose = input.purpose;
      if (purpose !== 'display' && purpose !== 'notification' && purpose !== 'billing') throw invalid('purpose');
      const id = uuid(input.creditPartyId, 'creditPartyId');
      if (purpose !== 'display') staffOnly(ctx);
      const extra = purpose === 'billing' ? ', pan, billing_address' : purpose === 'notification' ? ', contact_phone_e164, contact_email' : '';
      const T = ctx.tenantId;
      const r = (await q(ctx, `SELECT id, party_code, name, kind, allows_credit, is_active${extra} FROM catalog.credit_parties WHERE tenant_id = $1 AND id = $2`, [T, id]))[0];
      if (!r) throw notFound();
      const listId = (await q(ctx, 'SELECT price_list_id FROM catalog.price_list_assignments WHERE tenant_id = $1 AND credit_party_id = $2', [T, id]))[0]?.price_list_id;
      const list = listId == null ? undefined : (await q(ctx, 'SELECT id, is_active FROM catalog.price_lists WHERE tenant_id = $1 AND id = $2', [T, listId]))[0];
      const contact = { ...opt('phoneE164', r.contact_phone_e164), ...opt('email', r.contact_email) };
      return {
        creditPartyId: r.id, code: r.party_code, name: r.name, kind: r.kind, allowsCredit: r.allows_credit === true, isActive: r.is_active === true,
        ...(list?.is_active === true ? { priceListId: list.id } : {}),
        ...(purpose === 'billing' ? { ...opt('pan', r.pan), ...opt('billingAddressText', r.billing_address) } : {}),
        ...(purpose === 'notification' && Object.keys(contact).length ? { contact } : {}),
      };
    },

    /** CR-C3-001 (§4.14). Department entry wins over tenant-wide; inactive / unknown codes -> `unknown`; asOf = the text version effective then, [from, to). Two bulk reads. */
    async resolveCommentCodes(c, input) {
      const ctx = c as Ctx;
      if (!input || typeof input !== 'object' || !Array.isArray(input.codes) || input.codes.length > 50) throw invalid('codes');
      if (input.codes.some((x: unknown) => typeof x !== 'string')) throw invalid('codes');
      const dept = input.departmentId === undefined ? undefined : uuid(input.departmentId, 'departmentId');
      const asOf = input.asOf === undefined ? undefined : instant(input.asOf, 'asOf');
      const codes = uniq<string>(input.codes.map(upper));
      const T = ctx.tenantId;
      const rows = codes.length ? await q(ctx, 'SELECT id, code, department_id, text, version FROM catalog.comment_codes WHERE tenant_id = $1 AND is_active = $2 AND code = ANY($3)', [T, true, codes]) : [];
      const pick = (code: string) => rows.find((r) => r.code === code && dept !== undefined && r.department_id === dept) ?? rows.find((r) => r.code === code && r.department_id == null);
      const texts = asOf && rows.length
        ? await q(ctx, 'SELECT comment_code_id, text_version, text, effective_from, effective_to FROM catalog.comment_code_texts WHERE tenant_id = $1 AND comment_code_id = ANY($2)', [T, rows.map((r) => r.id)])
        : [];
      const resolved: Array<Record<string, unknown>> = [], unknown: string[] = [];
      for (const code of codes) {
        const r = pick(code);
        const t = !r ? undefined : !asOf ? { text: r.text, text_version: r.version }
          : texts.find((x) => x.comment_code_id === r.id && +x.effective_from <= +asOf && (x.effective_to == null || +asOf < +x.effective_to));
        if (!r || !t) { unknown.push(code); continue; }
        resolved.push({ code, commentCodeId: r.id, version: Number(t.text_version), ...opt('departmentId', r.department_id), text: t.text });
      }
      return { resolved, unknown } as never;
    },

    /** §7.8. Uncached on purpose: one indexed read (instrument_code_maps__inbound/outbound__p_uq), so an edit or deactivation is visible to the very next request. */
    async mapInstrumentCode(c, input): Promise<InstrumentCodeMapping> {
      const ctx = c as Ctx;
      if (!input || typeof input !== 'object') throw invalid('input');
      const instrumentId = uuid(input.instrumentId, 'instrumentId');
      if (input.direction !== 'inbound' && input.direction !== 'outbound') throw invalid('direction');
      if (input.instrumentCode !== undefined && typeof input.instrumentCode !== 'string') throw invalid('instrumentCode');
      const analyteId = input.analyteId === undefined ? undefined : uuid(input.analyteId, 'analyteId');
      const testId = input.testId === undefined ? undefined : uuid(input.testId, 'testId');
      const unmapped = () => new LimsError('catalog.instrument_code_unmapped');
      const base = 'SELECT id, instrument_id, instrument_code, analyte_id, test_id, unit_from_raw, unit_to_code, unit_factor, flag_map FROM catalog.instrument_code_maps WHERE tenant_id = $1 AND instrument_id = $2 AND is_active = $3 AND direction = ANY($4) AND ';
      let rows: Row[];
      if (input.direction === 'inbound') {
        if (input.instrumentCode === undefined) throw unmapped();
        rows = await q(ctx, `${base}instrument_code = $5 LIMIT 1`, [ctx.tenantId, instrumentId, true, ['inbound', 'both'], input.instrumentCode]);
      } else if (analyteId !== undefined) {
        rows = await q(ctx, `${base}analyte_id = $5 LIMIT 1`, [ctx.tenantId, instrumentId, true, ['outbound', 'both'], analyteId]);
      } else if (testId !== undefined) {
        rows = await q(ctx, `${base}test_id = $5 ORDER BY instrument_code COLLATE "C" ASC LIMIT 1`, [ctx.tenantId, instrumentId, true, ['outbound', 'both'], testId]);
      } else throw unmapped();
      const r = rows[0];
      if (!r) throw unmapped();
      const units = r.unit_from_raw != null && r.unit_to_code != null && r.unit_factor != null;
      return {
        mappingId: r.id, instrumentId: r.instrument_id, instrumentCode: r.instrument_code, analyteId: r.analyte_id, testId: r.test_id,
        ...(units ? { unitConversion: { fromUnitRaw: r.unit_from_raw, toUnitCode: r.unit_to_code, factor: String(r.unit_factor) } } : {}),
        ...(r.flag_map != null ? { flagMap: { ...r.flag_map } } : {}),
      };
    },
  };
}
