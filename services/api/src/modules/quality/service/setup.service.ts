// C9 T-06 set-up service #1-#13: control materials, levels, lots, control-ID maps (02-TRD §5.1; AC-01.1-01.4, AC-02.5; 07-SECURITY S-01/S-03/S-04/S-07).
// Order of every operation: assertRole -> validate -> (If-Match present?) -> load through the tenant-scoped repo (404 when invisible) -> version check -> write.
// Tenant, actor and ids come from ctx / the service, never from a body. Errors throw LimsError; the core rolls the request transaction back (02-CV §4.6).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { idMapDto, levelDto, lotDto, materialDto } from '../mappers/setup.mapper.js';
import { createSetupRepo, type Row, type SetupRepo } from '../repository/setup.repo.js';
import { Errs, isIsoDate, levelCreate, levelPatch, lotCreate, lotPatch, mapCreate, materialCreate, materialPatch, paging, qBool, qEnum, qUuid } from './setup.validate.js';

export interface SetupCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly tx: any;
  readonly now: () => string;
  readonly ports?: any;
}
export interface Result { status: number; body: unknown; version?: number }
type Q = Record<string, any>;

const READ = 'quality.qc_run.read', MANAGE = 'quality.qc.manage';
const REPROCESS_TASK = 'quality.reprocess_pending_observations';
const MAX_LEVELS = 6;

const assert = (ctx: SetupCtx, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const fail = (path: string): never => {
  const e = new Errs(); e.add(path); e.done();
  throw new LimsError('common.validation_failed');   // unreachable: done() throws
};
const dup = (e: any): boolean => e?.code === '23505';
const notFound = () => new LimsError('common.not_found');

/** The tenant's business date (08 A13 P-15): ctx.now() rendered in the tenant timezone. Fail closed when the zone is unusable. */
export async function tenantToday(ctx: SetupCtx): Promise<string> {
  const tz = (await ctx.ports?.IdentityPort?.getTenantSettings?.(ctx, { keys: ['timezone'] }))?.timezone;
  if (typeof tz !== 'string' || !tz) throw new LimsError('common.internal');   // Intl would silently use the host zone
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ctx.now())); }
  catch { throw new LimsError('common.internal'); }
}

/** If-Match: absent -> 428, present but different from the stored version -> 409. */
function needVersion(v: number | undefined): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  return v;
}
const conflict = () => new LimsError('common.version_conflict');

export function createSetupService(deps: { repo?: SetupRepo } = {}) {
  const repo = deps.repo ?? createSetupRepo();
  const audit = (ctx: SetupCtx) => ({ updated_by: ctx.actor.id });

  /** Full material DTO (levels + lots_expiring_30d); `withLots` nests lots under each level (#3 and the writes that return a material). */
  async function material(ctx: SetupCtx, rows: Row[], today: string, withLots: boolean): Promise<Row[]> {
    if (!rows.length) return [];
    const ids = rows.map((m) => m['id']);
    const [levels, lots] = await Promise.all([repo.listLevels(ctx.tx, ctx.tenantId, ids), repo.listLotsByMaterials(ctx.tx, ctx.tenantId, ids)]);
    return rows.map((m) => materialDto(m, levels.filter((l) => l['material_id'] === m['id']), lots.filter((l) => l['material_id'] === m['id']), today, withLots));
  }
  const labels = async (ctx: SetupCtx, ids: string[]) =>
    new Map((ids.length ? await repo.listInstrumentLabels(ctx.tx, ctx.tenantId, [...new Set(ids)]) : []).map((l) => [l.instrument_id, l]));

  return {
    // ---------------------------------------------------------------------------------------------- materials
    async listControlMaterials(ctx: SetupCtx, q: Q = {}): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs(), pg = paging(e, q);
      const sort = qEnum(e, q, 'sort', ['code', '-created_at'] as const);
      const isActive = qBool(e, q, 'isActive', 'is_active') ?? true;
      if (q['q'] !== undefined && (typeof q['q'] !== 'string' || q['q'].length < 1 || [...q['q']].length > 40)) e.add('/q');
      e.done();
      const page = await repo.listMaterials(ctx.tx, ctx.tenantId, { isActive, ...(q['q'] !== undefined ? { q: q['q'] } : {}), sort, ...pg });
      const data = await material(ctx, page.rows, await tenantToday(ctx), false);
      return { status: 200, body: { data, page: { limit: pg.limit, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } } };
    },

    async createControlMaterial(ctx: SetupCtx, i: { body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const b = materialCreate(i.body);
      if (new Set(b.levels.map((l) => l.level_code)).size !== b.levels.length) throw new LimsError('quality.code_duplicate');
      const id = uuidv7(), by = { created_by: ctx.actor.id, updated_by: ctx.actor.id };
      const created = await write(() => repo.insertMaterial(ctx.tx, ctx.tenantId, { id, code: b.code, name: b.name, manufacturer: b.manufacturer ?? null, matrix: b.matrix ?? null, ...by }));
      const levels: Row[] = [];
      for (const l of b.levels) levels.push(await write(() => repo.insertLevel(ctx.tx, ctx.tenantId, { id: uuidv7(), material_id: id, ...l, ...by })));
      return { status: 201, version: created['version'], body: materialDto(created, levels, [], '', false) };   // no lots yet: the business date is not needed
    },

    async getControlMaterial(ctx: SetupCtx, i: { materialId: unknown }): Promise<Result> {
      await assert(ctx, READ);
      const m = isId(i.materialId) ? await repo.findMaterial(ctx.tx, ctx.tenantId, i.materialId) : undefined;
      if (!m) throw notFound();
      return { status: 200, version: m['version'], body: (await material(ctx, [m], await tenantToday(ctx), true))[0] };
    },

    async updateControlMaterial(ctx: SetupCtx, i: { materialId: unknown; expectedVersion?: number | undefined; patch: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const patch = materialPatch(i.patch);
      return changeMaterial(ctx, i.materialId, i.expectedVersion, patch);
    },

    async deactivateControlMaterial(ctx: SetupCtx, i: { materialId: unknown; expectedVersion?: number | undefined }): Promise<Result> {
      await assert(ctx, MANAGE);
      return changeMaterial(ctx, i.materialId, i.expectedVersion, { is_active: false });   // AC-01.4: never deleted, stays readable with its levels and lots
    },

    // ---------------------------------------------------------------------------------------------- levels
    async createControlLevel(ctx: SetupCtx, i: { materialId: unknown; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const b = levelCreate(i.body);
      const m = isId(i.materialId) ? await repo.findMaterial(ctx.tx, ctx.tenantId, i.materialId) : undefined;
      if (!m) throw notFound();
      // [CONV] ControlMaterialDto.levels maxItems 6 (quality.yaml): a 7th level could not be rendered, so it is refused up front.
      if ((await repo.listLevels(ctx.tx, ctx.tenantId, [m['id']])).length >= MAX_LEVELS) fail('/level_code');
      const row = await write(() => repo.insertLevel(ctx.tx, ctx.tenantId, { id: uuidv7(), material_id: m['id'], ...b, created_by: ctx.actor.id, updated_by: ctx.actor.id }));
      return { status: 201, version: row['version'], body: levelDto(row) };
    },

    async updateControlLevel(ctx: SetupCtx, i: { levelId: unknown; expectedVersion?: number | undefined; patch: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const patch = levelPatch(i.patch), v = needVersion(i.expectedVersion);
      const cur = isId(i.levelId) ? await repo.findLevel(ctx.tx, ctx.tenantId, i.levelId) : undefined;
      if (!cur) throw notFound();
      if (cur['version'] !== v) throw conflict();
      const row = await repo.updateLevel(ctx.tx, ctx.tenantId, cur['id'], v, { ...patch, ...audit(ctx) });
      if (!row) throw conflict();
      return { status: 200, version: row['version'], body: levelDto(row) };
    },

    // ---------------------------------------------------------------------------------------------- lots
    async createControlLot(ctx: SetupCtx, i: { levelId: unknown; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const b = lotCreate(i.body);
      const level = isId(i.levelId) ? await repo.findLevel(ctx.tx, ctx.tenantId, i.levelId) : undefined;
      if (!level) throw notFound();
      const today = await tenantToday(ctx);
      if (b.expires_on < today) throw new LimsError('quality.lot_expired');
      const row = await write(() => repo.insertLot(ctx.tx, ctx.tenantId, { id: uuidv7(), level_id: level['id'], material_id: level['material_id'], ...b, created_by: ctx.actor.id, updated_by: ctx.actor.id }));
      return { status: 201, version: row['version'], body: lotDto(row, today) };
    },

    async listControlLots(ctx: SetupCtx, q: Q = {}): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs(), pg = paging(e, q);
      const sort = qEnum(e, q, 'sort', ['expires_on', '-created_at'] as const);
      const f = { materialId: qUuid(e, q, 'materialId', 'material_id'), levelId: qUuid(e, q, 'levelId', 'level_id'), isActive: qBool(e, q, 'isActive', 'is_active'), expiresOnTo: undefined as string | undefined };
      if (q['expiresOnTo'] !== undefined) { if (!isIsoDate(q['expiresOnTo'])) e.add('/expires_on_to'); else f.expiresOnTo = q['expiresOnTo']; }
      e.done();
      const page = await repo.listLots(ctx.tx, ctx.tenantId, { ...defined(f), sort, ...pg });
      const today = await tenantToday(ctx);
      return { status: 200, body: { data: page.rows.map((r) => lotDto(r, today)), page: pageOf(pg.limit, page.nextCursor) } };
    },

    async updateControlLot(ctx: SetupCtx, i: { lotId: unknown; expectedVersion?: number | undefined; patch: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const patch = lotPatch(i.patch), v = needVersion(i.expectedVersion);
      const cur = isId(i.lotId) ? await repo.findLot(ctx.tx, ctx.tenantId, i.lotId) : undefined;
      if (!cur) throw notFound();
      if (cur['version'] !== v) throw conflict();
      const today = await tenantToday(ctx);
      if (patch['expires_on'] !== undefined && patch['expires_on'] < today) throw new LimsError('quality.lot_expired');   // the guard is for a NEW expiry only
      const row = await repo.updateLot(ctx.tx, ctx.tenantId, cur['id'], v, { ...patch, ...audit(ctx) });
      if (!row) throw conflict();
      return { status: 200, version: row['version'], body: lotDto(row, today) };
    },

    // ---------------------------------------------------------------------------------------------- control-ID maps
    async listControlIdMaps(ctx: SetupCtx, q: Q = {}): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs(), pg = paging(e, q);
      const f = { instrumentId: qUuid(e, q, 'instrumentId', 'instrument_id'), lotId: qUuid(e, q, 'lotId', 'lot_id'), isActive: qBool(e, q, 'isActive', 'is_active') };
      e.done();
      const page = await repo.listMaps(ctx.tx, ctx.tenantId, { ...defined(f), ...pg });
      const lab = await labels(ctx, page.rows.map((r) => r['instrument_id']));
      return { status: 200, body: { data: page.rows.map((r) => idMapDto(r, lab.get(r['instrument_id']))), page: pageOf(pg.limit, page.nextCursor) } };
    },

    async createControlIdMap(ctx: SetupCtx, i: { body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const b = mapCreate(i.body);
      const lot = await repo.findLot(ctx.tx, ctx.tenantId, b.lot_id);
      if (!lot) return fail('/lot_id');                                             // unknown or another tenant's lot: same answer (S-04)
      if (String(lot['expires_on']).slice(0, 10) < (await tenantToday(ctx))) throw new LimsError('quality.lot_expired');
      let row: Row;
      try {
        row = await repo.insertMap(ctx.tx, ctx.tenantId, { id: uuidv7(), ...b, control_lot_raw: b.control_lot_raw ?? null, created_by: ctx.actor.id, updated_by: ctx.actor.id });
      } catch (err: any) {
        if (dup(err)) throw new LimsError('quality.code_duplicate');
        if (err?.code === '23503') return fail(/instrument/.test(String(err.constraint)) ? '/instrument_id' : '/lot_id');   // AC-02.5: FK -> 400, never 500; value not echoed
        throw err;
      }
      // §6.4: pending observations of this instrument may now resolve; same transaction, not swallowed (a queue failure fails the request). No-op task until T-11.
      await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [REPROCESS_TASK, JSON.stringify({ tenant_id: ctx.tenantId, instrument_id: b.instrument_id }), `reproc:${b.instrument_id}`]);
      return { status: 201, version: row['version'], body: idMapDto(row, (await labels(ctx, [b.instrument_id])).get(b.instrument_id)) };
    },

    async deactivateControlIdMap(ctx: SetupCtx, i: { mapId: unknown; expectedVersion?: number | undefined }): Promise<Result> {
      await assert(ctx, MANAGE);
      const v = needVersion(i.expectedVersion);
      const cur = isId(i.mapId) ? await repo.findMap(ctx.tx, ctx.tenantId, i.mapId) : undefined;
      if (!cur) throw notFound();
      if (cur['version'] !== v) throw conflict();
      const row = await repo.updateMap(ctx.tx, ctx.tenantId, cur['id'], v, { is_active: false, ...audit(ctx) });
      if (!row) throw conflict();
      return { status: 200, version: row['version'], body: idMapDto(row, (await labels(ctx, [row['instrument_id']])).get(row['instrument_id'])) };
    },
  };

  /** Shared by #4 / #5: load -> If-Match -> update -> full material DTO. */
  async function changeMaterial(ctx: SetupCtx, id: unknown, expected: number | undefined, patch: Row): Promise<Result> {
    const v = needVersion(expected);
    const cur = isId(id) ? await repo.findMaterial(ctx.tx, ctx.tenantId, id) : undefined;
    if (!cur) throw notFound();
    if (cur['version'] !== v) throw conflict();
    const row = await repo.updateMaterial(ctx.tx, ctx.tenantId, cur['id'], v, { ...patch, ...audit(ctx) });
    if (!row) throw conflict();                                                       // a concurrent writer won between the read and the write
    return { status: 200, version: row['version'], body: (await material(ctx, [row], await tenantToday(ctx), true))[0] };
  }
}

/** Unique violation -> 409 quality.code_duplicate; anything else propagates (the core renders 500 common.internal without detail). */
async function write<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw dup(e) ? new LimsError('quality.code_duplicate') : e; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const defined = <T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as any;
const pageOf = (limit: number, next?: string) => ({ limit, ...(next ? { next_cursor: next } : {}) });
