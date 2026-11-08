// Analytes + analyte versions #29–#35 (02-TRD §5.2, §3, §9.1; 05-SCHEMA §10.2; PRD AC-02.2/02.3/02.6, AC-03.1–03.5; 07-SECURITY S-1, S-5, AB-9, AB-20).
// Formula validation (T-11) lives in formulas.service.ts; attaching reference-range / critical-limit sets at publish is T-08/T-09. Validates its own input.
// Permissions are the handler's. Bumps (created / updated / deactivated / versioned) stamp the OWNING test's orderable; draft writes bump nothing.
// Lock order: owning test's orderable, analyte, analyte version(s), then catalog_state (via bumpRevision) — same prefix as tests.service
// (orderables first), so analyte writes cannot deadlock with test writes. Draft-only writes skip the orderable lock.
// [CONV] uuidv7 via relative import until @lims/shared-ts is a services/api dependency (same as tests.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import * as arepo from '../repo/analytes.repo.js';
import * as repo from '../repo/tests.repo.js';
import { BOOL, checkFields, checkUpdate, fail, invalid, isObj, required, str, UUID, type Field } from './masters.service.js';
import { checkFormula, formulaInvalid, lockFormulaGraph } from './formulas.service.js';
import { createRangesService } from './ranges.service.js';
import { createRevisionService } from './revision.service.js';

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Ctx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly requestId: string; readonly tx: unknown; readonly now?: () => string }
interface Deps { events: { publish(ctx: unknown, type: string, input: object): Promise<unknown> } }

const AN_COLS = ['id', 'test_id', 'code', 'name', 'print_name', 'report_subheading', 'sort_order', 'is_reportable', 'is_active', 'version'];
const AV_COLS = ['id', 'analyte_id', 'version_no', 'status', 'result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'formula_inputs',
  'effective_from', 'effective_to', 'change_reason', 'version'];
const CLINICAL = ['result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression'] as const;
const RESULT_TYPES = ['numeric', 'text', 'ordinal', 'coded', 'attachment', 'narrative'];
const UNSET = ['unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression'];
const NARRATIVE_WORKFLOWS = ['narrative', 'microbiology', 'anatomic', 'molecular'];
const BACKDATE_TOLERANCE_MS = 300_000;                                     // AC-03.3
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CODE_IN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;                           // checked BEFORE upper-casing: no Unicode case-fold forgeries (ı -> I)
const UNIT_RE = /^[A-Za-z0-9_]{1,32}$/, VALUE_SET_RE = /^[A-Z0-9_]{1,32}$/;

const INT = (min: number, max: number): Field => ({ t: 'int', min, max });
const UUID_F: Field = { t: 'uuid' };
const ANALYTE_FIELDS = { name: str(1, 120), print_name: str(0, 120), report_subheading: str(0, 80), sort_order: INT(0, 9999), is_reportable: BOOL };
const VERSION_FIELDS = { unit_code: str(1, 32), decimals: INT(0, 6), method_id: UUID_F, value_set_code: str(1, 32), formula_expression: str(1, 500) };
const PUBLISH_FIELDS = { change_reason: str(1, 500), reference_range_set_id: UUID_F, critical_limit_set_id: UUID_F, allow_without_ranges: BOOL };

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const checkId = (v: unknown, path = '/id'): string => (isUuid(v) ? v : fail([invalid(path)]));
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
const pick = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
/** A UTC-ms ISO string that round-trips (rejects 2026-13-01 and other overflowing dates). */
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;

/** 23505 -> code clash (analytes) or a lost draft/numbering race (versions); 23503 -> not found in this tenant (S-1); P0001 -> immutable row (AB-9 DB backstop). */
const pgCode = (e: unknown) => (e as { code?: unknown })?.code;
const pgConstraint = (e: unknown) => String((e as { constraint?: unknown })?.constraint ?? '');
function mapPg(e: unknown): never {
  const c = pgCode(e);
  if (c === '23505') throw new LimsError(pgConstraint(e).startsWith('analytes__') ? 'catalog.code_duplicate' : 'common.version_conflict');
  if (c === '23503') throw new LimsError('common.not_found');
  if (c === 'P0001') throw new LimsError('catalog.version_in_use');
  throw e;
}

/** AC-02.6 on the effective version fields: numeric needs decimals 0-6; ordinal/coded need an existing value set, ordinal an ORDERED one. */
async function clinicalErrors(tx: Tx, tenantId: string, v: Record<string, any>, prefix: string): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  if (v['result_type'] === 'numeric' && v['decimals'] == null) errors.push(required(`${prefix}/decimals`));
  if (v['result_type'] === 'ordinal' || v['result_type'] === 'coded') {
    if (v['value_set_code'] == null) errors.push(required(`${prefix}/value_set_code`));
    else {
      const ordered = await arepo.valueSetOrdered(tx, tenantId, v['value_set_code']);
      if (ordered === undefined || (v['result_type'] === 'ordinal' && !ordered)) errors.push(invalid(`${prefix}/value_set_code`));
    }
  }
  return errors;
}

export function createAnalyteVersionsService(deps: Deps) {
  const revision = createRevisionService(deps);
  const ranges = createRangesService(deps);
  const nowIso = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, analyte: { id: string; test_id: string }, changeKind: string, effectiveFrom = nowIso(ctx)) =>
    revision.bumpRevision(ctx, { entityType: 'analyte', entityId: analyte.id, changeKind, effectiveFrom, stampOrderableId: analyte.test_id });

  const versionDto = (v: any) => {
    const out = compact(Object.fromEntries(AV_COLS.map((c) => [c, v[c]])));
    const inputs = out['formula_inputs']; delete out['formula_inputs'];
    if (Array.isArray(inputs) && inputs.length) out['formula_input_codes'] = inputs;
    for (const k of ['effective_from', 'effective_to']) if (out[k] != null) out[k] = iso(out[k]);
    for (const k of ['version_no', 'decimals', 'version']) if (out[k] != null) out[k] = Number(out[k]);
    return out;
  };
  const analyteDto = (a: any, current?: any, draftId?: string) => compact({
    ...pick(a, AN_COLS), sort_order: Number(a.sort_order), version: Number(a.version), is_reportable: a.is_reportable === true, is_active: a.is_active === true,
    current_version: current ? versionDto(current) : undefined, draft_version_id: draftId,
  });

  /** Analyte + current version at `asOf` + open draft (+ up to 50 versions, newest first). Reads only. */
  async function view(ctx: Ctx, id: string, asOf: Date) {
    const tx = ctx.tx as Tx, t = ctx.tenantId;
    const [a] = await repo.find(tx, 'analytes', AN_COLS, t, { id });
    if (!a) throw new LimsError('common.not_found');
    const shown = await repo.analyteVersions(tx, AV_COLS, t, [id], asOf);
    const current = shown.filter((v) => v.status !== 'draft').sort((x, y) => Number(y.version_no) - Number(x.version_no))[0];
    const draft = shown.find((v) => v.status === 'draft');
    return { a, current, draftId: draft?.id as string | undefined };
  }
  const detail = async (ctx: Ctx, id: string, asOf: Date) => {
    const { a, current, draftId } = await view(ctx, id, asOf);
    const versions = await repo.find(ctx.tx as Tx, 'analyte_versions', AV_COLS, ctx.tenantId, { analyte_id: id }, { order: 'version_no DESC', limit: 50 });
    return { ...analyteDto(a, current, draftId), versions: versions.map(versionDto) };
  };
  const summary = async (ctx: Ctx, id: string) => { const { a, current, draftId } = await view(ctx, id, new Date(nowIso(ctx))); return analyteDto(a, current, draftId); };

  /** Locks the owning test's orderable (404 if the test is absent / a panel / another tenant's). */
  const lockOwner = async (ctx: Ctx, testId: string) => {
    const [o] = await repo.find(ctx.tx as Tx, 'orderables', ['id'], ctx.tenantId, { id: testId, kind: 'test' }, { lock: true });
    if (!o) throw new LimsError('common.not_found');
  };
  /** Version row -> its analyte, plain reads (the owning test must be known before the locks are taken). */
  async function ownerOfVersion(ctx: Ctx, versionId: string) {
    const [v] = await repo.find(ctx.tx as Tx, 'analyte_versions', ['analyte_id'], ctx.tenantId, { id: versionId });
    if (!v) throw new LimsError('common.not_found');
    const [a] = await repo.find(ctx.tx as Tx, 'analytes', ['id', 'test_id', 'code'], ctx.tenantId, { id: v.analyte_id });
    if (!a) throw new LimsError('common.not_found');
    return a as { id: string; test_id: string; code: string };
  }
  /** Row-locks a version and re-reads it; a draft only, at the expected version (state errors outrank the If-Match mismatch). */
  async function lockDraft(ctx: Ctx, id: string, expected: number) {
    const [v] = await repo.find(ctx.tx as Tx, 'analyte_versions', AV_COLS, ctx.tenantId, { id }, { lock: true });
    if (!v) throw new LimsError('common.not_found');
    if (v.status !== 'draft') throw new LimsError('catalog.version_in_use');
    if (Number(v.version) !== expected) throw new LimsError('common.version_conflict');
    return v;
  }
  const updateVersion = (ctx: Ctx, id: string, expected: number, patch: Record<string, unknown>) =>
    repo.update(ctx.tx as Tx, 'analyte_versions', AV_COLS, { tenantId: ctx.tenantId, id, actorId: ctx.actor.id, expectedVersion: expected }, patch).catch(mapPg)
      .then((row) => { if (!row) throw new LimsError('common.version_conflict'); return row; });

  /** Version-field part of a body (create: result_type required; prefix '/initial_version'). */
  function versionInput(input: unknown, prefix: string, requireType: boolean): Record<string, unknown> {
    const v = checkFields({ fields: VERSION_FIELDS }, input, ['result_type'], prefix);
    const errors: FieldError[] = [];
    if (v['result_type'] === undefined) { if (requireType) errors.push(required(`${prefix}/result_type`)); }
    else if (!RESULT_TYPES.includes(v['result_type'] as string)) errors.push(invalid(`${prefix}/result_type`));
    if (v['unit_code'] !== undefined && !UNIT_RE.test(v['unit_code'] as string)) errors.push(invalid(`${prefix}/unit_code`));
    if (v['value_set_code'] !== undefined && !VALUE_SET_RE.test(v['value_set_code'] as string)) errors.push(invalid(`${prefix}/value_set_code`));
    if (errors.length) fail(errors);
    return v;
  }

  /** One formula_dependencies edge per input analyte of the validated formula (T-11 resolved them tenant-wide; TRD §7.2 step 6). */
  const writeFormulaEdges = (ctx: Ctx, analyteId: string, versionId: string, inputIds: readonly string[]) =>
    repo.insert(ctx.tx as Tx, 'formula_dependencies', inputIds.map((input) => ({ tenant_id: ctx.tenantId, analyte_version_id: versionId, analyte_id: analyteId, input_analyte_id: input, created_by: ctx.actor.id })), ['created_at']);

  /** Validates the formula a version would store: 422 catalog.formula_invalid (paths under `prefix`), else the normalised expression, inputs and units. */
  async function validated(ctx: Ctx, code: string, v: Record<string, any>, prefix: string) {
    const f = await checkFormula(ctx, { expression: v['formula_expression'], code, targetType: v['result_type'] });
    if (f.errors.length) throw formulaInvalid(f.errors.map((e) => ({ ...e, path: prefix + e.path })));
    return f;
  }

  return {
    /** #29 */
    async createAnalyte(ctx: Ctx, input: { test_id?: unknown; body?: unknown } = {}) {
      const testId = checkId(input.test_id, '/test_id');
      const b = checkFields({ fields: ANALYTE_FIELDS }, input.body, ['code', 'initial_version']);
      const errors: FieldError[] = [];
      let code: string | undefined;
      if (b['code'] === undefined) errors.push(required('/code'));
      else if (typeof b['code'] === 'string' && CODE_IN.test(b['code'].trim())) code = b['code'].trim().toUpperCase();
      else errors.push(invalid('/code'));
      if (b['name'] === undefined) errors.push(required('/name'));
      if (b['initial_version'] === undefined) errors.push(required('/initial_version'));
      if (errors.length) fail(errors);
      const iv = versionInput(b['initial_version'], '/initial_version', true);
      const tx = ctx.tx as Tx, t = ctx.tenantId, actor = ctx.actor.id;
      const vErrors = await clinicalErrors(tx, t, iv, '/initial_version');
      if (vErrors.length) fail(vErrors);
      const formula = iv['formula_expression'] != null ? await validated(ctx, code!, iv, '/initial_version') : undefined;

      await lockOwner(ctx, testId);
      const id = uuidv7(), who = { tenant_id: t, created_by: actor, updated_by: actor };
      await repo.insert(tx, 'analytes', [{ id, ...who, test_id: testId, code, name: b['name'], print_name: b['print_name'] ?? null, report_subheading: b['report_subheading'] ?? null,
        sort_order: b['sort_order'] ?? 100, is_reportable: b['is_reportable'] ?? true, is_active: true, version: 1 }], ['created_at', 'updated_at']).catch(mapPg);
      await repo.insert(tx, 'analyte_versions', [{ id: uuidv7(), ...who, analyte_id: id, version_no: 1, status: 'draft', result_type: iv['result_type'],
        unit_code: iv['unit_code'] ?? null, decimals: iv['decimals'] ?? null, method_id: iv['method_id'] ?? null, value_set_code: iv['value_set_code'] ?? null,
        formula_expression: formula?.normalised ?? null, formula_inputs: formula?.inputs ?? [], version: 1 }], ['created_at', 'updated_at']).catch(mapPg);
      await bump(ctx, { id, test_id: testId }, 'created');
      return summary(ctx, id);
    },

    /** #30 */
    async getAnalyte(ctx: Ctx, input: { id?: unknown; as_of?: unknown } = {}) {
      const id = checkId(input.id);
      const asOf = input.as_of === undefined ? nowIso(ctx) : input.as_of;
      if (!isIso(asOf)) fail([invalid('/as_of')]);
      return detail(ctx, id, new Date(asOf as string));
    },

    /** #31 — display attributes only; code and test_id never change. */
    async updateAnalyte(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const patch = checkFields({ fields: { ...ANALYTE_FIELDS, is_active: BOOL } }, input.patch, []);
      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const [probe] = await repo.find(tx, 'analytes', ['test_id'], t, { id });
      if (!probe) throw new LimsError('common.not_found');
      await lockOwner(ctx, probe.test_id);
      const [before] = await repo.find(tx, 'analytes', AN_COLS, t, { id }, { lock: true });
      if (!before) throw new LimsError('common.not_found');
      if (Number(before.version) !== ev) throw new LimsError('common.version_conflict');
      const after = await repo.update(tx, 'analytes', AN_COLS, { tenantId: t, id, actorId: ctx.actor.id, expectedVersion: ev }, patch).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, after, before.is_active === true && after.is_active === false ? 'deactivated' : 'updated');
      return summary(ctx, id);
    },

    /** #32 — one open draft per analyte (AC-03.4); copies the latest published version (or `copy_from_version_no`); numbered max+1 over all statuses. */
    async createAnalyteVersionDraft(ctx: Ctx, input: { analyte_id?: unknown; body?: unknown } = {}) {
      const analyteId = checkId(input.analyte_id, '/analyte_id');
      const body = checkFields({ fields: { copy_from_version_no: INT(1, 2147483647) } }, input.body === undefined ? {} : input.body, []);
      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const [a] = await repo.find(tx, 'analytes', ['id'], t, { id: analyteId }, { lock: true });
      if (!a) throw new LimsError('common.not_found');
      const [open] = await repo.find(tx, 'analyte_versions', ['id'], t, { analyte_id: analyteId, status: 'draft' }, { limit: 1 });
      if (open) throw new LimsError('common.version_conflict');
      const [last] = await repo.find(tx, 'analyte_versions', ['version_no'], t, { analyte_id: analyteId }, { order: 'version_no DESC', limit: 1 });
      const [source] = body['copy_from_version_no'] !== undefined
        ? await repo.find(tx, 'analyte_versions', AV_COLS, t, { analyte_id: analyteId, version_no: body['copy_from_version_no'] }, { limit: 1 })
        // ponytail: an analyte with no published version (only discarded ones) copies its newest version
        : (await repo.find(tx, 'analyte_versions', AV_COLS, t, { analyte_id: analyteId, status: 'published' }, { order: 'version_no DESC', limit: 1 }))
          .concat(await repo.find(tx, 'analyte_versions', AV_COLS, t, { analyte_id: analyteId }, { order: 'version_no DESC', limit: 1 }));
      if (!source) throw new LimsError('common.not_found');
      const row = { id: uuidv7(), tenant_id: t, created_by: ctx.actor.id, updated_by: ctx.actor.id, analyte_id: analyteId, version_no: Number(last?.version_no ?? 0) + 1,
        status: 'draft', ...Object.fromEntries(CLINICAL.map((c) => [c, source[c] ?? null])), formula_inputs: source.formula_inputs ?? [], version: 1 };
      await repo.insert(tx, 'analyte_versions', [row], ['created_at', 'updated_at']).catch(mapPg);
      return versionDto(row);
    },

    /** #33 — drafts only (AC-03.2; the DB trigger is the backstop); AC-02.6 on the resulting fields; `unset` clears optional fields. */
    async updateAnalyteVersionDraft(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const patch = versionInput(isObj(input.patch) ? { ...input.patch, unset: undefined } : input.patch, '', false);
      const unset: unknown = isObj(input.patch) ? input.patch['unset'] : undefined;
      if (unset !== undefined && !(Array.isArray(unset) && unset.length <= 5 && new Set(unset).size === unset.length && unset.every((k) => UNSET.includes(k)))) fail([invalid('/unset')]);
      const clear = (unset ?? []) as string[];
      if (clear.some((k) => patch[k] !== undefined)) fail([invalid('/unset')]);
      const tx = ctx.tx as Tx, t = ctx.tenantId;
      const owner = await ownerOfVersion(ctx, id);                     // the version's analyte must be visible to the tenant too (S-1)
      const before = await lockDraft(ctx, id, ev);
      const next = { ...before, ...patch, ...Object.fromEntries(clear.map((k) => [k, null])) };
      const errors = await clinicalErrors(tx, t, next, '');
      if (errors.length) fail(errors);
      const write: Record<string, unknown> = { ...patch, ...Object.fromEntries(clear.map((k) => [k, null])) };
      if (next['formula_expression'] == null) { if (clear.includes('formula_expression')) write['formula_inputs'] = []; }
      else if (patch['formula_expression'] !== undefined || patch['result_type'] !== undefined) {
        const f = await validated(ctx, owner.code, next, '');
        write['formula_expression'] = f.normalised; write['formula_inputs'] = f.inputs;
      }
      return versionDto(await updateVersion(ctx, id, ev, write));
    },

    /** #34 — V4 + V5: the published version ends the predecessor's window at its own effective_from; no back-dating (AC-03.3). */
    async publishAnalyteVersion(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; body?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const b = checkFields({ fields: PUBLISH_FIELDS }, input.body, ['effective_from']);
      const errors: FieldError[] = [];
      if (b['change_reason'] === undefined) errors.push(required('/change_reason'));
      if (b['effective_from'] !== undefined && !isIso(b['effective_from'])) errors.push(invalid('/effective_from'));
      if (errors.length) fail(errors);
      const tx = ctx.tx as Tx, t = ctx.tenantId, now = nowIso(ctx);
      const effective = (b['effective_from'] as string | undefined) ?? now;

      const owner = await ownerOfVersion(ctx, id);
      await lockOwner(ctx, owner.test_id);
      const [analyte] = await repo.find(tx, 'analytes', [...AN_COLS], t, { id: owner.id }, { lock: true });
      if (!analyte) throw new LimsError('common.not_found');
      const draft = await lockDraft(ctx, id, ev);

      if (Date.parse(effective) < Date.parse(now) - BACKDATE_TOLERANCE_MS) fail([invalid('/effective_from')]);
      const [pred] = await repo.find(tx, 'analyte_versions', AV_COLS, t, { analyte_id: owner.id, status: 'published' }, { order: 'version_no DESC', limit: 1, lock: true });
      if (pred && Date.parse(effective) <= +new Date(pred.effective_from)) fail([invalid('/effective_from')]);
      const vErrors = await clinicalErrors(tx, t, draft, '');
      if (vErrors.length) fail(vErrors);
      // AC-03.5: a unit/method change needs a reference-range set (published with the bundle below) or an explicit waiver.
      if (pred && b['reference_range_set_id'] === undefined && b['allow_without_ranges'] !== true
        && ((pred.unit_code ?? null) !== (draft.unit_code ?? null) || (pred.method_id ?? null) !== (draft.method_id ?? null))) fail([invalid('/reference_range_set_id')]);
      // AC-02.3: at most one active reportable narrative analyte on narrative-type workflows (other analytes only).
      if (draft.result_type === 'narrative' && analyte.is_active === true && analyte.is_reportable === true) {
        const [test] = await repo.find(tx, 'tests', ['workflow_type'], t, { id: owner.test_id });
        if (test && NARRATIVE_WORKFLOWS.includes(test.workflow_type)) {
          const others = (await repo.find(tx, 'analytes', ['id'], t, { test_id: owner.test_id, is_active: true, is_reportable: true })).map((r) => r.id).filter((x) => x !== owner.id);
          if ((await arepo.publishedResultTypes(tx, t, others)).some((r) => r.result_type === 'narrative')) fail([invalid('/result_type')]);
        }
      }

      // The formula is validated again at publish (a code may have gone inactive, a cycle may have appeared); the tenant lock makes two publishes see each other's edges (§7.2).
      let formula: Awaited<ReturnType<typeof validated>> | undefined;
      if (draft.formula_expression != null) {
        await lockFormulaGraph(ctx);
        formula = await validated({ ...ctx, now: () => now }, analyte.code, draft, '');
        await writeFormulaEdges(ctx, owner.id, id, formula.inputIds);   // TRD §7.2 step 6: BEFORE the status UPDATE (tg_parent_is_draft)
      }
      if (pred) await updateVersion(ctx, pred.id, Number(pred.version), { status: 'superseded', effective_to: new Date(effective) });
      const published = await updateVersion(ctx, id, ev, {
        status: 'published', effective_from: new Date(effective), published_at: new Date(now), published_by: ctx.actor.id, change_reason: b['change_reason'],
        ...(formula ? { formula_inputs: formula.inputs, formula_input_units: formula.inputUnits } : {}),
      });
      await bump(ctx, owner, 'versioned', effective);
      // T-09 bundle: the sets are published after the version (their T-08 rules compare with it), in the same transaction; one event each.
      const member = { analyteId: owner.id, unit_code: draft.unit_code, method_id: draft.method_id, effective, now, reason: b['change_reason'] as string, testId: owner.test_id };
      if (b['reference_range_set_id'] !== undefined) await ranges.publishReferenceRangeSetInBundle(ctx, b['reference_range_set_id'] as string, { ...member, path: '/reference_range_set_id' });
      if (b['critical_limit_set_id'] !== undefined) await ranges.publishCriticalLimitSetInBundle(ctx, b['critical_limit_set_id'] as string, { ...member, path: '/critical_limit_set_id' });
      return versionDto(published);
    },

    /** #35 — V3: a draft becomes `discarded`; no event. */
    async discardAnalyteVersionDraft(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      await ownerOfVersion(ctx, id);
      await lockDraft(ctx, id, ev);
      return versionDto(await updateVersion(ctx, id, ev, { status: 'discarded' }));
    },
  };
}
