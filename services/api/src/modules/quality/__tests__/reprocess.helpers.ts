// C9 T-11 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Spec: 02-TRD §6.4 (re-processing + "Adopting Phase-1 history", 08 A17 D-60), §6.3 (rows 1-10), 03-APP-FLOW §1 status table; PRD AC-02.4, AC-04.7.
//
//   ../service/observation.service.ts   `createObservationService(deps?)` (T-09) gains `reprocessPending(ctx, scope: { instrument_id?: string; plan_id?: string }): Promise<ReprocessResult>`.
//                                       ReprocessResult = { reclassified, adopted, unchanged, counts }: reclassified = in-window rows whose status changed; adopted = older-than-window `no_plan` rows
//                                       whose status changed (D-60); unchanged = candidates examined whose status did not change (no UPDATE for them); counts = Record<new status, number> over the changed rows.
//                                       Exactly one of instrument_id / plan_id is given (neither -> rejects before any repo call). Runs on ctx.tx (the worker job tx). Clock = ctx.now() only.
//   ReprocessRepo (T-11 seam)           `SyncRepo` (T-09, observation.helpers.ts) PLUS four methods the writer adds to ../repository/qcview.repo.ts (or a sibling repo merged into `deps.repo`):
//                                       getReprocessWindowDays(tx, t): number                     -- quality.settings.reprocess_window_days of the tenant
//                                       findPlan(tx, t, planId): { id, instrument_id, analyte_id, status } | undefined   -- RLS + explicit tenant predicate; foreign / unknown plan -> undefined
//                                       listPendingObservations(tx, t, q: { instrumentId; analyteId?; statuses: string[]; observedFrom?; observedBefore? }): Row[]
//                                                                                                 -- stored qc_observations rows (ISO timestamps, decimal-string numerics) ordered observed_at, received_at,
//                                                                                                    source_qc_result_id; observedFrom inclusive, observedBefore exclusive; analyteId undefined = every analyte
//                                                                                                    of the instrument (analyte_id NOT NULL)
//                                       updateObservation(tx, t, id, expectedStatus, patch): boolean  -- UPDATE ... WHERE tenant_id AND id AND status = expectedStatus (optimistic guard); false = lost a race
//                                       patch keys are ONLY: status, plan_id, level_id, lot_id, target_id, mean, sd, z, qc_run_id, classified_at, updated_by.
//   scope + window                      plan_id -> findPlan -> the pair (instrument, analyte) of that ACTIVE plan; instrument_id -> every analyte of the instrument.
//                                       within window = observed_at >= ctx.now() - reprocess_window_days; statuses = the five of §6.4. Older than the window: ONLY plan scope, ONLY status `no_plan` (D-60).
//   per row                             re-run §6.3 with the STORED observation (observed_at, value, unit, control raws as stored), `SAVEPOINT qc_row` / `RELEASE SAVEPOINT qc_row` /
//                                       `ROLLBACK TO SAVEPOINT qc_row` on ctx.tx; an `assigned` result calls assembler.assign(ctx, draft) BEFORE the update (draft = stored row id + classification, no qc_run_id);
//                                       adoption (older no_plan) runs rows 4-8 only and turns "would be assigned" into late_unassigned (never calls the assembler).
//                                       Only SQLSTATE class 22/23 update errors are skipped (logged as { id, sqlstate } only, counted); anything else propagates.
import { INS, LOT, LVL, NOW, TENANT_A, TENANT_B, QCR, baseSeed, makeAssembler, makeCtx, makeSyncRepo, mapRow, lotRow, planRow, targetRow, ANA, PLN, RUN, TGT, SECRET_RAW, type FakeSeed, type Row } from './observation.helpers.js';
export { INS, LOT, LVL, NOW, TENANT_A, TENANT_B, QCR, baseSeed, makeAssembler, makeCtx, makeSyncRepo, mapRow, lotRow, planRow, targetRow, ANA, PLN, RUN, TGT, SECRET_RAW, type FakeSeed, type Row };
export { rejection } from './setup.helpers.js';

export const OBS = (n: number) => idOf(0xc000 + n);
function idOf(n: number): string { return `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`; }

export const IN_WINDOW = '2026-11-13T17:59:00.000Z';    // 1 h before NOW (2026-11-13T19:00Z)
export const OLD = '2026-09-01T08:00:00.000Z';          // far older than the default 7-day window
export const PATCH_KEYS = ['classified_at', 'level_id', 'lot_id', 'mean', 'plan_id', 'qc_run_id', 'sd', 'status', 'target_id', 'updated_by', 'z'];
export const PENDING = ['level_not_in_plan', 'no_plan', 'no_target', 'unit_mismatch', 'unmapped_control'];

/** A stored qc_observations row (what listPendingObservations returns). Defaults: pending `unmapped_control`, QC-L1, 104 mmol_l, observed 1 h ago, no plan snapshot yet. */
export const obsRow = (n: number, status: string, o: Row = {}): Row => ({
  id: OBS(n), tenant_id: TENANT_A, source_qc_result_id: QCR(n), source: 'instrument', instrument_id: INS(1), analyte_id: ANA(1), control_id_raw: 'QC-L1', control_lot_raw: 'LOT-SYN-01', control_level_raw: '1',
  value: '104.000000', unit_code: 'mmol_l', instrument_result_time: IN_WINDOW, received_at: IN_WINDOW, observed_at: IN_WINDOW, observed_at_basis: 'instrument', status,
  plan_id: null, level_id: null, lot_id: null, target_id: null, mean: null, sd: null, z: null, qc_run_id: null, classified_at: '2026-11-13T18:00:00.000Z', created_by: 'u', updated_by: 'u', ...o,
});

export interface ReprocessHooks { windowDays?: number; lost?: (id: string) => boolean; updateFails?: (id: string, patch: Row) => Error | undefined }

/** FakeSyncRepo (T-09) + the four T-11 methods. `observations` is the shared table. Honest to every filter it is given (statuses, window bounds, tenant, instrument/analyte). */
export function makeReprocessRepo(seed: FakeSeed = baseSeed(), hooks: ReprocessHooks = {}) {
  const f = makeSyncRepo(seed);
  const updates: Array<{ id: string; expectedStatus: string; patch: Row }> = [];
  const ms = (iso: string) => Date.parse(iso);
  const rec = <T>(op: string, tenantId: string, args: unknown[], fn: () => T): T => { f.calls.push({ op, tenantId, args }); return fn(); };
  const repo = {
    ...f.repo,
    async getReprocessWindowDays(_tx: any, t: string) { return rec('getReprocessWindowDays', t, [], () => hooks.windowDays ?? 7); },
    async findPlan(_tx: any, t: string, planId: string) {
      return rec('findPlan', t, [planId], () => { const p = (seed.plans ?? []).find((x) => x['tenant_id'] === t && x['id'] === planId); return p ? { id: p['id'], instrument_id: p['instrument_id'], analyte_id: p['analyte_id'], status: p['status'] } : undefined; });
    },
    async listPendingObservations(_tx: any, t: string, q: { instrumentId: string; analyteId?: string; statuses: string[]; observedFrom?: string; observedBefore?: string }) {
      return rec('listPendingObservations', t, [q], () => structuredClone(f.observations
        .filter((o) => o['tenant_id'] === t && o['instrument_id'] === q.instrumentId && o['analyte_id'] != null && (q.analyteId === undefined || o['analyte_id'] === q.analyteId)
          && q.statuses.includes(o['status']) && (q.observedFrom === undefined || ms(o['observed_at']) >= ms(q.observedFrom)) && (q.observedBefore === undefined || ms(o['observed_at']) < ms(q.observedBefore)))
        .sort((a, b) => ms(a['observed_at']) - ms(b['observed_at']) || (a['received_at'] < b['received_at'] ? -1 : a['received_at'] > b['received_at'] ? 1 : 0) || (a['source_qc_result_id'] < b['source_qc_result_id'] ? -1 : 1))));
    },
    async updateObservation(_tx: any, t: string, id: string, expectedStatus: string, patch: Row) {
      return rec('updateObservation', t, [id, expectedStatus, patch], () => {
        const bad = hooks.updateFails?.(id, patch);
        if (bad) throw bad;
        const o = f.observations.find((x) => x['tenant_id'] === t && x['id'] === id);
        if (!o || o['status'] !== expectedStatus || hooks.lost?.(id)) return false;
        if (patch['status'] === 'assigned' && !(patch['qc_run_id'] && patch['target_id'] && patch['mean'] && patch['sd'])) throw Object.assign(new Error('pg error'), { code: '23514', constraint: 'qc_observations__assigned__ck' });
        Object.assign(o, patch);
        updates.push({ id, expectedStatus, patch: structuredClone(patch) });
        return true;
      });
    },
  };
  return { ...f, repo, updates, byId: (id: string) => f.observations.find((o) => o['id'] === id) as Row, statusOf2: (n: number) => f.observations.find((o) => o['id'] === OBS(n))?.['status'] };
}
export type FakeReprocess = ReturnType<typeof makeReprocessRepo>;

/** baseSeed + stored observations. Adds the maps / lots / targets the adoption table needs when `rich` (all inactive in nothing else). */
export function seedWith(observations: Row[], o: { runs?: FakeSeed['runs']; plans?: Row[]; rich?: boolean } = {}): FakeSeed {
  const s = baseSeed();
  s.observations = observations;
  if (o.runs) s.runs = o.runs;
  if (o.plans) s.plans = o.plans;
  if (o.rich) {
    s.targets = [targetRow(1, 1, { effective_from: '2026-08-01T00:00:00.000000Z' }), targetRow(2, 2, { effective_from: '2026-08-01T00:00:00.000000Z' }), targetRow(6, 6, { effective_from: '2026-08-01T00:00:00.000000Z' })];
    s.lots = [...(s.lots ?? []), lotRow(6, 1, { expires_on: '2026-08-31' })];
    s.maps = [...(s.maps ?? []), mapRow(3, 4, { control_id_raw: 'QC-L3' }), mapRow(4, 5, { control_id_raw: 'QC-L5' }), mapRow(5, 6, { control_id_raw: 'QC-LX' })];
  }
  return s;
}
