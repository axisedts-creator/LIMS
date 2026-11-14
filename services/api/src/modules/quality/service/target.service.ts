// C9 T-08 QC targets + establish-from-data service #20-#25 (02-TRD §5.3 / §7.6; 03-APP-FLOW §2.5; AC-04.1-04.6; 07-SECURITY S-01/S-03/S-07/S-09/AB-01).
// Order of every operation: assertRole -> validate -> (If-Match present? 428) -> load through the tenant-scoped repo (404 when invisible) -> version check (409)
// -> state check (409 common.immutable_record) -> write. Tenant, actor and ids come from ctx / the service, never from a body.
// A target's mean/SD is never edited: there is no update operation, bodies of #23-#25 carry no mean/sd, and the repo only SETs lifecycle columns (trigger qc_targets__mutable_columns).
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { parseDecimal, roundDp, toDecimalString, type Decimal } from '../../../../../../packages/shared-ts/src/decimal/index.js';
import { LimsError, isLimsError } from '../../../core/errors.js';
import { targetStats, storedTarget } from '../domain/target-stats.js';
import { targetDto, targetUserIds } from '../mappers/target.mapper.js';
import type { Row } from '../repository/setup.repo.js';
import { createTargetRepo, type TargetRepo } from '../repository/target.repo.js';
import { reason, reqUuid, shape } from './plan.service.js';
import type { Result, SetupCtx as Ctx } from './setup.service.js';
import { tenantToday } from './setup.service.js';
import { Errs, isUuid, paging, qUuid } from './setup.validate.js';

const READ = 'quality.qc_run.read', MANAGE = 'quality.qc.manage';
const REPROCESS_TASK = 'quality.reprocess_pending_observations';
const STATUSES = ['draft', 'active', 'superseded', 'retired', 'discarded'];
const DEFAULT_MIN_POINTS = 20;   // [CONV] 02-TRD §12.1 target_min_points default; the tenant setting wins
const MAX_IDS = 500;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;   // _common.yaml IsoUtc
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;                                       // _common.yaml Code

type Obj = Record<string, any>;
const assert = (ctx: Ctx, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
const needVersion = (v: number | undefined): number => { if (v === undefined) throw new LimsError('common.precondition_required'); return v; };
const isoUtc = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const invalid = (path: string, code: 'common.field_invalid' | 'common.field_required' = 'common.field_invalid'): never => { const e = new Errs(); e.add(path, code); e.done(); throw e; };

/** DecimalString that fits numeric(20,6) (<= 14 integer digits, <= 6 places); `positive` = > 0 (qc_targets__sd__ck). */
function decimal(e: Errs, o: Obj, k: string, positive: boolean): string | undefined {
  const v = o[k];
  if (v === undefined) { e.add(`/${k}`, 'common.field_required'); return undefined; }
  const d = typeof v === 'string' ? parseDecimal(v) : undefined;
  if (!d || d.s > 6 || v.replace('-', '').split('.')[0]!.length > 14 || (positive && d.m <= 0n)) { e.add(`/${k}`); return undefined; }
  return v;
}
/** Optional list of unique Uuids, <= 500; item errors at `/k/i`, list errors at `/k`. Lower-cased. */
function idList(e: Errs, o: Obj, k: string): string[] {
  const v = o[k];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_IDS) { e.add(`/${k}`); return []; }
  v.forEach((x, i) => { if (!isUuid(x)) e.add(`/${k}/${i}`); });
  const ids = v.filter(isUuid).map((x) => x.toLowerCase());
  if (new Set(ids).size !== ids.length) e.add(`/${k}`);
  return ids;
}
/** Half-up to exactly p places (the stored precision of 02-TRD §7.6), as a plain decimal string. */
function fixed(d: Decimal, p: number): string {
  const r = roundDp(d, p);
  return toDecimalString(r.s < p ? { m: r.m * 10n ** BigInt(p - r.s), s: p } : r);
}
/** [CONV] basis digest: sha256 over the SORTED observation ids joined by "\n" (one per line), lowercase hex (qc_targets__basis_sha__ck). */
const digestOf = (ids: string[]): string => createHash('sha256').update([...ids].sort().join('\n'), 'utf8').digest('hex');

/** Postgres -> API: the immutability trigger (P0001 immutable_row) is 409 common.immutable_record; the active-per-key unique index is a lost race (409); anything else fails closed. */
function mapWriteError(err: any): Error {
  if (isLimsError(err)) return err;
  if (err?.code === 'P0001' && err?.message === 'immutable_row') return new LimsError('common.immutable_record');
  if (err?.code === '23505') return conflict();
  if (err?.code === '23514' && /window/.test(String(err?.constraint))) return new LimsError('common.validation_failed', undefined, [{ path: '/effective_from', code: 'common.field_invalid', message: 'Field invalid' }]);
  return new LimsError('common.internal');   // never leaks the driver message
}

export function createTargetService(deps: { repo?: TargetRepo } = {}) {
  const repo = deps.repo ?? createTargetRepo();

  async function dtos(ctx: Ctx, rows: Row[]): Promise<Row[]> {
    const ids = targetUserIds(rows);
    const labels = new Map((ids.length ? await repo.listUserLabels(ctx.tx, ctx.tenantId, ids) : []).map((l) => [l.user_id, l.display_name]));
    return rows.map((r) => targetDto(r, labels));
  }
  const one = async (ctx: Ctx, row: Row): Promise<Row> => (await dtos(ctx, [row]))[0]!;

  /** Plan, lot and level-in-composition checks shared by #21 and #22 (foreign / missing -> 404; lot level not in the CURRENT composition -> 400 /lot_id). */
  async function planAndLot(ctx: Ctx, planId: string, lotId: string): Promise<{ plan: Row; lot: Row }> {
    const [plan, lot] = await Promise.all([repo.findPlan(ctx.tx, ctx.tenantId, planId), repo.findLot(ctx.tx, ctx.tenantId, lotId)]);
    if (!plan || !lot) throw notFound();
    const composition = (await repo.currentComposition(ctx.tx, ctx.tenantId, planId)) ?? [];
    if (!composition.some((c) => c.level_id === lot['level_id'])) invalid('/lot_id');
    return { plan, lot };
  }

  async function loadTarget(ctx: Ctx, targetId: unknown, expected: number, status: 'draft' | 'active'): Promise<Row> {
    const cur = isUuid(targetId) ? await repo.findTarget(ctx.tx, ctx.tenantId, targetId) : undefined;
    if (!cur) throw notFound();
    if (cur['version'] !== expected) throw conflict();
    if (cur['status'] !== status) throw new LimsError('common.immutable_record');   // AC-04.6: only a draft is activated/discarded, only an active target retired
    return cur;
  }
  /** One lifecycle UPDATE, version-checked; `repo.updateTarget` is looked up per call. */
  async function write(ctx: Ctx, cur: Row, patch: Row): Promise<Row> {
    let row: Row | undefined;
    try { row = await repo.updateTarget(ctx.tx, ctx.tenantId, cur['id'], cur['version'], { ...patch, updated_by: ctx.actor.id }); }
    catch (err) { throw mapWriteError(err); }
    if (!row) throw conflict();   // a concurrent writer won between the read and the write
    return row;
  }

  return {
    async listQcTargets(ctx: Ctx, q: Obj = {}): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs(), pg = paging(e, q);
      const planId = qUuid(e, q, 'planId', 'plan_id'), lotId = qUuid(e, q, 'lotId', 'lot_id');
      const statuses = typeof q['status'] === 'string' ? q['status'].split(',') : undefined;
      if (q['status'] !== undefined && (!statuses || statuses.some((s) => !STATUSES.includes(s)))) e.add('/status');
      e.done();
      const page = await repo.listTargets(ctx.tx, ctx.tenantId, {
        ...(planId !== undefined ? { planId } : {}), ...(lotId !== undefined ? { lotId } : {}), ...(statuses !== undefined ? { statuses } : {}), ...pg,
      });
      return { status: 200, body: { data: await dtos(ctx, page.rows), page: { limit: pg.limit, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } } };
    },

    /** #21: manufacturer values only (source enum has the single value 'manufacturer'); level comes from the lot; the row is a draft. */
    async createQcTarget(ctx: Ctx, i: { body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(), o = shape(e, i.body, ['plan_id', 'lot_id', 'mean', 'sd', 'unit_code', 'source', 'note']);
      if (!o) return e.done() as never;
      const planId = reqUuid(e, o, 'plan_id'), lotId = reqUuid(e, o, 'lot_id'), mean = decimal(e, o, 'mean', false), sd = decimal(e, o, 'sd', true);
      const unit = o['unit_code'];
      if (unit === undefined) e.add('/unit_code', 'common.field_required'); else if (typeof unit !== 'string' || !CODE.test(unit)) e.add('/unit_code');
      if (o['source'] === undefined) e.add('/source', 'common.field_required'); else if (o['source'] !== 'manufacturer') e.add('/source');
      const note = o['note'];
      if (note !== undefined && (typeof note !== 'string' || [...note].length > 500)) e.add('/note');
      e.done();
      const { lot } = await planAndLot(ctx, planId!, lotId!);
      if (String(lot['expires_on']).slice(0, 10) < (await tenantToday(ctx))) throw new LimsError('quality.lot_expired');
      const row = await repo.insertTarget(ctx.tx, ctx.tenantId, {
        id: uuidv7(), plan_id: planId, lot_id: lotId, level_id: lot['level_id'], mean, sd, unit_code: unit, source: 'manufacturer', ...(note !== undefined ? { note } : {}),
        created_by: ctx.actor.id, updated_by: ctx.actor.id,
      });
      return { status: 201, version: row['version'], body: await one(ctx, row) };
    },

    /** #22: a draft target from observed data. Population = assigned observations of an accepted / accepted_warning run, plus no_target ones (baseline); minus excluded; plus included. */
    async establishQcTarget(ctx: Ctx, i: { body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(), o = shape(e, i.body, ['plan_id', 'lot_id', 'observed_at_from', 'observed_at_to', 'include_observation_ids', 'exclude_observation_ids']);
      if (!o) return e.done() as never;
      const planId = reqUuid(e, o, 'plan_id'), lotId = reqUuid(e, o, 'lot_id');
      const range = (k: string) => { if (o[k] === undefined) e.add(`/${k}`, 'common.field_required'); else if (!isoUtc(o[k])) e.add(`/${k}`); else return o[k] as string; return undefined; };
      const from = range('observed_at_from'), to = range('observed_at_to');
      if (from && to && Date.parse(to) <= Date.parse(from)) e.add('/observed_at_to');
      const include = idList(e, o, 'include_observation_ids'), exclude = idList(e, o, 'exclude_observation_ids');
      e.done();
      const { plan, lot } = await planAndLot(ctx, planId!, lotId!);
      const test = await ctx.ports.CatalogPort.getTest(ctx, { testId: plan['test_id'] });   // failures propagate: fail closed, nothing written
      const analyte = (test?.analytes as Row[] | undefined)?.find((a) => a['id'] === plan['analyte_id']);
      if (!analyte || typeof analyte['unitCode'] !== 'string') throw new LimsError('common.internal');

      const candidates = await repo.listEstablishCandidates(ctx.tx, ctx.tenantId, { planId: planId!, lotId: lotId!, from: from!, to: to! });
      const byId = new Map(candidates.map((c) => [String(c['id']).toLowerCase(), c]));
      const num = (c: Row): Decimal | undefined => (typeof c['value'] === 'string' ? parseDecimal(c['value']) : undefined);
      include.forEach((id, k) => { const c = byId.get(id); if (!c || c['status'] === 'excluded' || !num(c)) e.add(`/include_observation_ids/${k}`); });
      e.done();
      const inRule = (c: Row) => (c['status'] === 'assigned' && (c['run_outcome'] === 'accepted' || c['run_outcome'] === 'accepted_warning')) || c['status'] === 'no_target';
      const left = new Set(exclude), back = new Set(include);
      const picked = candidates.filter((c) => (inRule(c) || back.has(String(c['id']).toLowerCase())) && !left.has(String(c['id']).toLowerCase()) && num(c));

      const settings = await repo.getSettings(ctx.tx, ctx.tenantId);
      const min = Math.max(2, Number.isInteger(settings?.['target_min_points']) ? settings!['target_min_points'] : DEFAULT_MIN_POINTS);
      if (picked.length < min) throw new LimsError('quality.insufficient_qc_data');
      const stats = targetStats(picked.map((c) => num(c)!), min);
      const decimals = Number.isInteger(analyte['decimals']) ? analyte['decimals'] : 0, places = Math.min(decimals + 2, 6);   // storedTarget's precision
      const stored = storedTarget(stats, decimals);
      if (stored.sd.m <= 0n) invalid('/', 'common.field_invalid');   // AC-04.4: SD 0 would violate qc_targets__sd__ck
      const row = await repo.insertTarget(ctx.tx, ctx.tenantId, {
        id: uuidv7(), plan_id: planId, lot_id: lotId, level_id: lot['level_id'], mean: fixed(stored.mean, places), sd: fixed(stored.sd, places), unit_code: analyte['unitCode'], source: 'established',
        basis_n: picked.length, basis_from: from, basis_to: to, basis_observation_ids_sha256: digestOf(picked.map((c) => String(c['id']).toLowerCase())),
        created_by: ctx.actor.id, updated_by: ctx.actor.id,
      });
      return { status: 201, version: row['version'], body: await one(ctx, row) };
    },

    /** #23: draft -> active. The target in force for the key is superseded FIRST (effective_to = X), then this one activated from X; all in the request transaction. */
    async activateQcTarget(ctx: Ctx, i: { targetId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(), o = shape(e, i.body ?? {}, ['effective_from']);
      if (o && o['effective_from'] !== undefined && (!isoUtc(o['effective_from']) || Date.parse(o['effective_from']) < Date.parse(ctx.now()))) e.add('/effective_from');
      e.done();
      const cur = await loadTarget(ctx, i.targetId, needVersion(i.expectedVersion), 'draft');
      const at: string = o?.['effective_from'] ?? ctx.now();
      const old = await repo.findActiveTarget(ctx.tx, ctx.tenantId, cur['plan_id'], cur['lot_id']);
      if (old) await write(ctx, old, { status: 'superseded', effective_to: at });
      const row = await write(ctx, cur, { status: 'active', effective_from: at, activated_at: ctx.now(), activated_by: ctx.actor.id });
      // 03-APP-FLOW §2.5: history adoption for the plan; same transaction, a queue failure fails the request.
      await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [REPROCESS_TASK, JSON.stringify({ tenant_id: ctx.tenantId, plan_id: cur['plan_id'] }), `reproc:${cur['plan_id']}`]);
      return { status: 200, version: row['version'], body: await one(ctx, row) };
    },

    /** #24: active -> retired with a reason. Mean/SD untouched. */
    async retireQcTarget(ctx: Ctx, i: { targetId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(), o = shape(e, i.body, ['reason']);
      const why = o ? reason(e, o, 'reason') : undefined;
      e.done();
      const cur = await loadTarget(ctx, i.targetId, needVersion(i.expectedVersion), 'active');
      const row = await write(ctx, cur, { status: 'retired', retired_at: ctx.now(), retired_by: ctx.actor.id, retire_reason: why });
      return { status: 200, version: row['version'], body: await one(ctx, row) };
    },

    /** #25: draft -> discarded (body {}). */
    async discardQcTarget(ctx: Ctx, i: { targetId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const e = new Errs(); shape(e, i.body ?? {}, []); e.done();
      const cur = await loadTarget(ctx, i.targetId, needVersion(i.expectedVersion), 'draft');
      const row = await write(ctx, cur, { status: 'discarded' });
      return { status: 200, version: row['version'], body: await one(ctx, row) };
    },
  };
}
