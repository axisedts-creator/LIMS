// Reference-range sets #37–#43 and critical-limit sets #44–#50 (02-TRD §5.2, §3, §7.3 step 6, §9.1; 03-APP-FLOW §2.1 V1–V6; 05-SCHEMA §10.2;
// PRD AC-05.7–05.10, AC-06.4; 07-SECURITY S-1, S-5, S-6, AB-9, AB-18, AB-20). One implementation, two families (same rules — AC-06.4).
// Validates its own input. Permissions are the handler's. Draft writes (create / replace / discard) bump nothing; publish and retire bump once in the same tx
// and stamp the OWNING test's orderable. Lock order: owning test's orderable, analyte, set row (then its bands), then catalog_state (bumpRevision) —
// the prefix analyteVersions.service uses, so range writes cannot deadlock with analyte or test writes. Draft-only writes skip the orderable lock.
// [CONV] uuidv7 via relative import until @lims/shared-ts is a services/api dependency (same as analyteVersions.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { findOverlaps } from '../domain/rangeMatch.js';
import * as arepo from '../repo/analytes.repo.js';
import * as repo from '../repo/tests.repo.js';
import { checkFields, checkUpdate, fail, invalid, isObj, ptr, required, str, unknown as unknownField, UUID, type Ctx, type Deps, type Tx } from './masters.service.js';
import { createRevisionService } from './revision.service.js';

interface Fam { readonly entity: 'reference_range' | 'critical_limit'; readonly set: repo.RangeSetTable; readonly band: repo.RangeBandTable; readonly ref: boolean; readonly codes: 'normal_codes' | 'abnormal_codes' }
const REF: Fam = { entity: 'reference_range', set: 'reference_range_sets', band: 'reference_ranges', ref: true, codes: 'normal_codes' };
const CRIT: Fam = { entity: 'critical_limit', set: 'critical_limit_sets', band: 'critical_limits', ref: false, codes: 'abnormal_codes' };

const SET_COLS = ['id', 'analyte_id', 'version_no', 'status', 'unit_code', 'method_id', 'effective_from', 'effective_to', 'change_reason', 'version'];
const AGE_COLS = ['age_low_value', 'age_low_unit', 'age_high_value', 'age_high_unit'];
const bandCols = (f: Fam) => (f.ref ? ['sex', ...AGE_COLS, 'specimen_type_id', 'kind', 'low', 'high', 'normal_codes', 'display_text', 'sort_order']
  : ['sex', ...AGE_COLS, 'specimen_type_id', 'low', 'high', 'abnormal_codes', 'sort_order']);
const BAND_KEYS = (f: Fam) => (f.ref ? ['sex', 'age_low', 'age_high', 'specimen_type_id', 'kind', 'low', 'high', 'normal_codes', 'display_text', 'sort_order']
  : ['sex', 'age_low', 'age_high', 'specimen_type_id', 'low', 'high', 'abnormal_codes']);
const STATUSES = ['draft', 'published', 'superseded', 'retired', 'discarded'];
const UNITS = ['day', 'week', 'month', 'year'];
const DEC = /^-?[0-9]+(\.[0-9]+)?$/, CODE = /^[A-Z0-9_+\-]{1,16}$/, ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BACKDATE_TOLERANCE_MS = 300_000;                                     // AB-18 / AC-03.3
const MAX_BANDS = 100;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const checkId = (v: unknown, path = '/id'): string => (isUuid(v) ? v : fail([invalid(path)]));
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const places = (s: string) => (s.split('.')[1] ?? '').length;

/** Signed decimal strings compared exactly (no float): -1 | 0 | 1. */
function cmpDec(a: string, b: string): number {
  const p = (s: string) => { const [i = '', f = ''] = s.replace('-', '').split('.'); return { neg: s.startsWith('-'), i, f }; };
  const x = p(a), y = p(b), n = Math.max(x.f.length, y.f.length);
  const bx = BigInt((x.neg ? '-' : '') + x.i + x.f.padEnd(n, '0')), by = BigInt((y.neg ? '-' : '') + y.i + y.f.padEnd(n, '0'));
  return bx < by ? -1 : bx > by ? 1 : 0;
}

const pgCode = (e: unknown) => (e as { code?: unknown })?.code;
/** 23505 -> a lost draft / numbering race; 23503 -> not found in this tenant (S-1: analyte, method, specimen type); P0001 -> immutable row (AB-9 DB backstop). */
function mapPg(e: unknown): never {
  const c = pgCode(e);
  if (c === '23505') throw new LimsError('common.version_conflict');
  if (c === '23503') throw new LimsError('common.not_found');
  if (c === 'P0001') throw new LimsError('catalog.version_in_use');
  throw e;
}

/** One age bound -> its two columns. */
function checkAge(v: unknown, min: number, path: string, errors: FieldError[]): [number, string] | undefined {
  if (!isObj(v) || Object.keys(v).some((k) => k !== 'value' && k !== 'unit') || !Number.isInteger(v['value']) || (v['value'] as number) < min || (v['value'] as number) > 200
    || typeof v['unit'] !== 'string' || !UNITS.includes(v['unit'])) { errors.push(invalid(path)); return undefined; }
  return [v['value'] as number, v['unit']];
}

/** One DTO band -> the columns to store (nulls explicit); errors are appended with the band's JSON pointer. `pos` = array position (critical sort_order). */
function checkBand(f: Fam, b: unknown, p: string, pos: number, errors: FieldError[]): Record<string, unknown> | undefined {
  if (!isObj(b)) { errors.push(invalid(p)); return undefined; }
  const start = errors.length, keys = BAND_KEYS(f);
  for (const k of Object.keys(b)) if (b[k] !== undefined && !keys.includes(k)) errors.push(unknownField(p + ptr(k)));
  const g = (k: string) => (keys.includes(k) ? b[k] : undefined);
  if (g('sex') === undefined) errors.push(required(`${p}/sex`)); else if (!['any', 'male', 'female'].includes(g('sex') as string)) errors.push(invalid(`${p}/sex`));
  const lo = g('age_low') === undefined ? undefined : checkAge(g('age_low'), 0, `${p}/age_low`, errors);
  const hi = g('age_high') === undefined ? undefined : checkAge(g('age_high'), 1, `${p}/age_high`, errors);   // DB CHECK age_high BETWEEN 1 AND 200
  const specimen = g('specimen_type_id');
  if (specimen !== undefined && !isUuid(specimen)) errors.push(invalid(`${p}/specimen_type_id`));
  const dec = (k: 'low' | 'high') => { const v = g(k); if (v === undefined) return undefined; if (typeof v === 'string' && v.length <= 40 && DEC.test(v)) return v; errors.push(invalid(`${p}/${k}`)); return undefined; };
  const low = dec('low'), high = dec('high');
  if (low !== undefined && high !== undefined && cmpDec(low, high) > 0) errors.push(invalid(`${p}/low`));
  const codesRaw = g(f.codes);
  let codes: string[] | undefined;
  if (codesRaw !== undefined) {
    if (Array.isArray(codesRaw) && codesRaw.length <= 20 && codesRaw.every((c) => typeof c === 'string' && CODE.test(c))) codes = codesRaw as string[];
    else errors.push(invalid(`${p}/${f.codes}`));
  }
  const out: Record<string, unknown> = {
    sex: g('sex'), age_low_value: lo?.[0] ?? null, age_low_unit: lo?.[1] ?? null, age_high_value: hi?.[0] ?? null, age_high_unit: hi?.[1] ?? null,
    specimen_type_id: specimen ?? null, low: low ?? null, high: high ?? null, [f.codes]: codes ?? null, sort_order: pos,
  };
  if (f.ref) {
    const kind = g('kind'), text = g('display_text'), order = g('sort_order');
    if (kind === undefined) errors.push(required(`${p}/kind`)); else if (!['numeric', 'text', 'ordinal'].includes(kind as string)) errors.push(invalid(`${p}/kind`));
    if (order === undefined) errors.push(required(`${p}/sort_order`)); else if (!Number.isInteger(order) || (order as number) < 0 || (order as number) > 9999) errors.push(invalid(`${p}/sort_order`));
    else out['sort_order'] = order;
    if (text !== undefined && !(typeof text === 'string' && text.length <= 500)) errors.push(invalid(`${p}/display_text`));
    if (kind === 'numeric') { if (low === undefined && high === undefined) errors.push(invalid(`${p}/low`)); }
    else if (kind === 'text' || kind === 'ordinal') {
      if (low !== undefined || high !== undefined) errors.push(invalid(`${p}/low`));
      if (text === undefined || text === '') errors.push(required(`${p}/display_text`));
      if (kind === 'ordinal' && !codes?.length) errors.push(required(`${p}/normal_codes`));
    }
    out['kind'] = kind; out['display_text'] = typeof text === 'string' ? text : null;
  } else if (low === undefined && high === undefined && !codes?.length) errors.push(invalid(p));        // critical_limits__something__ck
  return errors.length === start ? out : undefined;
}

function checkBands(f: Fam, v: unknown, min: number): Record<string, unknown>[] {
  if (!Array.isArray(v) || v.length < min || v.length > MAX_BANDS) return fail([invalid('/bands')]);
  const errors: FieldError[] = [];
  const rows = v.map((b, i) => checkBand(f, b, `/bands/${i}`, i, errors));
  if (errors.length) fail(errors.slice(0, 50));
  return rows as Record<string, unknown>[];
}

export function createRangesService(deps: Deps) {
  const revision = createRevisionService(deps);
  const nowIso = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();

  const bandDto = (f: Fam, r: any) => compact({
    sex: r.sex, age_low: r.age_low_value != null ? { value: Number(r.age_low_value), unit: r.age_low_unit } : undefined,
    age_high: r.age_high_value != null ? { value: Number(r.age_high_value), unit: r.age_high_unit } : undefined,
    specimen_type_id: r.specimen_type_id, kind: f.ref ? r.kind : undefined, low: r.low != null ? String(r.low) : undefined, high: r.high != null ? String(r.high) : undefined,
    [f.codes]: r[f.codes], display_text: f.ref ? r.display_text : undefined, sort_order: f.ref ? Number(r.sort_order) : undefined,
  });
  const setDto = (f: Fam, s: any, bands: any[]) => compact({
    id: s.id, analyte_id: s.analyte_id, version_no: Number(s.version_no), status: s.status, unit_code: s.unit_code, method_id: s.method_id,
    effective_from: s.effective_from != null ? iso(s.effective_from) : undefined, effective_to: s.effective_to != null ? iso(s.effective_to) : undefined,
    change_reason: s.change_reason, bands: bands.map((b) => bandDto(f, b)), version: Number(s.version),
  });

  const bandRows = (ctx: Ctx, f: Fam, setIds: readonly string[]): Promise<any[]> =>
    setIds.length ? repo.find(ctx.tx as Tx, f.band, ['id', 'set_id', ...bandCols(f)], ctx.tenantId, {}, { anyOf: { col: 'set_id', values: setIds }, order: 'sort_order, id' }) : Promise.resolve([]);
  async function dtos(ctx: Ctx, f: Fam, sets: any[]) {
    const bands = await bandRows(ctx, f, sets.map((s) => s.id));
    return sets.map((s) => setDto(f, s, bands.filter((b) => b.set_id === s.id)));
  }
  const view = async (ctx: Ctx, f: Fam, id: string) => {
    const [s] = await repo.find(ctx.tx as Tx, f.set, SET_COLS, ctx.tenantId, { id });
    if (!s) throw new LimsError('common.not_found');
    return (await dtos(ctx, f, [s]))[0]!;
  };
  const insertBands = (ctx: Ctx, f: Fam, setId: string, rows: Record<string, unknown>[]) =>
    repo.insert(ctx.tx as Tx, f.band, rows.map((r) => ({ id: uuidv7(), tenant_id: ctx.tenantId, set_id: setId, ...r, created_by: ctx.actor.id })), ['created_at']).catch(mapPg);
  const updateSet = (ctx: Ctx, f: Fam, id: string, expected: number, patch: Record<string, unknown>) =>
    repo.update(ctx.tx as Tx, f.set, SET_COLS, { tenantId: ctx.tenantId, id, actorId: ctx.actor.id, expectedVersion: expected }, patch).catch(mapPg)
      .then((row) => { if (!row) throw new LimsError('common.version_conflict'); return row; });

  /** Locks the owning test's orderable (404 if the test is absent / a panel / another tenant's). */
  async function lockOwner(ctx: Ctx, testId: string) {
    const [o] = await repo.find(ctx.tx as Tx, 'orderables', ['id'], ctx.tenantId, { id: testId, kind: 'test' }, { lock: true });
    if (!o) throw new LimsError('common.not_found');
  }
  /**
   * Finds a set and row-locks it; state outranks If-Match (wrong status -> catalog.version_in_use, then stale -> version_conflict). With `owner`, the owning test's
   * orderable and the analyte are locked first (publish / retire bump the revision and stamp that test).
   */
  async function open(ctx: Ctx, f: Fam, id: string, ev: number, want: 'draft' | 'published', owner: boolean) {
    const tx = ctx.tx as Tx, t = ctx.tenantId;
    const [probe] = await repo.find(tx, f.set, ['analyte_id'], t, { id });
    if (!probe) throw new LimsError('common.not_found');
    let testId: string | undefined;
    if (owner) {
      const [a] = await repo.find(tx, 'analytes', ['id', 'test_id'], t, { id: probe.analyte_id });
      if (!a) throw new LimsError('common.not_found');
      await lockOwner(ctx, a.test_id);
      await repo.find(tx, 'analytes', ['id'], t, { id: a.id }, { lock: true });
      testId = a.test_id as string;
    }
    const [set] = await repo.find(tx, f.set, SET_COLS, t, { id }, { lock: true });
    if (!set) throw new LimsError('common.not_found');
    if (set.status !== want) throw new LimsError('catalog.version_in_use');
    if (Number(set.version) !== ev) throw new LimsError('common.version_conflict');
    return { set, testId: testId! };
  }
  const bump = (ctx: Ctx, f: Fam, setId: string, testId: string, effectiveFrom: string) =>
    revision.bumpRevision(ctx, { entityType: f.entity, entityId: setId, changeKind: 'versioned', effectiveFrom, stampOrderableId: testId });

  function family(f: Fam) {
    return {
      async list(ctx: Ctx, input: { analyte_id?: unknown; status?: unknown } = {}) {
        const analyteId = checkId(input.analyte_id, '/analyte_id');
        if (input.status !== undefined && !(typeof input.status === 'string' && STATUSES.includes(input.status))) fail([invalid('/status')]);
        const tx = ctx.tx as Tx, t = ctx.tenantId;
        const [a] = await repo.find(tx, 'analytes', ['id'], t, { id: analyteId });
        if (!a) throw new LimsError('common.not_found');
        const sets = await repo.find(tx, f.set, SET_COLS, t, { analyte_id: analyteId, ...(input.status === undefined ? {} : { status: input.status }) }, { order: 'version_no DESC', limit: 200 });
        return { data: await dtos(ctx, f, sets) };
      },

      async get(ctx: Ctx, input: { id?: unknown } = {}) { return view(ctx, f, checkId(input.id)); },

      /** V1 — one open draft per analyte; unit / method snapshot from the analyte's open draft version, else its published one; numbered max+1 over all statuses. */
      async create(ctx: Ctx, input: { analyte_id?: unknown; body?: unknown } = {}) {
        const analyteId = checkId(input.analyte_id, '/analyte_id');
        const body = checkFields({ fields: {} }, input.body === undefined ? {} : input.body, ['bands', 'copy_from_set_id']);
        const errors: FieldError[] = [];
        if (body['copy_from_set_id'] !== undefined && !isUuid(body['copy_from_set_id'])) errors.push(invalid('/copy_from_set_id'));
        if (body['bands'] !== undefined && body['copy_from_set_id'] !== undefined) errors.push(invalid('/copy_from_set_id'));
        if (errors.length) fail(errors);
        const bands = body['bands'] === undefined ? undefined : checkBands(f, body['bands'], 0);
        const tx = ctx.tx as Tx, t = ctx.tenantId;
        const [a] = await repo.find(tx, 'analytes', ['id'], t, { id: analyteId }, { lock: true });
        if (!a) throw new LimsError('common.not_found');
        const [open] = await repo.find(tx, f.set, ['id'], t, { analyte_id: analyteId, status: 'draft' }, { limit: 1 });
        if (open) throw new LimsError('common.version_conflict');
        const [last] = await repo.find(tx, f.set, ['version_no'], t, { analyte_id: analyteId }, { order: 'version_no DESC', limit: 1 });
        const vcols = ['unit_code', 'method_id'];
        const [draftV] = await repo.find(tx, 'analyte_versions', vcols, t, { analyte_id: analyteId, status: 'draft' }, { limit: 1 });
        const [snap] = draftV ? [draftV] : await repo.find(tx, 'analyte_versions', vcols, t, { analyte_id: analyteId, status: 'published' }, { order: 'version_no DESC', limit: 1 });

        let rows = bands;
        // V1: copy from `copy_from_set_id`, else (no bands given) from the latest published set; none -> empty draft.
        let srcId: string | undefined;
        if (body['copy_from_set_id'] !== undefined) {
          const [src] = await repo.find(tx, f.set, ['id', 'analyte_id'], t, { id: body['copy_from_set_id'] });
          if (!src) throw new LimsError('common.not_found');
          if (src.analyte_id !== analyteId) fail([invalid('/copy_from_set_id')]);
          srcId = src.id as string;
        } else if (bands === undefined) {
          const [pub] = await repo.find(tx, f.set, ['id'], t, { analyte_id: analyteId, status: 'published' }, { order: 'version_no DESC', limit: 1 });
          srcId = pub?.id as string | undefined;
        }
        if (srcId) rows = (await bandRows(ctx, f, [srcId])).map((r) => Object.fromEntries(bandCols(f).map((c) => [c, r[c] ?? null])));
        const id = uuidv7(), actor = ctx.actor.id;
        await repo.insert(tx, f.set, [{ id, tenant_id: t, created_by: actor, updated_by: actor, analyte_id: analyteId, version_no: Number(last?.version_no ?? 0) + 1, status: 'draft',
          unit_code: snap?.unit_code ?? null, method_id: snap?.method_id ?? null, version: 1 }], ['created_at', 'updated_at']).catch(mapPg);
        if (rows?.length) await insertBands(ctx, f, id, rows);
        return view(ctx, f, id);
      },

      /** V2 — replaces ALL bands of the draft in one transaction. Overlap and precision are publish rules, so a draft may be work in progress. */
      async replace(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
        const { id, ev } = checkUpdate(input);
        const rows = checkBands(f, checkFields({ fields: {} }, input.body, ['bands'])['bands'], 1);
        await open(ctx, f, id, ev, 'draft', false);
        await repo.deleteBands(ctx.tx as Tx, f.band, ctx.tenantId, id);
        await insertBands(ctx, f, id, rows);
        await updateSet(ctx, f, id, ev, {});
        return view(ctx, f, id);
      },

      /** V4 + V5 — validates the draft (TRD §7.3 step 6), ends the predecessor's window at the new effective_from, bumps once. */
      async publish(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
        const { id, ev } = checkUpdate(input);
        const b = checkFields({ fields: { change_reason: str(1, 500) } }, input.body, ['effective_from']);
        const errors: FieldError[] = [];
        if (b['change_reason'] === undefined) errors.push(required('/change_reason'));
        if (b['effective_from'] !== undefined && !isIso(b['effective_from'])) errors.push(invalid('/effective_from'));
        if (errors.length) fail(errors);
        const now = nowIso(ctx);
        const effective = (b['effective_from'] as string | undefined) ?? now;

        const { set, testId } = await open(ctx, f, id, ev, 'draft', true);
        if (Date.parse(effective) < Date.parse(now) - BACKDATE_TOLERANCE_MS) fail([invalid('/effective_from')]);
        await publishDraft(ctx, f, set, ev, effective, now, b['change_reason'] as string, testId);
        return view(ctx, f, id);
      },

      /**
       * T-09 — one member of the publish bundle (analyteVersions.service #34): the caller holds the owner / analyte locks and has already published the analyte version,
       * so the T-08 rules below compare against it. A set that is not a draft of THIS analyte, or whose unit / method differ from the version, is refused at `path`.
       */
      async publishInBundle(ctx: Ctx, id: string, a: { path: string; analyteId: string; unit_code: unknown; method_id: unknown; effective: string; now: string; reason: string; testId: string }) {
        const [set] = await repo.find(ctx.tx as Tx, f.set, SET_COLS, ctx.tenantId, { id }, { lock: true });
        if (!set) throw new LimsError('common.not_found');
        if (set.analyte_id !== a.analyteId) fail([invalid(a.path)]);
        if (set.status !== 'draft') throw new LimsError('catalog.version_in_use');
        if ((set.unit_code ?? null) !== (a.unit_code ?? null) || (set.method_id ?? null) !== (a.method_id ?? null)) fail([invalid(a.path)]);
        await publishDraft(ctx, f, set, Number(set.version), a.effective, a.now, a.reason, a.testId);
      },

      /** V6 — ends a published set at effective_at (default now). change_reason is required, but the published row's own change_reason is immutable (DB trigger) and stays. */
      async retire(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
        const { id, ev } = checkUpdate(input);
        const b = checkFields({ fields: { change_reason: str(1, 500) } }, input.body, ['effective_at']);
        const errors: FieldError[] = [];
        if (b['change_reason'] === undefined) errors.push(required('/change_reason'));
        if (b['effective_at'] !== undefined && !isIso(b['effective_at'])) errors.push(invalid('/effective_at'));
        if (errors.length) fail(errors);
        const now = nowIso(ctx);
        const at = (b['effective_at'] as string | undefined) ?? now;
        const { set, testId } = await open(ctx, f, id, ev, 'published', true);
        if (Date.parse(at) < Date.parse(now) - BACKDATE_TOLERANCE_MS || Date.parse(at) < +new Date(set.effective_from)) fail([invalid('/effective_at')]);   // the second guard = window CHECK
        await updateSet(ctx, f, id, ev, { status: 'retired', effective_to: new Date(at) });
        await bump(ctx, f, id, testId, at);
        return view(ctx, f, id);
      },

      /** V3 — a draft becomes `discarded` (bands retained); no event. */
      async discard(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown } = {}) {
        const { id, ev } = checkUpdate(input);
        await open(ctx, f, id, ev, 'draft', false);
        await updateSet(ctx, f, id, ev, { status: 'discarded' });
        return view(ctx, f, id);
      },
    };
  }

  /** V4 + V5 body shared by publish and the bundle: validates the locked draft `set` (TRD §7.3 step 6), ends the predecessor's window, bumps once. */
  async function publishDraft(ctx: Ctx, f: Fam, set: any, ev: number, effective: string, now: string, reason: string, testId: string) {
    const tx = ctx.tx as Tx, t = ctx.tenantId, id = set.id as string;
    {
        // V4: strictly after every effective sibling's start, and not before a retired sibling's end (a retired set is never superseded, but its window is taken).
        const siblings = (await repo.find(tx, f.set, SET_COLS, t, { analyte_id: set.analyte_id }, { lock: true })).filter((s) => s.id !== id && ['published', 'superseded', 'retired'].includes(s.status));
        const e = Date.parse(effective);
        if (siblings.some((s) => e <= +new Date(s.effective_from) || (s.status === 'retired' && s.effective_to != null && e < +new Date(s.effective_to)))) fail([invalid('/effective_from')]);

        const bands = await bandRows(ctx, f, [id]);
        const [av] = await repo.find(tx, 'analyte_versions', ['unit_code', 'method_id', 'decimals', 'value_set_code'], t, { analyte_id: set.analyte_id, status: 'published' }, { order: 'version_no DESC', limit: 1 });
        const bad = new Map<string, FieldError>();
        const flag = (path: string) => bad.set(path, invalid(path));
        if (!bands.length) bad.set('/bands', required('/bands'));
        // AC-05.10 data side. ponytail: an analyte without a published version has nothing to compare with (nothing resolves for it either), so the snapshot check is skipped.
        if (av && (set.unit_code ?? null) !== (av.unit_code ?? null)) flag('/unit_code');
        if (av && (set.method_id ?? null) !== (av.method_id ?? null)) flag('/method_id');
        const known = new Map<string, Set<string> | undefined>();
        for (const [i, r] of bands.entries()) {
          if (av?.decimals != null) for (const k of ['low', 'high']) if (r[k] != null && places(String(r[k])) > Number(av.decimals) + 2) flag(`/bands/${i}/${k}`);
          const codes = r[f.codes] as string[] | null;
          if (codes?.length) {
            const vs = av?.value_set_code as string | undefined;
            if (vs && !known.has(vs)) known.set(vs, await arepo.valueSetCodes(tx, t, vs));
            const allowed = vs ? known.get(vs) : undefined;
            if (!allowed || codes.some((c) => !allowed.has(c))) flag(`/bands/${i}/${f.codes}`);
          }
        }
        for (const [i, j] of findOverlaps(bands)) { flag(`/bands/${i}`); flag(`/bands/${j}`); }
        if (bad.size) fail([...bad.values()].sort((x, y) => (x.path < y.path ? -1 : 1)).slice(0, 50));

        const pred = siblings.find((s) => s.status === 'published');
        if (pred) await updateSet(ctx, f, pred.id, Number(pred.version), { status: 'superseded', effective_to: new Date(effective) });
        await updateSet(ctx, f, id, ev, { status: 'published', effective_from: new Date(effective), published_at: new Date(now), published_by: ctx.actor.id, change_reason: reason });
        await bump(ctx, f, id, testId, effective);
    }
  }

  const r = family(REF), c = family(CRIT);
  return {
    publishReferenceRangeSetInBundle: r.publishInBundle, publishCriticalLimitSetInBundle: c.publishInBundle,   // T-09, called by analyteVersions.service only
    listReferenceRangeSets: r.list, createReferenceRangeSetDraft: r.create, getReferenceRangeSet: r.get, replaceReferenceRangeSetBands: r.replace,
    publishReferenceRangeSet: r.publish, retireReferenceRangeSet: r.retire, discardReferenceRangeSetDraft: r.discard,
    listCriticalLimitSets: c.list, createCriticalLimitSetDraft: c.create, getCriticalLimitSet: c.get, replaceCriticalLimitSetBands: c.replace,
    publishCriticalLimitSet: c.publish, retireCriticalLimitSet: c.retire, discardCriticalLimitSetDraft: c.discard,
  };
}
