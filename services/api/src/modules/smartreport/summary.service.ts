// summary.service.buildOrGet — the single build entry for port, staff (#30) and prebuild (02-TRD §7.1 steps 3-8, §4.10, §7.2; 03-APP-FLOW §1.2 S1/S5/S6, E19).
// Runs in ctx.tx only (never opens a transaction). Feature flag + report-version validation of steps 1-2 and the status mapping of step 9 belong to the port (T13).
// Callers authorise; the service only reads/writes through the repositories and ports. Tenant always comes from ctx.
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../core/errors.js';
import { bandOf } from './domain/band.js';
import { buildContent, contentSha256, type EngineInputs, type EngineLibrary } from './domain/engine.js';
import { isUuid } from './library.service.js';
import * as blocksRepo from './repository/blocks.repo.js';
import * as bindingsRepo from './repository/bindings.repo.js';
import type { RepoCtx, Row } from './repository/common.repo.js';
import * as groupsRepo from './repository/groups.repo.js';
import * as libraryRepo from './repository/library.repo.js';
import * as mappingsRepo from './repository/mappings.repo.js';
import * as rulesRepo from './repository/rules.repo.js';
import * as summariesRepo from './repository/summaries.repo.js';

export type BuildMode = 'current' | 'prebuild' | 'rebuild_with_active_library';
export interface BuildInput { orderId: string; mode?: BuildMode; reportVersionNo?: number }
export interface BuildCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly tx: RepoCtx['tx'] & { savepoint<T>(fn: (tx: never) => Promise<T>): Promise<T> };
  readonly ports: { FrontdeskPort: any; LabPort: any; CatalogPort: any };   // ponytail: port types live in C0; narrowed when the shared PortMap is importable here
  readonly log: { warn(o: object, m?: string): void; info?(o: object, m?: string): void; error?(o: object, m?: string): void };
  /** Optional sink for the lims_smartreport_* metrics (02-TRD §12; registered in core/observability/metrics.ts per lead T17-01). Absent in some contexts: always call with `?.`. */
  readonly metrics?: { inc?(name: string, labels?: Record<string, string | number>, by?: number): void; set?(name: string, value: number, labels?: Record<string, string | number>): void; observe?(name: string, value: number, labels?: Record<string, string | number>): void };
  now(): string;
}

const MAX_INPUTS = 2000;                                  // summaries__inputs__ck [CONV]
const MODES: readonly string[] = ['current', 'prebuild', 'rebuild_with_active_library'];
const MAPPED_TYPES = new Set(['numeric', 'ordinal', 'coded']);
const DAY_MS = 86_400_000;
const refuse = (code: string): never => { throw new LimsError(code); };
const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

/** A port error C14 handles by skipping: the same call made in a savepoint, so what the port wrote before failing is rolled back (P-44). */
const inSavepoint = <T>(ctx: BuildCtx, fn: (c: BuildCtx) => Promise<T>): Promise<T> => ctx.tx.savepoint((tx) => fn({ ...ctx, tx } as BuildCtx));

const REFUSAL_OUTCOME: Readonly<Record<string, string>> = { 'smartreport.no_eligible_results': 'no_eligible', 'smartreport.template_not_approved': 'not_approved' };

/** Single build entry. Wraps the build with the 02-TRD §12 metrics and log line (T17-01): ids, outcome, duration and error code only; never text, values or error messages (AC-21.3). */
export async function buildOrGet(ctx: BuildCtx, input: BuildInput): Promise<{ summary: Row; created: boolean }> {
  const path = input.mode === 'prebuild' ? 'prebuild' : input.reportVersionNo !== undefined ? 'port' : 'staff';   // ponytail: port = the SmartReportPort call (carries the report version); staff = #30 / other
  const t0 = performance.now();
  const done = (outcome: string, cached: boolean, fields: Record<string, unknown>, level: 'info' | 'warn' | 'error'): void => {
    const ms = Math.max(0, Math.round(performance.now() - t0));
    ctx.metrics?.inc?.('lims_smartreport_builds_total', { path, outcome });
    ctx.metrics?.observe?.('lims_smartreport_build_duration_seconds', ms / 1000, { path, cached: String(cached) });
    (ctx.log[level] ?? ctx.log.warn).call(ctx.log, { order_id: input.orderId, outcome, duration_ms: ms, ...fields }, 'smartreport build');
  };
  try {
    const r = await buildInner(ctx, input);
    done(r.created ? 'built' : 'cached', !r.created, { summary_id: r.summary.id, library_version_id: r.summary.library_version_id }, 'info');
    return r;
  } catch (e) {
    const code = typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : 'common.internal';
    const outcome = REFUSAL_OUTCOME[code] ?? 'error';
    done(outcome, false, { error_code: code }, outcome === 'error' ? 'error' : 'warn');
    throw e;
  }
}

async function buildInner(ctx: BuildCtx, input: BuildInput): Promise<{ summary: Row; created: boolean }> {
  const { orderId, reportVersionNo } = input;
  const mode = input.mode ?? 'current';
  if (!MODES.includes(mode)) throw new LimsError('common.validation_failed');
  if (!isUuid(orderId)) throw new LimsError('common.validation_failed');
  if (reportVersionNo !== undefined && !(Number.isInteger(reportVersionNo) && reportVersionNo >= 1)) throw new LimsError('common.validation_failed');
  const rc: RepoCtx = { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };

  const order = await ctx.ports.FrontdeskPort.getOrderSummary(ctx, { orderId });                           // step 3: not visible -> common.not_found propagates
  const lab = await ctx.ports.LabPort.getOrderResults(ctx, { orderId, scope: 'approved' });                  // step 4
  const results: Row[] = (lab.items as Row[]).flatMap((i) => i.results as Row[]);
  if (results.length === 0) refuse('smartreport.no_eligible_results');
  if (results.length > MAX_INPUTS) { ctx.log.warn({ reason: 'too_many_results', count: results.length }, 'smartreport build refused'); refuse('smartreport.no_eligible_results'); }
  const hash: string = lab.approvedSetHash;

  // step 5: one build per order at a time (§4.10), held until the caller's transaction ends.
  await ctx.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('smartreport:' || $1::text || ':' || $2::text, 0))`, [ctx.tenantId, orderId]);

  const finish = async (summary: Row, created: boolean): Promise<{ summary: Row; created: boolean }> => {   // step 8: ON CONFLICT DO NOTHING in the repository
    if (reportVersionNo !== undefined) {
      await bindingsRepo.insertBinding(rc, { id: uuidv7(), centre_id: summary.centre_id, summary_id: summary.id, order_id: orderId, report_version_no: reportVersionNo, bound_at: ctx.now() });
    }
    return { summary, created };
  };
  const supersede = async (row: Row, reason: 'results_changed' | 'library_rebuild'): Promise<Row> => {     // S5: successor id stays NULL (the successor does not exist yet)
    const r = await summariesRepo.updateSummary(rc, row.id, row.version, { status: 'superseded', superseded_at: ctx.now(), superseded_reason: reason });
    ctx.metrics?.inc?.('lims_smartreport_supersede_total', { reason });
    return r;
  };

  // step 7a/7b
  const live = await summariesRepo.getLiveSummaryByOrder(rc, orderId);
  let old: Row | null = null;
  let version: Row | null = null;
  if (live !== null && live.approved_set_hash === hash) {
    if (mode !== 'rebuild_with_active_library') return finish(live, false);                                   // pinning: a live summary keeps its library
    version = await libraryRepo.getApprovedLibraryVersion(rc);
    if (version === null) return refuse('smartreport.template_not_approved');                                // nothing is superseded without a replacement library
    if (version.id === live.library_version_id) return finish(live, false);
    old = await supersede(live, 'library_rebuild');
  } else if (live !== null) {
    old = await supersede(live, 'results_changed');
  }

  // step 7c
  version ??= await libraryRepo.getApprovedLibraryVersion(rc);
  if (version === null) return refuse('smartreport.template_not_approved');
  const { content, eligible, distinctEligible, mapByAnalyte } = await computeContent(ctx, rc, version, order, orderId, results);
  const score = content.healthScore;
  const summary = await summariesRepo.insertSummary(rc, {
    id: uuidv7(), centre_id: order.centreId, order_id: orderId, patient_id: order.patientId, library_version_id: version.id, template_library_version: String(version.version_no),
    formula_version: version.formula_version, language: version.language, approved_set_hash: hash, input_result_versions: results.map((r) => `${r.resultId}:${r.versionNo}`).sort(),
    content, content_sha256: contentSha256(content),
    ...(score !== undefined && { health_score_value: score.value, health_score_band: score.band }),
    panels_scored: score?.panelsScored ?? 0, deranged_count: content.deranged.length, critical_count: content.deranged.filter((d) => d.severity === 'critical').length,
    unmapped_result_count: results.filter((r) => !mapByAnalyte.has(r.analyteId)).length, ignored_duplicate_count: eligible.length - distinctEligible, built_at: content.builtAt,
  });
  if (old !== null) await summariesRepo.updateSummary(rc, old.id, old.version, { superseded_by_summary_id: summary.id });   // S6: once, NULL -> id, after the insert
  return finish(summary, true);
}

/** §7.1 step 7c shared by buildOrGet and the preview (#22): library reads, analytes, eligibility, follow-ups, history, engine. Read-only; throws like buildOrGet. */
export async function computeContent(ctx: BuildCtx, rc: RepoCtx, version: Row, order: Row, orderId: string, results: Row[], fixtureAnalytes?: Row[]): Promise<{ content: ReturnType<typeof buildContent>; eligible: Row[]; distinctEligible: number; mapByAnalyte: Map<string, Row> }> {
  const [blockRows, ruleRows, mappingRows, groupRows] = await Promise.all([
    blocksRepo.listBlocks(rc, version.id), rulesRepo.listRules(rc, version.id), mappingsRepo.listMappings(rc, version.id), groupsRepo.listGroupSettings(rc, version.id)]);
  const disclaimer = blockRows.find((b) => b.kind === 'disclaimer');
  if (disclaimer === undefined) return refuse('smartreport.template_not_approved');

  // analyte info: one plain read per distinct test, as of its latest approval (errors propagate, P-23)
  const latestApproval = new Map<string, string>();
  for (const r of results) {
    const cur = latestApproval.get(r.testId);
    if (cur === undefined || Date.parse(r.approvedAt) > Date.parse(cur)) latestApproval.set(r.testId, r.approvedAt);
  }
  const analytes = new Map<string, Row>();
  for (const a of fixtureAnalytes ?? []) analytes.set(a.analyteId, { ...a, id: a.analyteId });   // preview fixture: no CatalogPort, follow-ups or history
  for (const [testId, asOf] of fixtureAnalytes === undefined ? latestApproval : []) {
    const t = await ctx.ports.CatalogPort.getTest(ctx, { testId, asOf });
    for (const a of t.analytes as Row[]) analytes.set(a.id, a);
  }

  // §4.1 eligibility (same predicate as the engine): mapped, numeric/ordinal/coded, has a band.
  const mapByAnalyte = new Map(mappingRows.map((m) => [m.analyte_id as string, m]));
  const bandOfResult = (r: Row): ReturnType<typeof bandOf> => {
    const m = mapByAnalyte.get(r.analyteId);
    const an = analytes.get(r.analyteId);
    if (m === undefined || an === undefined || !MAPPED_TYPES.has(an.resultType) || (r.flag === undefined && r.referenceRangeSnapshot == null)) return null;   // §4.1: needs a flag or a range
    return bandOf({
      ...(r.flag !== undefined && { flag: r.flag }), ...(r.valueNumeric !== undefined && { valueNumeric: r.valueNumeric }),
      ...(r.referenceRangeSnapshot != null && { referenceRangeSnapshot: r.referenceRangeSnapshot }),
      borderlineFractionBp: m.borderline_fraction_bp ?? version!.borderline_fraction_bp,
    });
  };
  const eligible = results.filter((r) => bandOfResult(r) !== null);
  const distinctEligible = new Set(eligible.map((r) => r.analyteId)).size;
  if (distinctEligible < version.min_mapped_results) refuse('smartreport.no_eligible_results');              // old stays superseded, successor id NULL

  // follow-up tests: active only; inactive/unknown -> suggestion skipped (savepoint, P-44)
  const tests: { testId: string; code: string; name: string }[] = [];
  for (const testId of new Set(fixtureAnalytes !== undefined ? [] : ruleRows.flatMap((r) => (r.rule_kind === 'followup' && r.suggested_test_id != null ? [r.suggested_test_id as string] : [])))) {
    try {
      const t = await inSavepoint<Row>(ctx, (c) => c.ports.CatalogPort.getTest(c, { testId, requireActive: true }));
      tests.push({ testId, code: t.code, name: t.name });
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (code !== 'catalog.test_inactive' && code !== 'common.not_found') throw e;
      ctx.metrics?.inc?.('lims_smartreport_followup_skipped_total', { reason: code === 'catalog.test_inactive' ? 'test_inactive' : 'test_not_found' });
    }
  }

  // trend history: any error -> trends empty (savepoint, P-44)
  const trendOn = (id: string): boolean => version!.trend_enabled === true && mapByAnalyte.get(id)?.trend_enabled === true;
  const trendIds = [...new Set(eligible.filter((r) => trendOn(r.analyteId) && r.valueNumeric !== undefined && (r.referenceRangeSnapshot?.low != null || r.referenceRangeSnapshot?.high != null)).map((r) => r.analyteId as string))].slice(0, 100);
  let history: EngineInputs['history'];
  if (trendIds.length > 0 && fixtureAnalytes === undefined) {
    const now = ctx.now();
    try {
      history = await inSavepoint(ctx, (c) => c.ports.LabPort.getAnalyteHistory(c, {
        patientId: order.patientId, analyteIds: trendIds, before: now, since: new Date(Date.parse(now) - version!.trend_lookback_days * DAY_MS).toISOString(),
        limitPerAnalyte: Math.min(10, version!.trend_max_points), excludeOrderId: orderId, includeLegacy: false,
      }));
    } catch { history = undefined; ctx.metrics?.inc?.('lims_smartreport_trend_unavailable_total'); }
  }

  const v = version;
  const library: EngineLibrary = {
    language: v.language, disclaimerBlockId: disclaimer.id,
    params: {
      scoreEnabled: v.score_enabled, creditInRangeBp: v.credit_in_range_bp, creditBorderlineBp: v.credit_borderline_bp, creditOutOfRangeBp: v.credit_out_of_range_bp,
      creditCriticalBp: v.credit_critical_bp, minGroupsScored: v.min_groups_scored, bandGoodMin: v.band_good_min, bandFairMin: v.band_fair_min,
      criticalForcesNeedsAttention: v.critical_forces_needs_attention, adviceMaxBlocks: v.advice_max_blocks, followupMax: v.followup_max,
      trendMaxPoints: v.trend_max_points, trendStableBp: v.trend_stable_bp, trendsMax: v.trends_max, borderlineFractionBp: v.borderline_fraction_bp,
    },
    blocks: blockRows.map((b) => ({ id: b.id, kind: b.kind, blockKey: b.block_key, ...(opt(b.text_en) !== undefined && { textEn: b.text_en }), ...(opt(b.text_ne) !== undefined && { textNe: b.text_ne }) })),
    rules: ruleRows.map((r) => ({
      id: r.id, ruleKind: r.rule_kind, triggerKind: r.trigger_kind, direction: r.direction, priority: r.priority, blockId: r.block_id,
      ...(opt(r.analyte_id) !== undefined && { analyteId: r.analyte_id }), ...(opt(r.group_code) !== undefined && { groupCode: r.group_code }),
      ...(opt(r.min_severity) !== undefined && { minSeverity: r.min_severity }), ...(opt(r.suggested_test_id) !== undefined && { suggestedTestId: r.suggested_test_id }),
      ...(opt(r.interval_days) !== undefined && { intervalDays: r.interval_days }),
    })) as EngineLibrary['rules'],
    mappings: mappingRows.map((m) => ({
      analyteId: m.analyte_id, groupCode: m.group_code, includeInScore: m.include_in_score, trendEnabled: trendOn(m.analyte_id),
      ...(opt(m.borderline_fraction_bp) !== undefined && { borderlineFractionBp: m.borderline_fraction_bp }),
    })),
    groups: groupRows.map((g) => ({
      groupCode: g.group_code, displayEn: g.display_en, sortOrder: g.sort_order, isShown: g.is_shown, scoreWeight: g.score_weight, ...(opt(g.display_ne) !== undefined && { displayNe: g.display_ne }),
    })),
  };
  const builtAt = ctx.now();
  const content = buildContent({
    builtAt, tests, ...(history !== undefined && { history }),
    results: results.map((r) => ({
      resultId: r.resultId, analyteId: r.analyteId, approvedAt: r.approvedAt,
      ...(r.flag !== undefined && { flag: r.flag }), ...(r.valueNumeric !== undefined && { valueNumeric: r.valueNumeric }), ...(r.valueText !== undefined && { valueText: r.valueText }),
      ...(r.ordinalCode !== undefined && { ordinalCode: r.ordinalCode }), ...(r.unitCode !== undefined && { unitCode: r.unitCode }),
      ...(r.referenceRangeSnapshot != null && { referenceRangeSnapshot: { ...(r.referenceRangeSnapshot.low != null && { low: r.referenceRangeSnapshot.low }), ...(r.referenceRangeSnapshot.high != null && { high: r.referenceRangeSnapshot.high }), ...(r.referenceRangeSnapshot.text != null && { text: r.referenceRangeSnapshot.text }) } }),
    })),
    analytes: [...analytes.values()].map((a) => ({ analyteId: a.id, name: a.name, sortOrder: a.sortOrder, resultType: a.resultType, ...(opt(a.printName) !== undefined && { printName: a.printName }) })),
  }, library);

  return { content, eligible, distinctEligible, mapByAnalyte };
}
