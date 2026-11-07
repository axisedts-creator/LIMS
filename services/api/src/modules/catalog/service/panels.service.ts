// Panels + packages #52–#56 and resolveOrderablesPreview #3 (02-TRD §5.2, §7.7; PRD AC-07.1–07.4; 07-SECURITY S-1, S-5, AB-20).
// Validates its own input (import commits call it directly). Every write bumps the catalog revision and publishes catalog.changed.v1
// in the caller's transaction (T-03). Lock order on writes: panels (whole tenant, by id), orderables, panel_members, catalog_state.
// The tenant-wide panels lock serialises every graph change, so the cycle / depth check below always reads committed state of all other writers.
// [CONV] uuidv7 via relative import until @lims/shared-ts is a services/api dependency (same as tests.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { assertCode } from '../domain/codes.js';
import { PANEL_MAX_DEPTH, depthThrough, expandToTestIds, reachablePanels, wouldCreateCycle, type Member, type PanelGraph } from '../domain/panelGraph.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as state from '../repo/catalogState.repo.js';
import * as masters from '../repo/masters.repo.js';
import * as repo from '../repo/tests.repo.js';
import { BOOL, checkFields, checkUpdate, fail, invalid, isObj, mapPg, required, str, unknown, UUID, type Ctx, type Deps, type Tx } from './masters.service.js';
import { createRevisionService } from './revision.service.js';
import { checkQuery, compact, isActiveOf, limitOf, pick } from './tests.service.js';

const ORD_COLS = ['id', 'kind', 'code', 'name', 'department_id', 'sex_restriction', 'is_orderable', 'is_active', 'revision'];
const PANEL_COLS = ['id', 'panel_kind', 'version', 'is_active'];
const MEMBER_COLS = ['panel_id', 'member_orderable_id', 'sort_order'];
const MEMBER_ORDER = 'panel_id, sort_order, member_orderable_id';
const AN_COLS = ['id', 'test_id', 'code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable'];
const AV_COLS = ['id', 'analyte_id', 'version_no', 'status', 'result_type', 'unit_code', 'decimals', 'formula_expression', 'formula_inputs', 'value_set_code'];
const VAL_ORDER = 'sort_order, code';
const MEMBER_KEYS =new Set(['kind', 'orderable_id', 'sort_order']);
const PANEL_KINDS = ['clinical', 'package'];
const SEX = ['male', 'female'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS = { name: str(1, 200), department_id: { t: 'uuid' } as const };
const ptr = (k: string) => `/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const notFound = () => new LimsError('common.not_found');
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);   // code point order == COLLATE "C"

interface Mem { kind: 'test' | 'panel'; id: string; sort_order: number }

/** 1..100 members, strict objects, each orderable once (PanelMember is strict, 02-TRD §5.2 #56). */
function checkMembers(v: unknown): Mem[] {
  const P = '/members';
  if (!Array.isArray(v) || v.length < 1 || v.length > 100) return fail([invalid(P)]);
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  const out = v.map((item, i): Mem => {
    const p = `${P}/${i}`;
    if (!isObj(item)) { errors.push(invalid(p)); return undefined as never; }
    for (const k of Object.keys(item)) if (!MEMBER_KEYS.has(k) && item[k] !== undefined) errors.push(unknown(`${p}${ptr(k)}`));
    const { kind, orderable_id: id, sort_order: so } = item;
    if (kind === undefined) errors.push(required(`${p}/kind`));
    else if (kind !== 'test' && kind !== 'panel') errors.push(invalid(`${p}/kind`));
    if (id === undefined) errors.push(required(`${p}/orderable_id`));
    else if (!isUuid(id) || seen.has(id)) errors.push(invalid(`${p}/orderable_id`));
    else seen.add(id);
    if (so === undefined) errors.push(required(`${p}/sort_order`));
    else if (!(Number.isInteger(so) && (so as number) >= 0 && (so as number) <= 9999)) errors.push(invalid(`${p}/sort_order`));
    return { kind: kind as Mem['kind'], id: id as string, sort_order: so as number };
  });
  if (errors.length) fail(errors);
  return out;
}

/** Locks every panel row of the tenant (ordered, so two writers cannot deadlock) and returns them. */
const lockPanels = (tx: Tx, t: string) => repo.find(tx, 'panels', PANEL_COLS, t, {}, { lock: true, order: 'id' });

/** The tenant's panel graph in one statement (a consistent snapshot). ponytail: whole-tenant load, ASSUMPTION <= 5 000 orderables (02-TRD §12); a recursive CTE if catalogs grow. */
async function loadGraph(tx: Tx, t: string, panelIds: ReadonlySet<string>): Promise<Map<string, Member[]>> {
  const graph = new Map<string, Member[]>();
  for (const r of await repo.find(tx, 'panel_members', MEMBER_COLS, t, {}, { order: MEMBER_ORDER })) {
    const m: Member = { kind: panelIds.has(r.member_orderable_id) ? 'panel' : 'test', id: r.member_orderable_id };
    const list = graph.get(r.panel_id);
    if (list) list.push(m); else graph.set(r.panel_id, [m]);
  }
  return graph;
}

/** Members must exist in this tenant (404, B's ids look unknown), have the declared kind (400) and be active (409). Only the NEW members are checked. */
async function checkRefs(tx: Tx, t: string, members: readonly Mem[]): Promise<void> {
  const rows = await repo.find(tx, 'orderables', ['id', 'kind', 'is_active'], t, {}, { ids: members.map((m) => m.id) });
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (members.some((m) => !byId.has(m.id))) throw notFound();
  const wrong = members.flatMap((m, i) => (byId.get(m.id).kind === m.kind ? [] : [invalid(`/members/${i}/kind`)]));
  if (wrong.length) fail(wrong);
  if (members.some((m) => byId.get(m.id).is_active !== true)) throw new LimsError('catalog.test_inactive');
}

/** Cycle first (422), then depth (400 /members), TRD §7.7. */
function checkGraph(graph: PanelGraph, panelId: string, members: readonly Mem[]): void {
  const ms = members.map((m): Member => ({ kind: m.kind, id: m.id }));
  if (wouldCreateCycle(graph, panelId, ms)) throw new LimsError('catalog.panel_cycle');
  // +1 = the leaf test level: every panel has >= 1 member, so a chain of n panels ends in tests at level n + 1 (02-TRD §11).
  if (depthThrough(graph, panelId, ms) + 1 > PANEL_MAX_DEPTH) fail([invalid('/members')]);
}

const enumErr = (v: unknown, allowed: readonly string[], path: string, errors: FieldError[]) => {
  if (v !== undefined && !(typeof v === 'string' && allowed.includes(v))) errors.push(invalid(path));
};

export function createPanelsService(deps: Deps) {
  const revision = createRevisionService(deps);
  const nowIso = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, id: string, changeKind: string) =>
    revision.bumpRevision(ctx, { entityType: 'panel', entityId: id, changeKind, effectiveFrom: nowIso(ctx) });

  /** Panel DTOs for `ids` (given order). 5 statements regardless of how many panels. */
  async function dtos(ctx: Ctx, ids: readonly string[]): Promise<any[]> {
    if (!ids.length) return [];
    const tx = ctx.tx as Tx, t = ctx.tenantId;
    const ords = await repo.find(tx, 'orderables', ORD_COLS, t, { kind: 'panel' }, { ids });
    const pans = await repo.find(tx, 'panels', PANEL_COLS, t, {}, { ids });
    const mems = await repo.find(tx, 'panel_members', MEMBER_COLS, t, {}, { anyOf: { col: 'panel_id', values: ids }, order: MEMBER_ORDER });
    const kinds = mems.length ? await repo.find(tx, 'orderables', ['id', 'kind'], t, {}, { ids: [...new Set<string>(mems.map((m) => m.member_orderable_id))] }) : [];
    const deptIds = [...new Set<string>(ords.map((o) => o.department_id).filter((x): x is string => typeof x === 'string'))];
    const depts = deptIds.length ? await repo.find(tx, 'departments', ['id', 'code'], t, {}, { ids: deptIds }) : [];
    const oBy = new Map(ords.map((o) => [o.id, o])), pBy = new Map(pans.map((p) => [p.id, p])), kBy = new Map(kinds.map((k) => [k.id, k.kind]));
    const dBy = new Map(depts.map((d) => [d.id, d.code]));
    return ids.flatMap((id) => {
      const o = oBy.get(id), p = pBy.get(id);
      if (!o || !p) return [];
      return [compact({
        id, kind: 'panel', code: o.code, name: o.name, department_id: o.department_id, department_code: o.department_id ? dBy.get(o.department_id) : undefined,
        panel_kind: p.panel_kind, sex_restriction: o.sex_restriction, is_orderable: o.is_orderable === true, is_active: p.is_active === true, revision: Number(o.revision),
        members: mems.filter((m) => m.panel_id === id && kBy.has(m.member_orderable_id))
          .map((m) => ({ kind: kBy.get(m.member_orderable_id), orderable_id: m.member_orderable_id, sort_order: Number(m.sort_order) })),
        version: Number(p.version),
      })];
    });
  }
  const one = async (ctx: Ctx, id: string) => {
    const [dto] = await dtos(ctx, [id]);
    if (!dto) throw new LimsError('common.internal');
    return dto;
  };

  const insertMembers = (tx: Tx, t: string, actor: string, panelId: string, members: readonly Mem[]) =>
    repo.insert(tx, 'panel_members', members.map((m) => ({ tenant_id: t, panel_id: panelId, member_orderable_id: m.id, sort_order: m.sort_order, created_by: actor })), ['created_at']).catch(mapPg);

  return {
    /** #52 — keyset on (code, id); the driving table is orderables (kind panel). */
    async listPanels(ctx: Ctx, query: unknown) {
      const q = checkQuery(query, ['panel_kind', 'is_active', 'cursor', 'limit']);
      const errors: FieldError[] = [];
      enumErr(q['panel_kind'], PANEL_KINDS, '/panel_kind', errors);
      const isActive = isActiveOf(q['is_active'], errors);
      const limit = limitOf(q['limit'], 50, 200, errors);
      if (errors.length) fail(errors);
      const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'code');
      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const ids = q['panel_kind'] ? (await repo.find(tx, 'panels', ['id'], t, { panel_kind: q['panel_kind'] })).map((r) => r.id) : undefined;
      const rows = await repo.find(tx, 'orderables', ['id', 'code'], t, { kind: 'panel', ...(isActive === undefined ? {} : { is_active: isActive }) },
        { order: 'code ASC, id ASC', limit: limit + 1, ...(ids ? { ids } : {}), ...(after ? { after: { col: 'code', desc: false, value: after[0], id: after[1] } } : {}) });
      const last = rows[limit - 1];
      return {
        data: await dtos(ctx, rows.slice(0, limit).map((r) => r.id)),
        page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor('code', last.code, last.id) } : {}) },
      };
    },

    /** #53 */
    async createPanel(ctx: Ctx, body: unknown) {
      const b = checkFields({ fields: FIELDS }, body, ['code', 'panel_kind', 'sex_restriction', 'members']);
      const errors: FieldError[] = [];
      let code: string | undefined;
      if (b['code'] !== undefined) { try { code = assertCode('orderable', b['code']); } catch { errors.push(invalid('/code')); } }
      for (const r of ['code', 'name', 'panel_kind', 'members']) if (b[r] === undefined) errors.push(required(`/${r}`));
      enumErr(b['panel_kind'], PANEL_KINDS, '/panel_kind', errors);
      enumErr(b['sex_restriction'], SEX, '/sex_restriction', errors);
      if (errors.length) fail(errors);
      const members = checkMembers(b['members']);

      const tx = ctx.tx as Tx, t = ctx.tenantId, actor = ctx.actor.id, id = uuidv7();
      const who = { tenant_id: t, created_by: actor, updated_by: actor };
      const panels = await lockPanels(tx, t);
      await checkRefs(tx, t, members);
      checkGraph(await loadGraph(tx, t, new Set(panels.map((p) => p.id))), id, members);
      await repo.insert(tx, 'orderables', [{ id, ...who, kind: 'panel', code, name: b['name'], department_id: b['department_id'] ?? null,
        sex_restriction: b['sex_restriction'] ?? null, is_orderable: true, is_active: true, revision: 0, version: 1 }], ['created_at', 'updated_at']).catch(mapPg);
      await repo.insert(tx, 'panels', [{ id, ...who, kind: 'panel', panel_kind: b['panel_kind'], is_active: true, version: 1 }], ['created_at', 'updated_at']).catch(mapPg);
      await insertMembers(tx, t, actor, id, members);
      await bump(ctx, id, 'created');
      return one(ctx, id);
    },

    /** #54 */
    async getPanelDetail(ctx: Ctx, input: { id?: unknown } = {}) {
      if (!isUuid(input.id)) fail([invalid('/id')]);
      const [dto] = await dtos(ctx, [input.id as string]);
      if (!dto) throw notFound();
      return dto;
    },

    /** #55 — If-Match; code, panel_kind and members are not patchable (members: #56). */
    async updatePanel(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const patch = checkFields({ fields: { ...FIELDS, is_active: BOOL } }, input.patch, ['sex_restriction', 'unset']);
      const errors: FieldError[] = [];
      enumErr(patch['sex_restriction'], SEX, '/sex_restriction', errors);
      const unset = patch['unset'];
      if (unset !== undefined) {
        const ok = Array.isArray(unset) && unset.length <= 2 && new Set(unset).size === unset.length && unset.every((u) => u === 'sex_restriction' || u === 'department_id');
        if (!ok) errors.push(invalid('/unset'));
        else for (const u of unset as string[]) if (patch[u] !== undefined) errors.push(invalid(`/${u}`));
      }
      if (errors.length) fail(errors);

      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const [before] = await repo.find(tx, 'panels', PANEL_COLS, t, { id }, { lock: true });
      if (!before) throw notFound();
      if (Number(before.version) !== ev) throw new LimsError('common.version_conflict');
      const [ord] = await repo.find(tx, 'orderables', ['id'], t, { id, kind: 'panel' }, { lock: true });
      if (!ord) throw notFound();
      const nulls = Object.fromEntries(((unset as string[] | undefined) ?? []).map((u) => [u, null]));
      const k = { tenantId: t, id, actorId: ctx.actor.id };
      await repo.update(tx, 'orderables', ['id'], k, { ...pick(patch, ['name', 'department_id', 'sex_restriction', 'is_active']), ...nulls }).catch(mapPg);
      const after = await repo.update(tx, 'panels', PANEL_COLS, { ...k, expectedVersion: ev }, pick(patch, ['is_active']));
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, before.is_active === true && after.is_active === false ? 'deactivated' : 'updated');
      return one(ctx, id);
    },

    /** #56 — replace = DELETE then INSERT; bumps panels.version. */
    async replacePanelMembers(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = checkQuery(isObj(input.body) ? input.body : fail([invalid('')]), ['members']);
      if (b['members'] === undefined) fail([required('/members')]);
      const members = checkMembers(b['members']);

      const tx = ctx.tx as Tx, t = ctx.tenantId, actor = ctx.actor.id;
      const panels = await lockPanels(tx, t);
      const me = panels.find((p) => p.id === id);
      if (!me) throw notFound();
      if (Number(me.version) !== ev) throw new LimsError('common.version_conflict');
      await checkRefs(tx, t, members);
      checkGraph(await loadGraph(tx, t, new Set(panels.map((p) => p.id))), id, members);
      const after = await repo.update(tx, 'panels', ['id'], { tenantId: t, id, actorId: actor, expectedVersion: ev }, {});
      if (!after) throw new LimsError('common.version_conflict');
      await repo.deleteMembers(tx, t, id);
      await insertMembers(tx, t, actor, id, members);
      await bump(ctx, id, 'updated');
      return one(ctx, id);
    },

    /** #3 — read-only; one statement per table, never per test or panel. */
    async resolveOrderablesPreview(ctx: Ctx, body: unknown) {
      const b = checkQuery(body, ['orderable_ids', 'as_of']);
      const errors: FieldError[] = [];
      const raw = b['orderable_ids'];
      if (raw === undefined) errors.push(required('/orderable_ids'));
      else if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) errors.push(invalid('/orderable_ids'));
      else raw.forEach((x, i) => { if (!isUuid(x)) errors.push(invalid(`/orderable_ids/${i}`)); });
      const asOfRaw = b['as_of'] === undefined ? nowIso(ctx) : b['as_of'];
      if (typeof asOfRaw !== 'string' || !ISO_UTC.test(asOfRaw) || Number.isNaN(Date.parse(asOfRaw))) errors.push(invalid('/as_of'));
      if (errors.length) fail(errors);

      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const asOf = new Date(asOfRaw as string);
      const ids = [...new Set(raw as string[])];
      const roots = await repo.find(tx, 'orderables', ['id', 'kind', 'is_active'], t, {}, { ids });
      if (roots.length !== ids.length) throw notFound();
      const kindOf = new Map(roots.map((r) => [r.id, r.kind as 'test' | 'panel']));
      if (roots.some((r) => r.is_active !== true)) throw new LimsError('catalog.test_inactive');

      const panelRoots = ids.filter((id) => kindOf.get(id) === 'panel');
      let graph: PanelGraph = new Map();
      let panelActive = new Map<string, boolean>();
      if (panelRoots.length) {
        const panels = await repo.find(tx, 'panels', ['id', 'is_active'], t, {});
        panelActive = new Map(panels.map((p) => [p.id, p.is_active === true]));
        graph = await loadGraph(tx, t, new Set(panelActive.keys()));
      }
      const perRoot = ids.map((id) => ({ orderable_id: id, kind: kindOf.get(id)!, test_ids: expandToTestIds(graph, { kind: kindOf.get(id)!, id }) }));   // cycle -> 422
      for (const p of reachablePanels(graph, panelRoots)) if (panelActive.get(p) === false) throw new LimsError('catalog.test_inactive');
      const testIds = [...new Set(perRoot.flatMap((r) => r.test_ids))];

      const tests = testIds.length ? await repo.find(tx, 'tests', ['id', 'workflow_type', 'uses_existing_material', 'is_active'], t, {}, { ids: testIds }) : [];
      const ords = testIds.length ? await repo.find(tx, 'orderables', ORD_COLS, t, { kind: 'test' }, { ids: testIds }) : [];
      if (tests.length !== testIds.length || ords.length !== testIds.length) throw notFound();
      if (tests.some((r) => r.is_active !== true) || ords.some((r) => r.is_active !== true)) throw new LimsError('catalog.test_inactive');
      const tBy = new Map(tests.map((r) => [r.id, r])), oBy = new Map(ords.map((o) => [o.id, o]));

      const find = (table: repo.Table, ids2: readonly string[]) => (ids2.length ? repo.find(tx, table, ['id', 'code'], t, {}, { ids: ids2 }) : Promise.resolve([] as any[]));
      const reqs = testIds.length ? await repo.find(tx, 'test_specimen_types', ['test_id', 'specimen_type_id', 'container_id', 'is_preferred'], t, {}, { anyOf: { col: 'test_id', values: testIds } }) : [];
      const uniq = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string'))];
      const code = (rows: any[]) => new Map(rows.map((r) => [r.id, r.code as string]));
      const dept = code(await find('departments', uniq(ords.map((o) => o.department_id))));
      const spec = code(await find('specimen_types', uniq(reqs.map((r) => r.specimen_type_id))));
      const cont = code(await find('containers', uniq(reqs.map((r) => r.container_id))));

      const analytes = testIds.length ? await repo.find(tx, 'analytes', AN_COLS, t, {}, { anyOf: { col: 'test_id', values: testIds }, order: 'sort_order, code' }) : [];
      const versions = analytes.length ? (await repo.analyteVersions(tx, AV_COLS, t, analytes.map((a) => a.id), asOf)).filter((v) => v.status !== 'draft') : [];
      const current = new Map<string, any>();
      for (const v of versions) if (!current.has(v.analyte_id) || Number(v.version_no) > Number(current.get(v.analyte_id).version_no)) current.set(v.analyte_id, v);

      // ordinalSetValues (03-IC §4.2, 08 D-9): active values by sort_order; a tenant set shadows the global set of the same code. One statement per table.
      const setCodes = uniq([...current.values()].map((v) => v.value_set_code));
      const tSets = setCodes.length ? await masters.selectRows(tx, 'cs_value_sets', ['id', 'code'], { tenant_id: t, code: setCodes }, 'code') : [];
      const tSetCode = new Map(tSets.map((s) => [s.id, s.code as string]));
      const gCodes = setCodes.filter((c) => !tSets.some((s) => s.code === c));
      const vals = [
        ...(tSets.length ? (await masters.selectRows(tx, 'cs_value_set_values', ['value_set_id', 'code', 'display', 'sort_order'], { tenant_id: t, value_set_id: [...tSetCode.keys()], is_active: true }, VAL_ORDER))
          .map((r) => ({ ...r, value_set_code: tSetCode.get(r.value_set_id) })) : []),
        ...(gCodes.length ? await masters.selectRows(tx, 'g_value_set_values', ['value_set_code', 'code', 'display', 'sort_order'], { value_set_code: gCodes, is_active: true }, VAL_ORDER) : []),
      ];
      const valuesOf = (setCode: string) => vals.filter((r) => r.value_set_code === setCode)
        .map((r) => ({ code: r.code, display: r.display, sort_order: Number(r.sort_order) })).sort((a, b) => a.sort_order - b.sort_order || byCode(a.code, b.code));

      const groups = new Map<string, { specimen_type_code: string; container_code?: string; test_ids: string[] }>();
      const definitions = testIds.map((id) => {
        const o = oBy.get(id);
        const mine = reqs.filter((r) => r.test_id === id);
        const preferred = mine.find((r) => r.is_preferred === true);
        const containerCode = preferred?.container_id ? cont.get(preferred.container_id) : undefined;
        if (preferred) {
          const typeCode = spec.get(preferred.specimen_type_id)!;
          const key = `${typeCode}\u0000${containerCode ?? ''}`;
          const g = groups.get(key);
          if (g) g.test_ids.push(id); else groups.set(key, compact({ specimen_type_code: typeCode, container_code: containerCode, test_ids: [id] }) as never);
        }
        return compact({
          id, code: o.code, name: o.name, department_id: o.department_id, department_code: dept.get(o.department_id),
          specimen_type_codes: mine.map((r) => spec.get(r.specimen_type_id)!).sort(byCode), container_code: containerCode,
          workflow_type: tBy.get(id).workflow_type, uses_existing_material: tBy.get(id).uses_existing_material === true, is_active: true, revision: Number(o.revision),
          analytes: analytes.filter((a) => a.test_id === id && current.has(a.id)).map((a) => {
            const v = current.get(a.id);
            return compact({
              id: a.id, code: a.code, name: a.name, result_type: v.result_type, unit_code: v.unit_code, decimals: v.decimals == null ? undefined : Number(v.decimals),
              formula: v.formula_expression ? { expression: v.formula_expression, input_analyte_codes: v.formula_inputs ?? [] } : undefined,
              ordinal_set_code: v.value_set_code ?? undefined, ordinal_set_values: v.value_set_code ? valuesOf(v.value_set_code) : undefined, reportable: a.is_reportable === true, sort_order: Number(a.sort_order), report_subheading: a.report_subheading, print_name: a.print_name,
            });
          }),
        });
      });
      return {
        orderables: perRoot,
        tests: definitions,
        specimen_requirements: [...groups.values()].sort((a, b) => byCode(a.specimen_type_code, b.specimen_type_code) || byCode(a.container_code ?? '', b.container_code ?? '')),
        catalog_revision: await state.currentRevision(tx, t),
      };
    },
  };
}
