// C9 T-17 service: #43 activate (AV5, four-eyes), #42 simulation report, #46 decision list, #47 decision detail (02-TRD §5.5, §8.6; 03-APP-FLOW AV5; AC-11.2, 11.3, 12.1-12.3, 13.7;
// 07-SECURITY S-08/S-12/S-13; 08 A17 D-53). Authorisation FIRST (aal2 for quality.autoverify.manage is enforced by the port: auth.mfa_required propagates unchanged).
// #43 order: role -> body -> If-Match (428) -> load (404) -> version (409) -> state machine (409) -> four-eyes (403) -> minimums (409) -> write -> access log.
// Access log (02-TRD §5.5): ctx.audit.access({ action, entityType, entityId, outcome: 'allowed' }) by this service, once, AFTER the read/write succeeded; a failing audit call fails the
// request (the core rolls the request transaction back, so an unlogged activation or P3 read cannot leave). #46 writes none. Tenant, actor and clock come from ctx only.
import { LimsError } from '../../../core/errors.js';
import { nextStatus } from '../domain/ruleset.state.js';
import { decisionDetailDto, decisionDto, simulationReportDto } from '../mappers/activation.mapper.js';
import { userIdsOf, versionDto } from '../mappers/autoverify.mapper.js';
import { createAutoverifyRepo, type AutoverifyRepo, type Row } from '../repository/autoverify.repo.js';
import { createSimulationRepo, type SimulationRepo } from '../repository/simulation.repo.js';
import type { AutoverifyCtx, Result } from './autoverify.service.js';
import { Errs, isObj, isUuid, paging } from './setup.validate.js';

const READ = 'quality.autoverify.read', MANAGE = 'quality.autoverify.manage';
const DAY_MS = 86_400_000;
const DEFAULT_MINIMUMS = { sim_min_days: 7, sim_min_decisions: 100 };   // [CONV] 02-TRD §8.6 when the tenant has no settings row
const SAMPLE_DEFAULT = 50, SAMPLE_MAX = 200, WINDOW_MAX_MS = 31 * DAY_MS;
const MODES = ['live', 'shadow'], DECISIONS = ['allow', 'deny'];
const REASONS = ['manual_origin', 'rule_missing', 'critical', 'delta_failure', 'instrument_flag', 'outside_autoverify_limits', 'qc_out_of_control', 'qc_warning', 'qc_no_data'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

const assert = (ctx: AutoverifyCtx, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
const isDup = (e: any): boolean => e?.code === '23505';

/** The four C9 access-log actions are the only ones this module writes (AC-13.7); the entry has exactly these four keys. */
async function logAccess(ctx: AutoverifyCtx, action: string, entityType: string, entityId: string): Promise<void> {
  if (!ctx.audit) throw new LimsError('common.internal');   // fail closed: no unlogged read
  await ctx.audit.access({ action, entityType, entityId, outcome: 'allowed' });
}

function activateBody(body: unknown): void {
  const e = new Errs();
  if (!isObj(body)) e.add('/');
  else {
    for (const k of Object.keys(body)) if (k !== 'confirmation_text') e.add(`/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`, 'common.unknown_field');   // mass assignment (S-03)
    if (!Object.prototype.hasOwnProperty.call(body, 'confirmation_text')) e.add('/confirmation_text', 'common.field_required');
    else if (body['confirmation_text'] !== 'ACTIVATE') e.add('/confirmation_text');   // fixed message: the value is never echoed
  }
  e.done();
}

/** An ISO-8601 UTC instant -> normalised ISO text, or undefined (the caller records the error). */
const instant = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

export function createActivationService(deps: { repo?: AutoverifyRepo; sim?: SimulationRepo } = {}) {
  const repo = deps.repo ?? createAutoverifyRepo();
  const sim = deps.sim ?? createSimulationRepo();

  const versionBody = async (ctx: AutoverifyCtx, row: Row): Promise<Row> => {
    const ids = userIdsOf([row]);
    const labels = new Map((ids.length ? await repo.listUserLabels(ctx.tx, ctx.tenantId, ids) : []).map((l) => [l.user_id, l.display_name]));
    return versionDto(row, labels);
  };

  /** Whole days of the simulation so far; a stopped version stops counting at its stop (ponytail: not pinned by the spec, the truthful reading). */
  const daysRunning = (ctx: AutoverifyCtx, cur: Row): number => {
    const end = cur['simulation_stopped_at'] ? Date.parse(cur['simulation_stopped_at']) : Date.parse(ctx.now());
    return Math.max(0, Math.floor((end - Date.parse(cur['simulation_started_at'])) / DAY_MS));
  };

  return {
    // ---------------------------------------------------------------------------------------------- #43 AV5 activate (four-eyes)
    async activateAutoverifyVersion(ctx: AutoverifyCtx, i: { versionId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, MANAGE);
      activateBody(i.body);
      if (i.expectedVersion === undefined) throw new LimsError('common.precondition_required');
      const cur = isUuid(i.versionId) ? await repo.findVersion(ctx.tx, ctx.tenantId, i.versionId) : undefined;
      if (!cur) throw notFound();
      if (cur['version'] !== i.expectedVersion) throw conflict();
      nextStatus(cur['status'], 'activate');                                                   // only `simulating` (409 quality.rule_set_invalid_transition)
      if (cur['created_by'] === ctx.actor.id) throw new LimsError('quality.self_activation_forbidden');   // AC-12.1, S-12: the author, not whoever started the simulation

      // AC-11.2 / S-13 minimums: days from simulation_started_at, shadow decisions of THIS version since then.
      const min = (await sim.getMinimums(ctx.tx, ctx.tenantId)) ?? DEFAULT_MINIMUMS;
      const started = cur['simulation_started_at'];
      if (!started || daysRunning(ctx, cur) < min.sim_min_days) throw new LimsError('quality.simulation_incomplete');
      if ((await sim.countShadowDecisions(ctx.tx, ctx.tenantId, cur['id'], started)) < min.sim_min_decisions) throw new LimsError('quality.simulation_incomplete');

      const set = await repo.findRuleSet(ctx.tx, ctx.tenantId);
      if (!set) throw notFound();
      const write = async (row: Row, patch: Row): Promise<Row> => {
        let out: Row | undefined;
        try { out = await repo.updateVersion(ctx.tx, ctx.tenantId, row['id'], row['version'], { ...patch, updated_by: ctx.actor.id }); }
        catch (err) { throw isDup(err) ? new LimsError('quality.rule_set_invalid_transition') : err; }   // a partial unique index (one simulating / one active per tenant)
        if (!out) throw conflict();                                                              // a concurrent writer won between the read and the write
        return out;
      };
      // The previous active version is retired FIRST: the partial unique index allows one active version per tenant.
      const prevId = set['active_version_id'];
      if (prevId && prevId !== cur['id']) {
        const prev = await repo.findVersion(ctx.tx, ctx.tenantId, prevId);
        if (prev && prev['status'] === 'active') await write(prev, { status: nextStatus('active', 'retire'), retired_at: ctx.now(), retired_by: ctx.actor.id });
      }
      const row = await write(cur, { status: 'active', activated_at: ctx.now(), activated_by: ctx.actor.id });
      await repo.updateRuleSet(ctx.tx, ctx.tenantId, set['id'], { active_version_id: cur['id'], simulating_version_id: null, updated_by: ctx.actor.id });
      await logAccess(ctx, 'autoverify.activate', 'autoverify_version', cur['id']);
      return { status: 200, version: row['version'], body: await versionBody(ctx, row) };
    },

    // ---------------------------------------------------------------------------------------------- #42 simulation report (AC-11.3)
    async getAutoverifySimulationReport(ctx: AutoverifyCtx, i: { versionId: unknown; sampleLimit?: unknown }): Promise<Result> {
      await assert(ctx, READ);
      let sampleLimit = SAMPLE_DEFAULT;
      if (i.sampleLimit !== undefined) {
        if (typeof i.sampleLimit !== 'number' || !Number.isInteger(i.sampleLimit) || i.sampleLimit < 0 || i.sampleLimit > SAMPLE_MAX) {
          const e = new Errs(); e.add('/sample_limit'); e.done();
        }
        sampleLimit = i.sampleLimit as number;
      }
      const cur = isUuid(i.versionId) ? await repo.findVersion(ctx.tx, ctx.tenantId, i.versionId) : undefined;
      if (!cur || !cur['simulation_started_at']) throw notFound();   // a draft / discarded version never simulated: there is no report (not pinned by the spec)
      const rows = await sim.simulationReport(ctx.tx, ctx.tenantId, { versionId: cur['id'], since: cur['simulation_started_at'], sampleLimit });
      const body = simulationReportDto({ versionId: cur['id'], startedAt: cur['simulation_started_at'], daysRunning: daysRunning(ctx, cur), sampleLimit }, rows);
      await logAccess(ctx, 'autoverify_simulation.view', 'autoverify_version', cur['id']);   // AC-13.7: the report is P3-derived
      return { status: 200, body };
    },

    // ---------------------------------------------------------------------------------------------- #46 list decisions (no inputs, no access-log row)
    async listAutoverifyDecisions(ctx: AutoverifyCtx, i: Record<string, unknown>): Promise<Result> {
      await assert(ctx, READ);
      const e = new Errs();
      const uuid = (k: string, path: string): string | undefined => { if (i[k] === undefined) return undefined; if (!isUuid(i[k])) { e.add(`/${path}`); return undefined; } return i[k] as string; };
      const pick = (k: string, allowed: readonly string[]): string | undefined => { if (i[k] === undefined) return undefined; if (typeof i[k] !== 'string' || !allowed.includes(i[k] as string)) { e.add(`/${k}`); return undefined; } return i[k] as string; };
      const resultId = uuid('resultId', 'result_id'), analyteId = uuid('analyteId', 'analyte_id'), instrumentId = uuid('instrumentId', 'instrument_id'), versionId = uuid('versionId', 'version_id');
      const mode = pick('mode', MODES), decision = pick('decision', DECISIONS), reason = pick('reason', REASONS);
      pick('sort', ['-decided_at']);
      const from = instant(i['decidedAtFrom']), to = instant(i['decidedAtTo']);
      if (from === undefined) e.add('/decided_at_from', i['decidedAtFrom'] === undefined ? 'common.field_required' : 'common.field_invalid');
      if (to === undefined) e.add('/decided_at_to', i['decidedAtTo'] === undefined ? 'common.field_required' : 'common.field_invalid');
      if (from !== undefined && to !== undefined) { const span = Date.parse(to) - Date.parse(from); if (span < 0 || span > WINDOW_MAX_MS) e.add('/decided_at_to'); }   // window <= 31 d
      const pg = paging(e, i);
      e.done();

      const page = await sim.listDecisions(ctx.tx, ctx.tenantId, {
        ...(resultId !== undefined ? { resultId } : {}), ...(analyteId !== undefined ? { analyteId } : {}), ...(instrumentId !== undefined ? { instrumentId } : {}),
        ...(versionId !== undefined ? { versionId } : {}), ...(mode !== undefined ? { mode } : {}), ...(decision !== undefined ? { decision } : {}), ...(reason !== undefined ? { reason } : {}),
        from: from!, to: to!, ...(pg.cursor !== undefined ? { cursor: pg.cursor } : {}), limit: pg.limit,
      });
      return { status: 200, body: { data: page.rows.map(decisionDto), page: { limit: pg.limit, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } } };
    },

    // ---------------------------------------------------------------------------------------------- #47 decision detail (P3 inputs, AC-13.7)
    async getAutoverifyDecision(ctx: AutoverifyCtx, i: { decisionId: unknown }): Promise<Result> {
      await assert(ctx, READ);
      const row = isUuid(i.decisionId) ? await sim.findDecision(ctx.tx, ctx.tenantId, i.decisionId) : undefined;
      if (!row) throw notFound();
      const body = decisionDetailDto(row);
      await logAccess(ctx, 'autoverify_decision.view', 'autoverify_decision', row['id']);
      return { status: 200, body };
    },
  };
}
