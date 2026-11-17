// Instrument code maps #92–#95 (02-TRD §5 rows 92–95, §5.0, §9.1; 05-SCHEMA instrument_code_maps (X4); PRD US-18 AC-18.1/.3/.4/.5);
// 07-SECURITY S-1, S-5, AB-20. Permission (privileged catalog.instrument_code_map.manage, aal2) is asserted by the handlers, not here.
// Validates its own input. Every write bumps the catalog revision (entity `instrument_code_map`) in the caller's transaction. Lock order: map row, then catalog_state.
// AC-18.4: analyte and test must exist in the caller's tenant (else 404, a foreign id looks like an unknown id) and the analyte must belong to the test (else 400); the composite FK is the backstop.
// AC-18.3: the two partial uniques (inbound: instrument+code; outbound: instrument+analyte, active rows) -> 23505 -> 409 catalog.code_duplicate.
// [CONV] bulk (#95): rows are matched among the instrument's ACTIVE maps — inbound/both rows by instrument_code, outbound/both rows by analyte_id; a match that is not the very same map
// (code, analyte, direction) is a per-row catalog.code_duplicate (identity columns are immutable); absent optional fields are left as they are; one savepoint per written row.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';   // [CONV] relative import (same as masters.service.ts)
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as repo from '../repo/masters.repo.js';
import { checkUpdate, fail, invalid, isObj, kindOf, lockAt, mapPg, required, unknown, UUID, type Ctx, type Deps, type Tx } from './masters.service.js';
import { createRevisionService } from './revision.service.js';

const COLS = ['id', 'instrument_id', 'direction', 'instrument_code', 'analyte_id', 'test_id', 'unit_from_raw', 'unit_to_code', 'unit_factor', 'flag_map', 'is_active', 'version'];
const DIRECTIONS = ['inbound', 'outbound', 'both'];
const UNITS = ['unit_from_raw', 'unit_to_code', 'unit_factor'];
const CLEARABLE = [...UNITS, 'flag_map'];
const OPT = [...UNITS, 'flag_map'];
const CREATE_KEYS = ['instrument_id', 'direction', 'instrument_code', 'analyte_id', 'test_id', ...OPT];
const ROW_KEYS = ['direction', 'instrument_code', 'analyte_id', 'test_id', ...OPT, 'is_active'];
const UPDATE_KEYS = [...OPT, 'unset', 'is_active'];
const UNIT_TO = /^[A-Za-z0-9_]{1,32}$/;
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const FLAG_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const MAX_ROWS = 200;

type R = Record<string, any>;

/** Per-field check; flag_map is returned parsed (a plain object), everything else as submitted. Returns undefined when invalid. */
function fieldValue(key: string, v: unknown): { v: unknown } | undefined {
  const ok = (x: unknown) => ({ v: x });
  switch (key) {
    case 'instrument_id': case 'analyte_id': case 'test_id': return typeof v === 'string' && UUID.test(v) ? ok(v) : undefined;
    case 'direction': return typeof v === 'string' && DIRECTIONS.includes(v) ? ok(v) : undefined;
    case 'instrument_code': return typeof v === 'string' && v.length >= 1 && v.length <= 64 ? ok(v) : undefined;
    case 'unit_from_raw': return typeof v === 'string' && v.length >= 1 && v.length <= 32 ? ok(v) : undefined;
    case 'unit_to_code': return typeof v === 'string' && UNIT_TO.test(v) ? ok(v) : undefined;
    case 'unit_factor': return typeof v === 'string' && v.length <= 40 && DECIMAL.test(v) && /[1-9]/.test(v) ? ok(v) : undefined;
    case 'is_active': return typeof v === 'boolean' ? ok(v) : undefined;
    case 'flag_map': {
      if (typeof v !== 'string' || v.length > 2000) return undefined;
      let p: unknown;
      try { p = JSON.parse(v); } catch { return undefined; }
      if (!isObj(p)) return undefined;
      const ents = Object.entries(p);
      return ents.length <= 20 && ents.every(([k, x]) => k.length >= 1 && k.length <= 16 && typeof x === 'string' && x.length <= 100 && FLAG_VALUE.test(x)) ? ok(p) : undefined;
    }
    default: return undefined;
  }
}

/** Declared keys only (S-5); errors name a field, never echo a value (AB-20). Unknown keys are reported at the root. */
function checkBody(input: unknown, allowed: readonly string[], prefix = ''): Record<string, unknown> {
  if (!isObj(input)) return fail([invalid(prefix)]);
  const errors: FieldError[] = [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) {
    const v = input[k];
    if (v === undefined) continue;
    if (!allowed.includes(k)) errors.push(unknown(prefix));
    else if (k === 'unset') out[k] = v;
    else { const f = fieldValue(k, v); if (f) out[k] = f.v; else errors.push(invalid(`${prefix}/${k}`)); }
  }
  if (errors.length) fail(errors);
  return out;
}
/** The unit triple is all-or-none (05-SCHEMA instrument_code_maps__unit_triple__ck). */
const tripleOk = (o: R) => { const n = UNITS.filter((k) => o[k] != null).length; return n === 0 || n === 3; };
const requireKeys = (b: R, keys: readonly string[], prefix = '') => { const missing = keys.filter((k) => b[k] === undefined).map((k) => required(`${prefix}/${k}`)); if (missing.length) fail(missing); };

const dto = (r: R) => {
  const out: R = { id: r.id, instrument_id: r.instrument_id, direction: r.direction, instrument_code: r.instrument_code, analyte_id: r.analyte_id, test_id: r.test_id };
  for (const k of UNITS) if (r[k] != null) out[k] = String(r[k]);
  if (r.flag_map != null) out['flag_map'] = typeof r.flag_map === 'string' ? r.flag_map : JSON.stringify(r.flag_map);
  out['is_active'] = r.is_active === true; out['version'] = Number(r.version);
  return out;
};

interface ListQuery { instrument_id: string; direction?: string; analyte_id?: string; is_active: 'true' | 'false' | 'all'; cursor?: string; limit: number }
function checkQuery(query: unknown): ListQuery {
  const q = query === undefined ? {} : query;
  if (!isObj(q)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: Partial<ListQuery> & { is_active: ListQuery['is_active']; limit: number } = { is_active: 'true', limit: 50 };
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (k === 'instrument_id' || k === 'analyte_id') { if (typeof v === 'string' && UUID.test(v)) out[k] = v; else errors.push(invalid(`/${k}`)); }
    else if (k === 'direction') { if (typeof v === 'string' && DIRECTIONS.includes(v)) out.direction = v; else errors.push(invalid('/direction')); }
    else if (k === 'is_active') { if (v === 'true' || v === 'false' || v === 'all') out.is_active = v; else errors.push(invalid('/is_active')); }
    else if (k === 'cursor') { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v)) throw new LimsError('common.invalid_cursor'); out.cursor = v; }
    else if (k === 'limit') {
      const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v;
      if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 200) out.limit = n as number; else errors.push(invalid('/limit'));
    } else errors.push(unknown(''));
  }
  if (out.instrument_id === undefined && !errors.some((e) => e.path === '/instrument_id')) errors.push(required('/instrument_id'));
  if (errors.length) fail(errors);
  return out as ListQuery;
}

/** "0.10" == "0.1" (numeric column keeps the submitted scale). */
const decNorm = (s: unknown) => { const x = String(s); return x.includes('.') ? x.replace(/0+$/, '').replace(/\.$/, '') : x; };
const canon = (o: unknown): string => JSON.stringify(Object.fromEntries(Object.entries((o ?? {}) as R).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
const inbound = (d: string) => d !== 'outbound';
const outbound = (d: string) => d !== 'inbound';

export function createInstrumentMapsService(deps: Deps) {
  const revision = createRevisionService(deps);
  const nowOf = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, id: string, changeKind: string, at: string) =>
    revision.bumpRevision(ctx, { entityType: 'instrument_code_map', entityId: id, changeKind, effectiveFrom: at });
  const q = async (ctx: Ctx, text: string, values: unknown[]): Promise<R[]> => (await (ctx.tx as Tx).query(text, values)).rows;

  /** analyte_id -> test_id and the set of test ids, both restricted to the caller's tenant (S-1). */
  async function lookups(ctx: Ctx, analyteIds: string[], testIds: string[]) {
    const analytes = new Map((await q(ctx, 'SELECT id, test_id FROM catalog.analytes WHERE tenant_id = $1 AND id = ANY($2)', [ctx.tenantId, analyteIds])).map((r) => [r.id as string, r.test_id as string]));
    const tests = new Set((await q(ctx, 'SELECT id FROM catalog.tests WHERE tenant_id = $1 AND id = ANY($2)', [ctx.tenantId, testIds])).map((r) => r.id as string));
    return { analytes, tests };
  }
  /** 'ok' | the error code of AC-18.4. */
  const pairOf = (l: Awaited<ReturnType<typeof lookups>>, analyteId: string, testId: string) =>
    !l.analytes.has(analyteId) || !l.tests.has(testId) ? 'common.not_found' : l.analytes.get(analyteId) !== testId ? 'common.validation_failed' : 'ok';

  const insertMap = (tx: Tx, ctx: Ctx, b: R) => repo.insertRow(tx, 'instrument_code_maps', COLS, {
    id: uuidv7(), tenant_id: ctx.tenantId, instrument_id: b['instrument_id'], direction: b['direction'], instrument_code: b['instrument_code'], analyte_id: b['analyte_id'], test_id: b['test_id'],
    ...Object.fromEntries(UNITS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])),
    ...(b['flag_map'] === undefined ? {} : { flag_map: JSON.stringify(b['flag_map']) }),
    ...(b['is_active'] === undefined ? {} : { is_active: b['is_active'] }),
    created_by: ctx.actor.id, updated_by: ctx.actor.id,
  }).catch(mapPg);

  return {
    async listInstrumentCodeMaps(ctx: Ctx, query?: unknown) {
      const f = checkQuery(query);
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1', `instrument_id = ${bind(f.instrument_id)}`];
      if (f.is_active !== 'all') where.push(`is_active = ${bind(f.is_active === 'true')}`);
      if (f.direction !== undefined) where.push(`direction = ${bind(f.direction)}`);
      if (f.analyte_id !== undefined) where.push(`analyte_id = ${bind(f.analyte_id)}`);
      if (f.cursor !== undefined) { const [v, id] = decodeCursor(f.cursor, 'instrument_code'); where.push(`(instrument_code, id) > (${bind(v)}, ${bind(id)})`); }
      const rows = await q(ctx, `SELECT ${COLS.join(', ')} FROM catalog.instrument_code_maps WHERE ${where.join(' AND ')} ORDER BY instrument_code ASC, id ASC LIMIT ${bind(f.limit + 1)}`, values);
      const data = rows.slice(0, f.limit);
      const last = data[data.length - 1];
      const page: { limit: number; next_cursor?: string } = { limit: f.limit };
      if (rows.length > f.limit && last) page.next_cursor = encodeCursor('instrument_code', last.instrument_code, last.id);
      return { data: data.map(dto), page };
    },

    async createInstrumentCodeMap(ctx: Ctx, body?: unknown) {
      const b = checkBody(body, CREATE_KEYS);
      requireKeys(b, ['instrument_id', 'direction', 'instrument_code', 'analyte_id', 'test_id']);
      if (!tripleOk(b)) fail([invalid('/unit_factor')]);
      const at = nowOf(ctx);
      const pair = pairOf(await lookups(ctx, [b['analyte_id'] as string], [b['test_id'] as string]), b['analyte_id'] as string, b['test_id'] as string);
      if (pair === 'common.not_found') throw new LimsError('common.not_found');
      if (pair !== 'ok') fail([invalid('/analyte_id')]);
      const created = await insertMap(ctx.tx as Tx, ctx, b);
      await bump(ctx, created.id, 'created', at);
      return dto(created);
    },

    async updateInstrumentCodeMap(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = checkBody(input.patch, UPDATE_KEYS);
      const unset = b['unset'];
      const patch: R = {};
      for (const k of Object.keys(b)) if (k !== 'unset') patch[k] = k === 'flag_map' ? JSON.stringify(b[k]) : b[k];
      if (unset !== undefined) {
        if (!Array.isArray(unset) || unset.length > CLEARABLE.length || new Set(unset).size !== unset.length
          || unset.some((k) => typeof k !== 'string' || !CLEARABLE.includes(k) || b[k] !== undefined)) fail([invalid('/unset')]);
        for (const k of unset as string[]) patch[k] = null;
      }
      const at = nowOf(ctx);
      const before = await lockAt(ctx, 'instrument_code_maps', COLS, id, ev);
      if (!tripleOk({ ...before, ...patch })) fail([invalid('/unit_factor')]);
      const after = await repo.updateRow(ctx.tx as Tx, 'instrument_code_maps', COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, patch).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, kindOf(before, after), at);
      return dto(after);
    },

    async upsertInstrumentCodeMaps(ctx: Ctx, body?: unknown) {
      if (!isObj(body)) return fail([invalid('')]);
      const errors: FieldError[] = [];
      for (const k of Object.keys(body)) if (body[k] !== undefined && k !== 'instrument_id' && k !== 'maps') errors.push(unknown(''));
      const instrumentId = body['instrument_id'];
      if (instrumentId === undefined) errors.push(required('/instrument_id'));
      else if (typeof instrumentId !== 'string' || !UUID.test(instrumentId)) errors.push(invalid('/instrument_id'));
      const maps = body['maps'];
      if (maps === undefined) errors.push(required('/maps'));
      else if (!Array.isArray(maps) || maps.length < 1 || maps.length > MAX_ROWS) errors.push(invalid('/maps'));
      if (errors.length) fail(errors);
      const rows = (maps as unknown[]).map((m, i) => {
        const r = checkBody(m, ROW_KEYS, `/maps/${i}`);
        requireKeys(r, ['direction', 'instrument_code', 'analyte_id', 'test_id'], `/maps/${i}`);
        if (!tripleOk(r)) fail([invalid(`/maps/${i}/unit_factor`)]);
        return r;
      });
      const inst = instrumentId as string;
      const at = nowOf(ctx);
      const l = await lookups(ctx, [...new Set(rows.map((r) => r['analyte_id'] as string))], [...new Set(rows.map((r) => r['test_id'] as string))]);
      const active: R[] = await q(ctx, `SELECT ${COLS.join(', ')} FROM catalog.instrument_code_maps WHERE tenant_id = $1 AND instrument_id = $2 AND is_active = $3 ORDER BY id ASC`, [ctx.tenantId, inst, true]);
      const tx = ctx.tx as Tx & { savepoint?<T>(fn: (t: Tx) => Promise<T>): Promise<T> };
      const guarded = <T>(fn: (t: Tx) => Promise<T>): Promise<T> => (typeof tx.savepoint === 'function' ? tx.savepoint(fn) : fn(tx));

      const results: R[] = [];
      for (const r of rows) {
        const echo = { direction: r['direction'] as string, instrument_code: r['instrument_code'] as string, analyte_id: r['analyte_id'] as string };
        const fail1 = (code: string) => results.push({ ...echo, outcome: 'error', error_code: code });
        const pair = pairOf(l, echo.analyte_id, r['test_id'] as string);
        if (pair !== 'ok') { fail1(pair); continue; }
        const hits = active.filter((m) => (inbound(echo.direction) && inbound(m['direction']) && m['instrument_code'] === echo.instrument_code)
          || (outbound(echo.direction) && outbound(m['direction']) && m['analyte_id'] === echo.analyte_id));
        const same = (m: R) => m['direction'] === echo.direction && m['instrument_code'] === echo.instrument_code && m['analyte_id'] === echo.analyte_id;
        if (hits.length > 1 || (hits.length === 1 && !same(hits[0]!))) { fail1('catalog.code_duplicate'); continue; }
        try {
          if (hits.length === 0) {
            if (r['is_active'] === false) { results.push({ ...echo, outcome: 'unchanged' }); continue; }   // nothing active to deactivate
            const created = await guarded((t) => insertMap(t, ctx, { ...r, instrument_id: inst }));
            active.push(created);
            results.push({ ...echo, map_id: created.id, outcome: 'created' });
            await bump(ctx, created.id, 'created', at);
            continue;
          }
          const m = hits[0]!;
          const patch: R = {};
          if (UNITS.some((k) => r[k] !== undefined) && UNITS.some((k) => (k === 'unit_factor' ? decNorm(r[k]) !== (m[k] == null ? null : decNorm(m[k])) : r[k] !== m[k]))) for (const k of UNITS) patch[k] = r[k];
          if (r['flag_map'] !== undefined && canon(r['flag_map']) !== canon(m['flag_map'])) patch['flag_map'] = JSON.stringify(r['flag_map']);
          if (r['is_active'] !== undefined && r['is_active'] !== m['is_active']) patch['is_active'] = r['is_active'];
          if (!Object.keys(patch).length) { results.push({ ...echo, map_id: m['id'], outcome: 'unchanged' }); continue; }
          const after = await guarded((t) => repo.updateRow(t, 'instrument_code_maps', COLS, { tenantId: ctx.tenantId, id: m['id'], expectedVersion: Number(m['version']), actorId: ctx.actor.id }, patch).catch(mapPg));
          if (!after) { fail1('common.version_conflict'); continue; }
          active.splice(active.indexOf(m), 1);
          if (after.is_active === true) active.push(after);
          results.push({ ...echo, map_id: after.id, outcome: 'updated' });
          await bump(ctx, after.id, kindOf(m, after), at);
        } catch (e) {
          if (!(e instanceof LimsError) || (e.code !== 'catalog.code_duplicate' && e.code !== 'common.not_found')) throw e;   // anything else (event/DB failure) fails the request
          fail1(e.code);
        }
      }
      return { results };
    },
  };
}
