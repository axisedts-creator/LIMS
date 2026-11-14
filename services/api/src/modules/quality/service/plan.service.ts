// C9 T-07 QC plans + versions service #14-#19 (02-TRD §5.3; AC-03.1-03.6; 07-SECURITY S-01/S-03/S-04/S-06/S-07).
// Order of every operation: assertRole -> validate -> (If-Match present? 428) -> load through the tenant-scoped repo (404 when invisible) -> version check (409)
// -> state/guard -> write. Tenant, actor and ids come from ctx / the service, never from a body. Errors throw LimsError; the core rolls the request tx back.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, isLimsError } from '../../../core/errors.js';
import { planDto, planVersionDto, type AnalyteDef } from '../mappers/plan.mapper.js';
import { createPlanRepo, type PlanRepo } from '../repository/plan.repo.js';
import type { Row } from '../repository/setup.repo.js';
import type { Result, SetupCtx as PlanCtx } from './setup.service.js';
import { Errs, isObj, isUuid, paging, qUuid } from './setup.validate.js';

const READ = 'quality.qc_run.read', MANAGE = 'quality.qc.manage';
const REPROCESS_TASK = 'quality.reprocess_pending_observations';
const MEAN_RULES: Record<number, readonly string[]> = { 2: ['8x', '10x', '12x'], 3: ['6x', '9x'], 4: ['8x', '10x', '12x'] };
const DEFAULT_MEAN: Record<number, string> = { 2: '10x', 3: '6x', 4: '10x' };
const ANY_MEAN = ['6x', '8x', '9x', '10x', '12x'];
const PARAM_KEYS = ['controls_per_run', 'composition', 'mean_rule', 'two_two_s_across_runs', 'count_rules_across_materials', 'exclude_rejected_runs_from_history',
  'run_window_minutes', 'qc_validity_hours', 'hold_lookback_hours'];
// [CONV] defaults of 02-TRD §5.3 QcPlanParams.
const BOOLS = ['two_two_s_across_runs', 'count_rules_across_materials', 'exclude_rejected_runs_from_history'];
const INTS: Array<[string, number, number, number]> = [['run_window_minutes', 5, 240, 30], ['qc_validity_hours', 1, 168, 24], ['hold_lookback_hours', 1, 168, 24]];

type Obj = Record<string, any>;
interface Params { controls_per_run: number; composition: Array<{ level_id: string; count: number }>; [k: string]: unknown }

const assert = (ctx: PlanCtx, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
function needVersion(v: number | undefined): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  return v;
}

/** Top-level body shape: records unknown keys; root errors at '/'. */
export function shape(e: Errs, body: unknown, allowed: readonly string[]): Obj | undefined {
  if (!isObj(body)) { e.add('/'); return undefined; }
  for (const k of Object.keys(body)) if (!allowed.includes(k)) e.add(`/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, 'common.unknown_field');
  return body;
}
export const reqUuid = (e: Errs, o: Obj, k: string, at = ''): string | undefined => {
  if (o[k] === undefined) { e.add(`${at}/${k}`, 'common.field_required'); return undefined; }
  if (!isUuid(o[k])) { e.add(`${at}/${k}`); return undefined; }
  return o[k];
};
export const reason = (e: Errs, o: Obj, k: string): string | undefined => {
  const v = o[k];
  if (v === undefined) { e.add(`/${k}`, 'common.field_required'); return undefined; }
  if (typeof v !== 'string' || [...v].length < 1 || [...v].length > 500) { e.add(`/${k}`); return undefined; }
  return v;
};

/** QcPlanParams (02-TRD §5.3), every violation reported under /params. Defaults filled in. */
function params(e: Errs, v: unknown): Params | undefined {
  const at = '/params';
  if (v === undefined) { e.add(at, 'common.field_required'); return undefined; }
  if (!isObj(v)) { e.add(at); return undefined; }
  for (const k of Object.keys(v)) if (!PARAM_KEYS.includes(k)) e.add(`${at}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, 'common.unknown_field');
  let ok = true;
  const bad = (path: string, code: Parameters<Errs['add']>[1] = 'common.field_invalid') => { e.add(path, code); ok = false; };

  const n = v['controls_per_run'];
  const nOk = Number.isInteger(n) && [2, 3, 4].includes(n);
  if (n === undefined) bad(`${at}/controls_per_run`, 'common.field_required'); else if (!nOk) bad(`${at}/controls_per_run`);

  const composition: Params['composition'] = [];
  const c = v['composition'];
  if (c === undefined) bad(`${at}/composition`, 'common.field_required');
  else if (!Array.isArray(c) || c.length < 1 || c.length > 4) bad(`${at}/composition`);
  else {
    let itemsOk = true; const seen = new Set<string>();
    c.forEach((it, i) => {
      const p = `${at}/composition/${i}`;
      if (!isObj(it)) { bad(p); itemsOk = false; return; }
      for (const k of Object.keys(it)) if (k !== 'level_id' && k !== 'count') { bad(`${p}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, 'common.unknown_field'); itemsOk = false; }
      const lv = it['level_id'], cnt = it['count'];
      if (lv === undefined) { bad(`${p}/level_id`, 'common.field_required'); itemsOk = false; }
      else if (!isUuid(lv)) { bad(`${p}/level_id`); itemsOk = false; }
      else if (seen.has(lv.toLowerCase())) { bad(`${p}/level_id`); itemsOk = false; }   // one entry per level
      else seen.add(lv.toLowerCase());
      if (cnt === undefined) { bad(`${p}/count`, 'common.field_required'); itemsOk = false; }
      else if (!Number.isInteger(cnt) || cnt < 1 || cnt > 4) { bad(`${p}/count`); itemsOk = false; }
      if (itemsOk) composition.push({ level_id: lv, count: cnt });
    });
    if (itemsOk && nOk && composition.reduce((s, x) => s + x.count, 0) !== n) bad(`${at}/composition`);   // sum(count) = N (05-SCHEMA: service-validated)
  }

  const m = v['mean_rule'];
  if (m !== undefined && (typeof m !== 'string' || !(nOk ? MEAN_RULES[n]! : ANY_MEAN).includes(m))) bad(`${at}/mean_rule`);
  const out: Params = { controls_per_run: n, composition, mean_rule: m ?? (nOk ? DEFAULT_MEAN[n] : undefined) };
  for (const k of BOOLS) {
    if (v[k] === undefined) out[k] = true;
    else if (typeof v[k] !== 'boolean') bad(`${at}/${k}`);
    else out[k] = v[k];
  }
  for (const [k, lo, hi, d] of INTS) {
    if (v[k] === undefined) out[k] = d;
    else if (!Number.isInteger(v[k]) || v[k] < lo || v[k] > hi) bad(`${at}/${k}`);
    else out[k] = v[k];
  }
  return ok ? out : undefined;
}

export function createPlanService(deps: { repo?: PlanRepo } = {}) {
  const repo = deps.repo ?? createPlanRepo();

  /** Composition levels must be this tenant's levels (unknown and foreign ids look the same, S-04 / AB-11). */
  async function checkLevels(ctx: PlanCtx, e: Errs, p: Params): Promise<void> {
    const found = new Set((await repo.findLevels(ctx.tx, ctx.tenantId, p.composition.map((x) => x.level_id))).map((l) => String(l['id']).toLowerCase()));
    p.composition.forEach((x, i) => { if (!found.has(x.level_id.toLowerCase())) e.add(`/params/composition/${i}/level_id`); });
  }

  /** One getTest per distinct test_id. `common.not_found` = unknown test; any other failure propagates (fail closed, nothing written). */
  async function catalogFor(ctx: PlanCtx, testIds: string[]): Promise<Map<string, Row | undefined>> {
    const out = new Map<string, Row | undefined>();
    await Promise.all([...new Set(testIds)].map(async (testId) => {
      try { out.set(testId, await ctx.ports.CatalogPort.getTest(ctx, { testId })); }
      catch (err) { if (isLimsError(err, 'common.not_found')) out.set(testId, undefined); else throw err; }
    }));
    return out;
  }
  const analyteOf = (test: Row | undefined, analyteId: string): AnalyteDef | undefined =>
    (test?.['analytes'] as Row[] | undefined)?.find((a) => a['id'] === analyteId) as AnalyteDef | undefined;

  /** DTOs for plans with their current version rows; catalog + instrument labels read once per page. */
  async function dtos(ctx: PlanCtx, plans: Row[], current?: Row[]): Promise<Row[]> {
    if (!plans.length) return [];
    const ids = plans.map((p) => p['id']);
    const [cur, catalog, labels] = await Promise.all([
      current ?? repo.listCurrentVersions(ctx.tx, ctx.tenantId, ids),
      catalogFor(ctx, plans.map((p) => p['test_id'])),
      repo.listInstrumentLabels(ctx.tx, ctx.tenantId, [...new Set(plans.map((p) => p['instrument_id'] as string))]),
    ]);
    return plans.map((p) => planDto(p, cur.find((v) => v['plan_id'] === p['id'] && v['version_no'] === p['current_version_no']),
      analyteOf(catalog.get(p['test_id']), p['analyte_id']), labels.find((l) => l.instrument_id === p['instrument_id'])));
  }
  const one = async (ctx: PlanCtx, plan: Row, current?: Row[]): Promise<Row> => (await dtos(ctx, [plan], current))[0]!;

  async function load(ctx: PlanCtx, planId: unknown, expected: number): Promise<Row> {
    const cur = isUuid(planId) ? await repo.findPlan(ctx.tx, ctx.tenantId, planId) : undefined;
    if (!cur) throw notFound();
    if (cur['version'] !== expected) throw conflict();
    return cur;
  }
  async function update(ctx: PlanCtx, plan: Row, patch: Row): Promise<Row> {
    const row = await repo.updatePlan(ctx.tx, ctx.tenantId, plan['id'], plan['version'], { ...patch, updated_by: ctx.actor.id });
    if (!row) throw conflict();   // a concurrent writer won between the read and the write
    return row;
  }
  const versionRow = (ctx: PlanCtx, planId: string, versionNo: number, p: Params, changeReason: string | null): Row =>
    ({ id: uuidv7(), plan_id: planId, version_no: versionNo, ...p, change_reason: changeReason, effective_from: ctx.now(), created_by: ctx.actor.id, updated_by: ctx.actor.id });

  return {
    async listQcPlans(ctx: PlanCtx, q: Obj = {}): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs(), pg = paging(e, q);
      const instrumentId = qUuid(e, q, 'instrumentId', 'instrument_id'), analyteId = qUuid(e, q, 'analyteId', 'analyte_id');
      const status = q['status'];
      if (status !== undefined && status !== 'active' && status !== 'inactive') e.add('/status');
      e.done();
      const page = await repo.listPlans(ctx.tx, ctx.tenantId, {
        ...(instrumentId !== undefined ? { instrumentId } : {}), ...(analyteId !== undefined ? { analyteId } : {}), ...(status !== undefined ? { status } : {}), ...pg,
      });
      return { status: 200, body: { data: await dtos(ctx, page.rows), page: { limit: pg.limit, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } } };
    },

    async createQcPlan(ctx: PlanCtx, i: { body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(), o = shape(e, i.body, ['instrument_id', 'test_id', 'analyte_id', 'params']);
      if (!o) return e.done() as never;
      const instrumentId = reqUuid(e, o, 'instrument_id'), testId = reqUuid(e, o, 'test_id'), analyteId = reqUuid(e, o, 'analyte_id');
      const p = params(e, o['params']);
      e.done();
      // catalog: unknown test -> /test_id; analyte must be a numeric analyte of the test -> else /analyte_id
      const test = (await catalogFor(ctx, [testId!])).get(testId!);
      if (!test) e.add('/test_id');
      else if (analyteOf(test, analyteId!)?.resultType !== 'numeric') e.add('/analyte_id');
      await checkLevels(ctx, e, p!);
      e.done();
      // AC: instrument_code_unmapped is a warning, not an error; any other failure fails closed before any write.
      let warnings: string[] = [];
      try { await ctx.ports.CatalogPort.mapInstrumentCode(ctx, { instrumentId, direction: 'outbound', testId, analyteId }); }
      catch (err) { if (isLimsError(err, 'catalog.instrument_code_unmapped')) warnings = ['instrument_code_unmapped']; else throw err; }

      const by = { created_by: ctx.actor.id, updated_by: ctx.actor.id };
      let plan: Row;
      try { plan = await repo.insertPlan(ctx.tx, ctx.tenantId, { id: uuidv7(), instrument_id: instrumentId, test_id: testId, analyte_id: analyteId, ...by }); }
      catch (err: any) {
        if (err?.code === '23505') throw new LimsError('quality.code_duplicate');   // AC-03.5: one plan per instrument x analyte
        if (err?.code === '23503') { e.add(/instrument/.test(String(err.constraint)) ? '/instrument_id' : /analyte/.test(String(err.constraint)) ? '/analyte_id' : '/test_id'); e.done(); }
        throw err;
      }
      const ver = await repo.insertVersion(ctx.tx, ctx.tenantId, versionRow(ctx, plan['id'], 1, p!, null));
      return { status: 201, version: plan['version'], body: { ...(await one(ctx, plan, [ver])), warnings } };
    },

    async getQcPlan(ctx: PlanCtx, i: { planId: unknown }): Promise<Result> {
      await assert(ctx, READ);
      const plan = isUuid(i.planId) ? await repo.findPlan(ctx.tx, ctx.tenantId, i.planId) : undefined;
      if (!plan) throw notFound();
      const versions = await repo.listVersions(ctx.tx, ctx.tenantId, plan['id']);
      const ids = [...new Set(versions.map((v) => v['created_by']).filter((x): x is string => typeof x === 'string'))];
      const labels = new Map((ids.length ? await repo.listUserLabels(ctx.tx, ctx.tenantId, ids) : []).map((l) => [l.user_id, l.display_name]));
      return { status: 200, version: plan['version'], body: { ...(await one(ctx, plan, versions)), versions: versions.map((v) => planVersionDto(v, labels)) } };
    },

    /** AC-03.6: a new version is appended; earlier versions are never touched (runs keep theirs). */
    async createQcPlanVersion(ctx: PlanCtx, i: { planId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(), o = shape(e, i.body, ['params', 'change_reason']);
      if (!o) return e.done() as never;
      const p = params(e, o['params']), why = reason(e, o, 'change_reason');
      e.done();
      await checkLevels(ctx, e, p!);
      e.done();
      const plan = await load(ctx, i.planId, needVersion(i.expectedVersion));
      const next = plan['current_version_no'] + 1;
      const row = await update(ctx, plan, { current_version_no: next });   // plan first: a lost update leaves no orphan version
      let ver: Row;
      try { ver = await repo.insertVersion(ctx.tx, ctx.tenantId, versionRow(ctx, plan['id'], next, p!, why!)); }
      catch (err: any) { throw err?.code === '23505' ? conflict() : err; }
      return { status: 200, version: row['version'], body: await one(ctx, row, [ver]) };
    },

    /** #18: guard = every level of the CURRENT version's composition has an active target on an active lot (422 quality.qc_target_missing). */
    async activateQcPlan(ctx: PlanCtx, i: { planId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(); shape(e, i.body ?? {}, []); e.done();
      const plan = await load(ctx, i.planId, needVersion(i.expectedVersion));
      const current = await repo.listCurrentVersions(ctx.tx, ctx.tenantId, [plan['id']]);
      const levelIds = [...new Set(((current[0]?.['composition'] ?? []) as Row[]).map((c) => String(c['level_id'])))];
      const covered = new Set(levelIds.length ? await repo.coveredLevelIds(ctx.tx, ctx.tenantId, plan['id'], levelIds) : []);
      if (!levelIds.length || levelIds.some((l) => !covered.has(l))) throw new LimsError('quality.qc_target_missing');
      const row = await update(ctx, plan, { status: 'active' });
      // 02-TRD §6.4: history adoption after activation; same transaction, a queue failure fails the request.
      await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [REPROCESS_TASK, JSON.stringify({ tenant_id: ctx.tenantId, plan_id: plan['id'] }), `reproc:${plan['id']}`]);
      return { status: 200, version: row['version'], body: await one(ctx, row, current) };
    },

    /** #19: the reason is validated; the audit trail (C0 trigger) records the change. Collecting runs are finalised by the run engine (later task). */
    async deactivateQcPlan(ctx: PlanCtx, i: { planId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(), o = shape(e, i.body, ['reason']);
      if (o) reason(e, o, 'reason');
      e.done();
      const plan = await load(ctx, i.planId, needVersion(i.expectedVersion));
      const row = await update(ctx, plan, { status: 'inactive' });
      return { status: 200, version: row['version'], body: await one(ctx, row) };
    },
  };
}
