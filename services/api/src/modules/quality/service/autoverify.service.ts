// C9 T-15 auto-verify rule-set service #36-#41, #44, #45 (02-TRD §5.5, §8.1-8.2; 03-APP-FLOW §2.3 AV1-AV4, AV6-AV7; AC-10.1-10.3, AC-11.4, AC-12.3; 07-SECURITY S-01/S-03/S-07/S-08).
// Order of every operation: assertRole (aal2 for quality.autoverify.manage is enforced by the port: auth.mfa_required propagates unchanged) -> validate body ->
// If-Match present? -> load through the tenant-scoped repo (404 when invisible) -> version check -> state machine -> DSL + catalog -> write.
// Tenant, actor, ids and the clock come from ctx / the service, never from a body. Errors throw LimsError; the core rolls the request transaction back (02-CV §4.6).
// Activation (#43, AV5) and the access-log rows are T-17. Nothing here deletes: stopped shadow rows stay (D-55).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, isLimsError } from '../../../core/errors.js';
import { referencedTestIds, validateRuleSetDefinition, type CatalogTest } from '../domain/autoverify-dsl.js';
import { nextStatus, type VersionAction, type VersionStatus } from '../domain/ruleset.state.js';
import { ruleSetDto, userIdsOf, versionDto, type Labels } from '../mappers/autoverify.mapper.js';
import { createAutoverifyRepo, type AutoverifyRepo, type Row } from '../repository/autoverify.repo.js';
import { Errs, isObj, isUuid } from './setup.validate.js';

export interface AutoverifyCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly tx: any;
  readonly now: () => string;
  readonly ports?: any;
}
export interface Result { status: number; body: unknown; version?: number }

const READ = 'quality.autoverify.read', MANAGE = 'quality.autoverify.manage';
const MAX_VERSIONS_IN_SUMMARY = 200;       // AutoverifyRuleSetDto.versions maxItems [CONV]
const CATALOG_BATCH = 8;                   // concurrent CatalogPort.getTest calls per definition
const REASON_MAX = 500;

const assert = (ctx: AutoverifyCtx, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
const transition = () => new LimsError('quality.rule_set_invalid_transition');
const isDup = (e: any): boolean => e?.code === '23505';
const chars = (s: string): number => [...s].length;
const needVersion = (v: number | undefined): number => {
  if (v === undefined) throw new LimsError('common.precondition_required');
  return v;
};

// ---------------------------------------------------------------------------------------------------- request bodies (fixed messages, no value echoed)
function bodyObject(e: Errs, body: unknown, allowed: readonly string[]): Record<string, any> | undefined {
  if (!isObj(body)) { e.add('/'); return undefined; }
  for (const k of Object.keys(body)) if (!allowed.includes(k)) e.add(`/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, 'common.unknown_field');   // mass assignment (S-03)
  return body;
}
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function createBody(body: unknown): { copyFrom?: string; definition?: unknown } {
  const e = new Errs(), o = bodyObject(e, body, ['copy_from_version_id', 'definition']);
  if (!o) return e.done() as never;
  const copy = has(o, 'copy_from_version_id'), def = has(o, 'definition');
  if (copy && def) e.add('/definition');                                       // exactly one of the two
  else if (!copy && !def) e.add('/definition', 'common.field_required');
  if (copy && !isUuid(o['copy_from_version_id'])) e.add('/copy_from_version_id');
  e.done();
  return copy ? { copyFrom: o['copy_from_version_id'] } : { definition: o['definition'] };
}
function definitionBody(body: unknown): unknown {
  const e = new Errs(), o = bodyObject(e, body, ['definition']);
  if (!o) return e.done() as never;
  if (!has(o, 'definition')) e.add('/definition', 'common.field_required');
  e.done();
  return o['definition'];
}
/** start / stop / discard take no fields: `{}` (an absent body counts as `{}`). */
function emptyBody(body: unknown): void {
  const e = new Errs();
  if (body !== undefined) bodyObject(e, body, []);
  e.done();
}
function retireBody(body: unknown): string {
  const e = new Errs(), o = bodyObject(e, body, ['reason']);
  if (!o) return e.done() as never;
  const r = o['reason'];
  if (!has(o, 'reason')) e.add('/reason', 'common.field_required');
  else if (typeof r !== 'string' || chars(r) < 1 || chars(r) > REASON_MAX) e.add('/reason');
  e.done();
  return r as string;
}

export function createAutoverifyService(deps: { repo?: AutoverifyRepo } = {}) {
  const repo = deps.repo ?? createAutoverifyRepo();

  const labelsFor = async (ctx: AutoverifyCtx, rows: Row[]): Promise<Labels> => {
    const ids = userIdsOf(rows);
    return new Map((ids.length ? await repo.listUserLabels(ctx.tx, ctx.tenantId, ids) : []).map((l) => [l.user_id, l.display_name]));
  };
  const dto = async (ctx: AutoverifyCtx, row: Row): Promise<Row> => versionDto(row, await labelsFor(ctx, [row]));
  const ok = async (ctx: AutoverifyCtx, row: Row, status = 200): Promise<Result> => ({ status, version: row['version'], body: await dto(ctx, row) });

  /** One getTest per distinct test_id. A `common.not_found` = unknown test (-> pointer later); any other failure propagates (fail closed, nothing written). */
  async function catalogFor(ctx: AutoverifyCtx, ids: string[]): Promise<Map<string, CatalogTest | undefined>> {
    const out = new Map<string, CatalogTest | undefined>();
    for (let i = 0; i < ids.length; i += CATALOG_BATCH) {
      await Promise.all(ids.slice(i, i + CATALOG_BATCH).map(async (testId) => {
        try { out.set(testId, await ctx.ports.CatalogPort.getTest(ctx, { testId })); }
        catch (err) { if (isLimsError(err, 'common.not_found')) out.set(testId, undefined); else throw err; }
      }));
    }
    return out;
  }

  /** AC-10.1/10.2: structure + catalog; 422 quality.rule_set_invalid with every error as a JSON Pointer under `/definition`. Returns what is stored. */
  async function validDefinition(ctx: AutoverifyCtx, definition: unknown): Promise<{ definition: Row; ruleCount: number }> {
    const catalog = await catalogFor(ctx, referencedTestIds(definition));
    const errors = validateRuleSetDefinition(definition, catalog);
    if (errors.length) {
      const e = new Errs();
      for (const x of errors) e.add(`/definition${x.path}`, x.code);
      throw new LimsError('quality.rule_set_invalid', undefined, e.list);
    }
    const d = structuredClone(definition) as Row;
    return { definition: d, ruleCount: (d['rules'] as unknown[]).length };
  }

  /** Load a version through the tenant-scoped repo (invisible = 404, same as missing), check If-Match, then the state machine. */
  async function loadForAction(ctx: AutoverifyCtx, versionId: unknown, expected: number | undefined, action: VersionAction): Promise<{ cur: Row; to: VersionStatus }> {
    const v = needVersion(expected);
    const cur = isUuid(versionId) ? await repo.findVersion(ctx.tx, ctx.tenantId, versionId) : undefined;
    if (!cur) throw notFound();
    if (cur['version'] !== v) throw conflict();
    return { cur, to: nextStatus(cur['status'], action) };   // 409 quality.rule_set_invalid_transition (AC-10.3, D-55)
  }

  /** The write. A unique violation on update can only be one of the partial unique indexes (one simulating / one active per tenant) -> 409. */
  async function writeVersion(ctx: AutoverifyCtx, cur: Row, patch: Row): Promise<Row> {
    let row: Row | undefined;
    try { row = await repo.updateVersion(ctx.tx, ctx.tenantId, cur['id'], cur['version'], { ...patch, updated_by: ctx.actor.id }); }
    catch (err) { throw isDup(err) ? transition() : err; }
    if (!row) throw conflict();                                // a concurrent writer won between the read and the write
    return row;
  }

  /** Clear a rule-set pointer only when it points at this version. */
  async function clearPointer(ctx: AutoverifyCtx, versionId: string, pointer: 'simulating_version_id' | 'active_version_id'): Promise<void> {
    const set = await repo.findRuleSet(ctx.tx, ctx.tenantId);
    if (set && set[pointer] === versionId) await repo.updateRuleSet(ctx.tx, ctx.tenantId, set['id'], { [pointer]: null, updated_by: ctx.actor.id });
  }

  return {
    // ---------------------------------------------------------------------------------------------- #36 / #38 reads
    async getAutoverifyRuleSet(ctx: AutoverifyCtx, _i: Record<string, never> = {}): Promise<Result> {
      await assert(ctx, READ);
      const set = await repo.findRuleSet(ctx.tx, ctx.tenantId);
      if (!set) throw notFound();
      const versions = (await repo.listVersions(ctx.tx, ctx.tenantId, set['id']))
        .sort((a, b) => b['version_no'] - a['version_no']).slice(0, MAX_VERSIONS_IN_SUMMARY);
      return { status: 200, body: ruleSetDto(set, versions, await labelsFor(ctx, versions)) };   // a summary, not a versioned row: no ETag
    },

    async getAutoverifyVersion(ctx: AutoverifyCtx, i: { versionId: unknown }): Promise<Result> {
      await assert(ctx, READ);
      const cur = isUuid(i.versionId) ? await repo.findVersion(ctx.tx, ctx.tenantId, i.versionId) : undefined;
      if (!cur) throw notFound();
      return ok(ctx, cur);
    },

    // ---------------------------------------------------------------------------------------------- #37 AV1 create (from a definition or as a copy)
    async createAutoverifyVersion(ctx: AutoverifyCtx, i: { body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const b = createBody(i.body);
      let definition: Row, ruleCount: number;
      if (b.copyFrom !== undefined) {
        // AC-11.4: a new draft from ANY version (incl. `stopped`). The source was validated when it was created; it is copied, not re-judged against today's catalog.
        const src = await repo.findVersion(ctx.tx, ctx.tenantId, b.copyFrom);
        if (!src) throw notFound();
        definition = structuredClone(src['definition']);
        ruleCount = Array.isArray(definition['rules']) ? definition['rules'].length : src['rule_count'];
      } else ({ definition, ruleCount } = await validDefinition(ctx, b.definition));

      const set = await ruleSet(ctx);
      const existing = await repo.listVersions(ctx.tx, ctx.tenantId, set['id']);
      const versionNo = existing.reduce((m, v) => Math.max(m, v['version_no']), 0) + 1;
      let row: Row;
      try {
        row = await repo.insertVersion(ctx.tx, ctx.tenantId, {
          id: uuidv7(), rule_set_id: set['id'], version_no: versionNo, status: 'draft', definition, rule_count: ruleCount,
          created_at: ctx.now(), created_by: ctx.actor.id, updated_at: ctx.now(), updated_by: ctx.actor.id,
        });
      } catch (err) { throw isDup(err) ? conflict() : err; }   // two concurrent creates took the same version_no: the loser retries
      return ok(ctx, row, 201);
    },

    // ---------------------------------------------------------------------------------------------- #39 AV2 replace a draft
    async replaceAutoverifyDraft(ctx: AutoverifyCtx, i: { versionId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const raw = definitionBody(i.body);
      const { cur } = await loadForAction(ctx, i.versionId, i.expectedVersion, 'edit');   // AC-10.3: only a draft can be edited
      const { definition, ruleCount } = await validDefinition(ctx, raw);
      return ok(ctx, await writeVersion(ctx, cur, { definition, rule_count: ruleCount }));
    },

    // ---------------------------------------------------------------------------------------------- #40 AV3 start simulation
    async startAutoverifySimulation(ctx: AutoverifyCtx, i: { versionId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      emptyBody(i.body);
      const { cur, to } = await loadForAction(ctx, i.versionId, i.expectedVersion, 'startSimulation');
      const set = await repo.findRuleSet(ctx.tx, ctx.tenantId);
      if (!set) throw notFound();
      if (set['simulating_version_id'] && set['simulating_version_id'] !== cur['id']) throw transition();   // one simulating version per tenant
      const row = await writeVersion(ctx, cur, { status: to, simulation_started_at: ctx.now(), simulation_started_by: ctx.actor.id });
      await repo.updateRuleSet(ctx.tx, ctx.tenantId, set['id'], { simulating_version_id: cur['id'], updated_by: ctx.actor.id });
      return ok(ctx, row);
    },

    // ---------------------------------------------------------------------------------------------- #41 AV4 stop simulation: simulating -> stopped (terminal, D-55)
    async stopAutoverifySimulation(ctx: AutoverifyCtx, i: { versionId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      emptyBody(i.body);
      const { cur, to } = await loadForAction(ctx, i.versionId, i.expectedVersion, 'stopSimulation');
      const row = await writeVersion(ctx, cur, { status: to, simulation_stopped_at: ctx.now() });   // definition + start fields kept; shadow rows kept (nothing is deleted)
      await clearPointer(ctx, cur['id'], 'simulating_version_id');
      return ok(ctx, row);
    },

    // ---------------------------------------------------------------------------------------------- #44 AV6 retire
    async retireAutoverifyVersion(ctx: AutoverifyCtx, i: { versionId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      const reason = retireBody(i.body);
      const { cur, to } = await loadForAction(ctx, i.versionId, i.expectedVersion, 'retire');
      const row = await writeVersion(ctx, cur, { status: to, retired_at: ctx.now(), retired_by: ctx.actor.id, retire_reason: reason });
      await clearPointer(ctx, cur['id'], 'active_version_id');   // all live decisions are then `rule_missing` (TRD §8.4)
      return ok(ctx, row);
    },

    // ---------------------------------------------------------------------------------------------- #45 AV7 discard
    async discardAutoverifyDraft(ctx: AutoverifyCtx, i: { versionId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      emptyBody(i.body);
      const { cur, to } = await loadForAction(ctx, i.versionId, i.expectedVersion, 'discard');
      return ok(ctx, await writeVersion(ctx, cur, { status: to }));
    },
  };

  /** The tenant's one rule set, created with its first version (AV1). A concurrent first create loses the unique index and re-reads. */
  async function ruleSet(ctx: AutoverifyCtx): Promise<Row> {
    const found = await repo.findRuleSet(ctx.tx, ctx.tenantId);
    if (found) return found;
    try { return await repo.insertRuleSet(ctx.tx, ctx.tenantId, { id: uuidv7(), created_at: ctx.now(), created_by: ctx.actor.id, updated_at: ctx.now(), updated_by: ctx.actor.id }); }
    catch (err) {
      if (!isDup(err)) throw err;
      const again = await repo.findRuleSet(ctx.tx, ctx.tenantId);
      if (again) return again;
      throw err;
    }
  }
}
