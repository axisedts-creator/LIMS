// C9 T-16 — QualityPort.canAutoVerify + decision audit (02-TRD §8.4 steps 1-4, §8.5 A1-A16, §14 metrics; 03-IC §4.11; PRD AC-11.1, AC-13.1-13.6; 07-SECURITY QualityPort row, S-17).
// No permission check (the calling path authorised itself), tenant from ctx only, never opens a transaction: rows go to ctx.tx so a rollback of C5's transaction removes them (02-CV §8.1).
// Live row: tenant enabled AND an active version. Shadow row: a simulating version exists (ignores `enabled`, never changes the returned value, AC-11.1).
// Short-circuit (D-AV-4): no simulating version and (tenant disabled or no active version) -> deny, no row, counted.
// Failures: LimsErrors pass through; anything else is common.internal without driver text (fail closed: C5 must never read a failure as allow). Nothing of the inputs is logged.
import { LimsError, isLimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadQualityConfig } from '../config.js';
import { compileRuleSet, evaluateWith, type CompiledRuleSet, type EvalContext, type EvalQc, type EvalResult } from '../domain/autoverify-eval.js';
import { createAutoverifyRepo, type AutoverifyRepo } from '../repository/autoverify.repo.js';
import { createDecisionRepo, type DecisionRepo } from '../repository/decision.repo.js';
import { createStatusService, type QcStatusPortResult } from './status.service.js';
import { Errs, isObj, isUuid } from './setup.validate.js';

type Row = Record<string, any>;
export interface DecisionCtx {
  tenantId: string; tx: any; now(): string; actor: { id: string };
  ports: { IdentityPort: { getTenantSettings(ctx: unknown, i: { keys: string[] }): Promise<Row> } };
  metrics?: { inc(name: string, labels?: Record<string, string>, by?: number): void };
}
export interface ResultContext extends EvalContext { resultId: string; resultedAt: string }
export interface CanAutoVerifyResult { decision: 'allow' | 'deny'; reasons: string[]; ruleSetVersion?: string }

const DECISIONS = 'lims_quality_autoverify_decisions_total';
const SHORT_CIRCUIT = 'lims_quality_autoverify_short_circuit_total';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;                                  // _common.yaml DecimalString, maxLength 40
const RANGE_FLAGS = new Set(['N', 'L', 'H', 'LL', 'HH', 'A']);
const QC_STATUSES = new Set(['in_control', 'warning', 'out_of_control', 'no_qc_data']);
const MAX_FLAGS = 50, MAX_FLAG_LEN = 64;                                  // [CONV] sanity caps only (bound the row size); the spec names none

const invalid = (path: string): never => { const e = new Errs(); e.add(path); e.done(); throw new LimsError('common.validation_failed'); };
function fail(err: any): never {
  if (isLimsError(err) || (typeof err?.code === 'string' && /^[a-z]+\.[a-z_]+$/.test(err.code))) throw err;
  throw new LimsError('common.internal');
}

/** Allowlist copy of the ResultContext: unknown fields (incl. a smuggled tenant id) are dropped; bad shapes -> common.validation_failed. */
function parse(input: unknown): ResultContext {
  if (!isObj(input)) return invalid('/');
  const o = input as Row;
  if (!isUuid(o['resultId'])) invalid('/resultId');
  if (!isUuid(o['analyteId'])) invalid('/analyteId');
  if (o['instrumentId'] !== undefined && !isUuid(o['instrumentId'])) invalid('/instrumentId');
  const v = o['valueNumeric'];
  if (v !== undefined && (typeof v !== 'string' || v.length > 40 || !DECIMAL.test(v))) invalid('/valueNumeric');
  const f = o['rangeFlag'];
  if (f !== undefined && (typeof f !== 'string' || !RANGE_FLAGS.has(f))) invalid('/rangeFlag');
  const flags = o['instrumentFlags'];
  if (!Array.isArray(flags) || flags.length > MAX_FLAGS || flags.some((x) => typeof x !== 'string' || x.length > MAX_FLAG_LEN)) invalid('/instrumentFlags');
  if (typeof o['deltaCheckFailed'] !== 'boolean') invalid('/deltaCheckFailed');
  if (typeof o['isCritical'] !== 'boolean') invalid('/isCritical');
  const at = o['resultedAt'];
  if (typeof at !== 'string' || !ISO_UTC.test(at) || Number.isNaN(Date.parse(at))) invalid('/resultedAt');
  return {
    resultId: o['resultId'], analyteId: o['analyteId'], ...(o['instrumentId'] !== undefined ? { instrumentId: o['instrumentId'] } : {}),
    ...(v !== undefined ? { valueNumeric: v } : {}), ...(f !== undefined ? { rangeFlag: f } : {}),
    instrumentFlags: [...flags], deltaCheckFailed: o['deltaCheckFailed'], isCritical: o['isCritical'], resultedAt: new Date(Date.parse(at)).toISOString(),
  };
}

export function createDecisionService(deps: { autoverifyRepo?: AutoverifyRepo; decisionRepo?: DecisionRepo; status?: { qcStatusFor(ctx: any, i: { instrumentId: string; analyteId: string; at: string }): Promise<QcStatusPortResult> }; ruleCacheMax?: number } = {}) {
  const avRepo = deps.autoverifyRepo ?? createAutoverifyRepo();
  const decRepo = deps.decisionRepo ?? createDecisionRepo();
  const status = deps.status ?? createStatusService();
  // Compiled rules per (tenant, version id): a version's definition is frozen once it leaves draft (trigger quality.enforce_version_frozen), so the entry never goes stale.
  // The pointer row (which version is active / simulating) is NOT cached. Insertion-ordered Map = LRU, bounded by LIMS_QUALITY_RULE_CACHE_MAX (read lazily: bad env must not break import).
  const cache = new Map<string, CompiledRuleSet>();
  let cacheMax: number | undefined = deps.ruleCacheMax;
  async function compiled(ctx: DecisionCtx, versionId: string): Promise<CompiledRuleSet> {
    const key = `${ctx.tenantId}|${versionId}`;
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    const ver = await avRepo.findVersion(ctx.tx, ctx.tenantId, versionId);
    if (!ver) throw new LimsError('common.internal');                          // a pointer to a missing version: fail closed
    const rs = compileRuleSet(ver['definition']);
    cacheMax ??= loadQualityConfig().ruleCacheMax;
    cache.set(key, rs);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value as string);
    return rs;
  }

  const inc = (ctx: DecisionCtx, name: string, labels: Record<string, string>) => { try { ctx.metrics?.inc(name, labels); } catch { /* metrics never break a decision */ } };

  async function write(ctx: DecisionCtx, rc: ResultContext, mode: 'live' | 'shadow', versionId: string, r: EvalResult, qc: QcStatusPortResult | undefined): Promise<void> {
    const row = {
      id: uuidv7(), decided_at: ctx.now(), mode, version_id: versionId, result_id: rc.resultId, analyte_id: rc.analyteId, instrument_id: rc.instrumentId ?? null,
      decision: r.decision, reasons: [...r.reasons], matched_rule_key: r.matchedRuleKey ?? null,
      qc_status: qc ? (QC_STATUSES.has(qc.status) ? qc.status : 'no_qc_data') : 'not_evaluated', qc_run_id: qc?.currentRunId ?? null,
      inputs: {
        ...(rc.valueNumeric !== undefined ? { value_numeric: rc.valueNumeric } : {}), ...(rc.rangeFlag !== undefined ? { range_flag: rc.rangeFlag } : {}),
        delta_check_failed: rc.deltaCheckFailed, is_critical: rc.isCritical, instrument_flags: [...rc.instrumentFlags], resulted_at: rc.resultedAt,
      },
      created_by: ctx.actor.id,
    };
    await decRepo.insertDecision(ctx.tx, ctx.tenantId, row);
    for (const reason of r.reasons.length ? r.reasons : ['none']) inc(ctx, DECISIONS, { mode, decision: r.decision, reason });
  }

  return {
    async canAutoVerify(ctx: DecisionCtx, input: unknown): Promise<CanAutoVerifyResult> {
      const rc = parse(input);                                                          // before any settings / repo / QC call
      return guardCall(async () => {
        const enabled = (await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['autoVerificationEnabled'] }))['autoVerificationEnabled'] === true;   // 1.
        const set = await avRepo.findRuleSet(ctx.tx, ctx.tenantId);
        const activeId: string | undefined = set?.['active_version_id'] ?? undefined, simId: string | undefined = set?.['simulating_version_id'] ?? undefined;
        const live = enabled && activeId !== undefined;
        if (!live && simId === undefined) {                                             // short-circuit (AC-13.5): deny, no row
          const reason = enabled ? 'rule_missing' : 'feature_disabled';
          inc(ctx, SHORT_CIRCUIT, { reason });
          return { decision: 'deny', reasons: [reason] };
        }
        const [active, sim] = await Promise.all([live ? compiled(ctx, activeId!) : undefined, simId !== undefined ? compiled(ctx, simId) : undefined]);
        const qc = rc.instrumentId ? await status.qcStatusFor(ctx, { instrumentId: rc.instrumentId, analyteId: rc.analyteId, at: rc.resultedAt }) : undefined;   // once, shared
        const evalQc: EvalQc | undefined = qc;
        const liveRes = active ? evaluateWith(active, rc, evalQc) : undefined;
        const shadowRes = sim ? evaluateWith(sim, rc, evalQc) : undefined;
        if (liveRes) await write(ctx, rc, 'live', activeId!, liveRes, qc);
        if (shadowRes) await write(ctx, rc, 'shadow', simId!, shadowRes, qc);            // 3. never affects the returned value
        if (liveRes) return { decision: liveRes.decision, reasons: [...liveRes.reasons], ruleSetVersion: activeId! };   // 4.
        return { decision: 'deny', reasons: [enabled ? 'rule_missing' : 'feature_disabled'] };
      });
    },
  };
}

async function guardCall<T>(fn: () => Promise<T>): Promise<T> { try { return await fn(); } catch (err) { return fail(err); } }
