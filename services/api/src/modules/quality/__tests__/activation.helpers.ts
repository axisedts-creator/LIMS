// C9 T-17 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Spec: 02-TRD §5.5 (#42 #43 #46 #47, access-log table), §8.6 (SimulationReportDto); 03-APP-FLOW AV5; PRD AC-11.2/11.3, AC-12.1-12.3, AC-13.7; 07-SECURITY S-08/S-12/S-13; 08 A17 D-53.
//
//   ../repository/simulation.repo.ts  exports `SimulationRepo` (below) + `createSimulationRepo(): SimulationRepo` (SELECT only; SQL on the request tx, parameterised, explicit `tenant_id = $n` on EVERY statement).
//   ../service/activation.service.ts  exports `createActivationService(deps?: { repo?: AutoverifyRepo; sim?: SimulationRepo })` -> one async method per operationId (same Result shape as autoverify.service):
//                                       activateAutoverifyVersion{versionId,expectedVersion,body}   getAutoverifySimulationReport{versionId,sampleLimit?}
//                                       listAutoverifyDecisions{resultId?,analyteId?,instrumentId?,versionId?,mode?,decision?,reason?,decidedAtFrom,decidedAtTo,sort?,cursor?,limit?}   getAutoverifyDecision{decisionId}
//                                     Authorisation first (before any repo call): #43 `quality.autoverify.manage` (aal2 enforced by the port: auth.mfa_required propagates), #42/#46/#47 `quality.autoverify.read`.
//                                     Access log = `ctx.audit.access(entry)` called by the SERVICE, once, AFTER the read/write succeeded, entry EXACTLY { action, entityType, entityId, outcome: 'allowed' } (02-TRD §5.5 table);
//                                     never on a failed call; a failing audit call propagates (the request tx rolls back). #46 writes no access-log row.
//                                     ../service/autoverify.service.ts (T-15 file): retireAutoverifyVersion (#44) additionally writes { action: 'autoverify.retire', entityType: 'autoverify_version', entityId: <version id>, outcome: 'allowed' }.
//   ../handlers/activation.handlers.ts exports `activationHandlers` (the four operationIds), wired into the manifest like autoverify.handlers.ts.
//
// #43 order: assertRole -> body (`{ confirmation_text: 'ACTIVATE' }`, 400 common.validation_failed) -> If-Match (428) -> load (404) -> version (409 common.version_conflict) -> state machine (409 quality.rule_set_invalid_transition)
//   -> four-eyes: ctx.actor.id !== version.created_by (403 quality.self_activation_forbidden) -> minimums (409 quality.simulation_incomplete) -> write: previous active -> retired FIRST (the partial unique index allows one active),
//   then this version -> active (activated_at = ctx.now(), activated_by = actor), then the rule-set pointers (active_version_id = this, simulating_version_id = null) -> access log.
//   Minimums (02-TRD §8.6): days_running = floor((ctx.now() - simulation_started_at) / 86_400_000) >= sim_min_days AND shadow decisions >= sim_min_decisions; the numbers come from SimulationRepo.getMinimums (absent row -> 7 / 100 [CONV]).
//   ASSUMPTION (not tested): when an author requests activation of an incomplete simulation, either error is acceptable; the tests keep the two conditions apart.
import { vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { ANALYTE, INSTR, MEM, OTHER_USER, TENANT_A, TENANT_B, USER, VER, idN, makeCtx, makeRepo, fullSeed, type FakeSeed, type Row } from './autoverify.helpers.js';
export { ANALYTE, INSTR, MEM, OTHER_USER, TENANT_A, TENANT_B, USER, VER, idN, makeRepo, fullSeed, rejection, code, type Row } from './autoverify.helpers.js';

export const DAY = 86_400_000;
export const SIM_START = '2026-11-02T08:00:00.000Z';               // VER(2) simulation_started_at in fullSeed()
export const at = (ms: number): string => new Date(Date.parse(SIM_START) + ms).toISOString();
export const SEC = 'SENTINEL-PHI-Sita-Karki-7731';                  // must never reach a response
export const PLANTED = 'PLANTED-INTERNAL-7c1e';
export const RESULT = (n: number) => idN(0x9200 + n);
export const ORDER = (n: number) => idN(0x9300 + n);
export const DEC = (n: number) => idN(0x9400 + n);
export const DEC_B = idN(0x94b0);
export const AUDIT_ENTITY = { activate: 'autoverify_version', retire: 'autoverify_version', decision: 'autoverify_decision', report: 'autoverify_version' } as const;
export const ACTIONS = ['autoverify.activate', 'autoverify.retire', 'autoverify_decision.view', 'autoverify_simulation.view'] as const;
export const ACTIVATE_BODY = { confirmation_text: 'ACTIVATE' };

// ---------------------------------------------------------------------------------------------------- SimulationRepo
export interface Minimums { sim_min_days: number; sim_min_decisions: number }
export interface ReportQuery { versionId: string; since: string; sampleLimit: number }
export interface ReportRows {
  decisions: number; would_allow: number; would_deny: number; deny_by_reason: Record<string, number>;
  allow_later_manually_verified: number; allow_not_verified_yet: number;
  live_comparison?: { both_allow: number; live_only_allow: number; shadow_only_allow: number };
  sample: Row[];                                                       // most recent would-allow shadow decisions, <= sampleLimit; { decision_id, result_id, order_id|null, analyte_id, decided_at, shadow_decision, shadow_reasons, live_decision|null, manually_verified_at|null }
}
export interface DecisionQuery { resultId?: string; analyteId?: string; instrumentId?: string; versionId?: string; mode?: string; decision?: string; reason?: string; from: string; to: string; cursor?: string; limit: number }
export interface SimulationRepo {
  getMinimums(tx: any, tenantId: string): Promise<Minimums | undefined>;                                           // quality.settings sim_min_days / sim_min_decisions
  countShadowDecisions(tx: any, tenantId: string, versionId: string, since: string): Promise<number>;             // mode 'shadow', version_id, decided_at >= since
  simulationReport(tx: any, tenantId: string, q: ReportQuery): Promise<ReportRows>;                               // 02-TRD §8.6: shadow rows of V since started_at, left-joined to verification_log on result_id
  listDecisions(tx: any, tenantId: string, q: DecisionQuery): Promise<{ rows: Row[]; nextCursor?: string }>;       // decided_at DESC, id DESC; RLS-invisible rows never appear
  findDecision(tx: any, tenantId: string, id: string): Promise<Row | undefined>;                                   // the full row incl. inputs
}

export const sampleRow = (n: number, o: Row = {}): Row => ({
  decision_id: DEC(n), result_id: RESULT(n), order_id: ORDER(n), analyte_id: ANALYTE(1), decided_at: at(DAY + n * 1000), shadow_decision: 'allow', shadow_reasons: [],
  live_decision: 'allow', manually_verified_at: at(2 * DAY), internal_note: PLANTED, inputs: { value_numeric: '4.2', patient_name: SEC }, ...o,
});
export const reportRows = (o: Partial<ReportRows> = {}): ReportRows => ({
  decisions: 120, would_allow: 90, would_deny: 30, deny_by_reason: { outside_autoverify_limits: 20, instrument_flag: 10 }, allow_later_manually_verified: 80, allow_not_verified_yet: 10,
  live_comparison: { both_allow: 70, live_only_allow: 5, shadow_only_allow: 20 },
  sample: [sampleRow(1), sampleRow(2, { live_decision: 'deny', order_id: null, manually_verified_at: null }), sampleRow(3, { live_decision: null })], ...o,
});
export const decisionRow = (n: number, o: Row = {}): Row => ({
  id: DEC(n), tenant_id: TENANT_A, decided_at: at(DAY + n * 1000), mode: 'live', version_id: VER(4), result_id: RESULT(n), analyte_id: ANALYTE(1), instrument_id: INSTR(1), decision: 'allow', reasons: [],
  matched_rule_key: 'K_ANY', qc_status: 'in_control', qc_run_id: idN(0xa901), created_by: USER, internal_note: PLANTED,
  inputs: { value_numeric: '4.2', range_flag: 'N', delta_check_failed: false, is_critical: false, instrument_flags: ['SYN_FLAG'], resulted_at: at(DAY), patient_name: SEC }, ...o,
});

export interface SimSeed { minimums?: Minimums | null; shadowCount?: number; report?: ReportRows; decisions?: Row[]; failOn?: string }
export function makeSim(seed: SimSeed = {}) {
  const calls: Array<{ op: string; tenantId: string; args: unknown[] }> = [];
  const rec = <T>(op: string, t: string, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId: t, args }); if (seed.failOn === op) throw new LimsError('common.dependency_unavailable'); return fn(); };
  const decisions = seed.decisions ?? [decisionRow(1), decisionRow(2, { mode: 'shadow', version_id: VER(2), decision: 'deny', reasons: ['outside_autoverify_limits'], matched_rule_key: null, instrument_id: null, qc_run_id: null }), decisionRow(9, { id: DEC_B, tenant_id: TENANT_B })];
  const repo: SimulationRepo = {
    async getMinimums(_tx, t) { return rec('getMinimums', t, [], () => (seed.minimums === null ? undefined : (seed.minimums ?? { sim_min_days: 7, sim_min_decisions: 100 }))); },
    async countShadowDecisions(_tx, t, v, since) { return rec('countShadowDecisions', t, [v, since], () => seed.shadowCount ?? 100); },
    async simulationReport(_tx, t, q) { return rec('simulationReport', t, [q], () => structuredClone(seed.report ?? reportRows())); },
    async listDecisions(_tx, t, q) { return rec('listDecisions', t, [q], () => ({ rows: structuredClone(decisions.filter((d) => d['tenant_id'] === t)), nextCursor: 'CURSOR-NEXT' })); },
    async findDecision(_tx, t, id) { return rec('findDecision', t, [id], () => { const r = decisions.find((d) => d['id'] === id && d['tenant_id'] === t); return r ? structuredClone(r) : undefined; }); },
  };
  return { repo, calls, callsOf: (op: string) => calls.filter((c) => c.op === op) };
}

// ---------------------------------------------------------------------------------------------------- scenario
/** fullSeed(): VER(2) simulating (created_by USER, started SIM_START), VER(4) active (pointer), VER(1)/(7) drafts, VER(3) stopped, VER(5) retired, VER(6) discarded. */
export function setup(o: { actor?: string; held?: string[]; aal?: 'aal1' | 'aal2'; now?: string; tenantId?: string; seed?: FakeSeed; sim?: SimSeed; auditFails?: boolean } = {}) {
  const fake = makeRepo(o.seed ?? fullSeed());
  const sim = makeSim(o.sim);
  const c = makeCtx({ ...(o.held ? { held: o.held } : {}), ...(o.aal ? { aal: o.aal } : {}), ...(o.tenantId ? { tenantId: o.tenantId } : {}), now: o.now ?? at(7 * DAY) });
  const audits: Array<Record<string, unknown>> = [];
  c.ctx.actor = { type: 'user', id: o.actor ?? OTHER_USER, membershipId: MEM };
  c.ctx.audit = { access: vi.fn(async (entry: Record<string, unknown>) => { if (o.auditFails) throw new LimsError('common.internal'); audits.push(entry); }) };
  return { ...c, fake, sim, audits, deps: { repo: fake.repo, sim: sim.repo } };
}
export type Scenario = ReturnType<typeof setup>;
export const activateInput = (o: Row = {}): Row => ({ versionId: VER(2), expectedVersion: 1, body: ACTIVATE_BODY, ...o });
