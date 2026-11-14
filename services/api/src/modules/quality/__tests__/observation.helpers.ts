// C9 T-09 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Sibling convention: target.helpers.ts (T-08), setup.helpers.ts (T-06). 02-TRD §6.2 (sync), §6.3 (classification); PRD AC-02.x, AC-05.x.
//
//   ../repository/qcview.repo.ts        exports `SyncRepo` (interface below) + `createQcViewRepo(): SyncRepo`. SQL on the request tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on
//                                       EVERY statement. The ONLY lab object it names is `lab.v_pub_qc_result` (never lab.qc_results). Timestamps are ISO strings with microseconds ('...ffffffZ', exact keyset),
//                                       numeric values are decimal STRINGS, RLS-invisible rows -> undefined. Postgres errors pass through UNCHANGED.
//   ../service/observation.service.ts   exports `createObservationService(deps?: { repo?: SyncRepo; assembler?: RunAssembler; config?: { syncBatch?; syncOverlapSeconds?; syncTimeBudgetSeconds? }; nowMs?: () => number })`
//                                       -> `{ syncQcObservations(ctx): Promise<SyncResult>, classify(ctx, viewRow): Promise<Classification> }`. config defaults = loadQualityConfig() (500 / 600 / 25).
//                                       SyncResult = { imported, duplicates, importErrors, pages, budgetExhausted, counts: Record<status|'import_error', number>, cursor: { at, id } | null }.
//   RunAssembler (T-10 seam)            `assign(ctx, draft: ObservationDraft): Promise<{ qc_run_id: string }>`; called ONLY for a row classified `assigned` that is not yet imported, in §6.3 processing order,
//                                       BEFORE the insert (05-SCHEMA qc_observations__assigned__ck needs qc_run_id). The draft is the row to insert minus qc_run_id. Never called for any other status or for a duplicate.
//   per page                            read page -> drop rows already imported (repo.findExistingSourceIds) -> group by (instrument_id, analyte_id) -> per group: repo.lockPair (SELECT ... FOR UPDATE on the
//                                       plan of the pair; also called for groups with no plan) BEFORE classifying -> rows in (observed_at, received_at, qc_result_id) order -> classify (§6.3 rows 1-9) -> per-row
//                                       `SAVEPOINT qc_row` / `RELEASE SAVEPOINT qc_row` / `ROLLBACK TO SAVEPOINT qc_row` issued by the service on ctx.tx -> repo.insertObservation -> after the page repo.advanceCursor.
//                                       Only SQLSTATE class 22/23 insert errors are `import_error` (skipped; logged as { qc_result_id, sqlstate } only); any other error propagates and aborts the run.
//   target selection                    repo.listTargets returns ALL targets of (plan, lot); the SERVICE keeps status active|superseded with effective_from <= observed_at < effective_to (null = open).
//   lot expiry                          lot.expires_on ('YYYY-MM-DD') < the Asia/Kathmandu calendar date of observed_at (IdentityPort.getTenantSettings(ctx).timezone).
//   z                                   decimal string, half-up to 6 dp, (value - mean) / sd; mean/sd snapshot as decimal strings with 6 dp ('100.000000').
import { LimsError } from '../../../core/errors.js';
import { INS, LOT, LVL, NOW, TENANT_A, TENANT_B, USER, idN, makeCtx as baseCtx, type Row } from './setup.helpers.js';
import { ANA, PLN } from './plan.helpers.js';
export { INS, LOT, LVL, NOW, TENANT_A, TENANT_B, USER, idN, ANA, PLN, type Row };
export { MEM, REQ_ID, UUID7, code, rejection } from './setup.helpers.js';

export const QCR = (n: number) => idN(0xa000 + n);
export const RUN = (n: number) => idN(0xa800 + n);
export const TGT = (n: number) => idN(0x8800 + n);
export const SECRET_RAW = 'RAW-CTRL-SENTINEL-77';   // must never appear in a log line
export const OBS_KEYS = ['analyte_id', 'classified_at', 'control_id_raw', 'control_level_raw', 'control_lot_raw', 'created_by', 'id', 'instrument_id', 'instrument_result_time', 'level_id', 'lot_id', 'mean',
  'observed_at', 'observed_at_basis', 'plan_id', 'qc_run_id', 'received_at', 'sd', 'source', 'source_qc_result_id', 'status', 'target_id', 'tenant_id', 'unit_code', 'updated_by', 'value', 'z'];

/** A row of lab.v_pub_qc_result (03-IC §6.3). created_at is ISO with microseconds. */
export const viewRow = (n: number, o: Row = {}): Row => ({
  tenant_id: TENANT_A, qc_result_id: QCR(n), instrument_id: INS(1), analyte_id: ANA(1), control_id_raw: 'QC-L1', control_lot_raw: 'LOT-SYN-01', control_level: '1', value_numeric: '104', unit_code: 'mmol_l',
  instrument_result_time: '2026-11-13T17:59:00.000000Z', received_at: '2026-11-13T18:00:00.000000Z', source: 'instrument', created_at: '2026-11-13T18:00:00.000000Z', ...o,
});
export const OBSERVED = '2026-11-13T17:59:00.000Z';   // = viewRow's default instrument_result_time (basis 'instrument')

// ---------------------------------------------------------------------------------------------------- repo interface
export interface SyncRepo {
  getSyncState(tx: any, tenantId: string): Promise<{ qc_cursor_at: string; qc_cursor_id: string | null } | undefined>;
  lockSyncState(tx: any, tenantId: string): Promise<void>;                                                                         // SELECT 1 FROM quality.sync_state WHERE tenant_id = $1 FOR UPDATE (serialises sync runs per tenant; review item 2, §6.2 step 4 / E1)
  readFirstPage(tx: any, tenantId: string, q: { cursorAt: string; overlapSeconds: number; limit: number }): Promise<Row[]>;        // created_at >= cursorAt - overlap, ORDER BY created_at, qc_result_id
  readPageAfter(tx: any, tenantId: string, q: { afterAt: string; afterId: string; limit: number }): Promise<Row[]>;                // (created_at, qc_result_id) > (afterAt, afterId)
  findExistingSourceIds(tx: any, tenantId: string, sourceIds: string[]): Promise<string[]>;
  lockPair(tx: any, tenantId: string, instrumentId: string, analyteId: string | null): Promise<void>;
  findActivePlan(tx: any, tenantId: string, instrumentId: string, analyteId: string): Promise<Row | undefined>;                     // { id, composition: [{level_id,count}] } of the ACTIVE plan
  findControlMaps(tx: any, tenantId: string, instrumentId: string, controlIdRaw: string): Promise<Row[]>;                          // ACTIVE maps of (instrument, control_id_raw), exact-lot and wildcard (control_lot_raw null) alike
  findLot(tx: any, tenantId: string, lotId: string): Promise<Row | undefined>;                                                     // { id, level_id, expires_on }
  listTargets(tx: any, tenantId: string, planId: string, lotId: string): Promise<Row[]>;                                           // every target of the key, any status
  latestEvaluatedRunAt(tx: any, tenantId: string, planId: string): Promise<string | undefined>;                                    // run_at of the pair's latest evaluated run
  insertObservation(tx: any, tenantId: string, row: Row): Promise<{ id: string } | undefined>;                                      // ON CONFLICT (tenant_id, source_qc_result_id) DO NOTHING -> undefined
  advanceCursor(tx: any, tenantId: string, k: { at: string; id: string }): Promise<boolean>;                                       // never backwards
}
export interface FakeSeed {
  view?: Row[]; plans?: Row[]; maps?: Row[]; lots?: Row[]; targets?: Row[]; runs?: Array<{ plan_id: string; run_at: string }>;
  instruments?: string[]; analytes?: string[]; observations?: Row[]; cursor?: { qc_cursor_at: string; qc_cursor_id: string | null } | null;
}
const pgErr = (code: string, constraint = '') => Object.assign(new Error('pg error'), { code, constraint });
const ms = (iso: string) => Date.parse(iso.replace(/(\.\d{3})\d*Z$/, '$1Z'));
const cmp = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

export const planRow = (o: Row = {}): Row => ({ id: PLN(1), tenant_id: TENANT_A, instrument_id: INS(1), analyte_id: ANA(1), status: 'active', composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }], ...o });
export const mapRow = (n: number, lot: number, o: Row = {}): Row => ({ id: idN(0x6000 + n), tenant_id: TENANT_A, instrument_id: INS(1), control_id_raw: 'QC-L1', control_lot_raw: null, lot_id: LOT(lot), is_active: true, ...o });
export const lotRow = (n: number, level: number, o: Row = {}): Row => ({ id: LOT(n), tenant_id: TENANT_A, level_id: LVL(level), lot_no: `LOT-SYN-0${n}`, expires_on: '2027-03-31', ...o });
export const targetRow = (n: number, lot: number, o: Row = {}): Row => ({
  id: TGT(n), tenant_id: TENANT_A, plan_id: PLN(1), lot_id: LOT(lot), mean: '100.000000', sd: '2.000000', unit_code: 'mmol_l', status: 'active', effective_from: '2026-10-01T00:00:00.000000Z', effective_to: null, ...o,
});
/** Tenant A, instrument INS(1), analyte ANA(1): active plan PLN(1) {LVL1:1, LVL2:1}; maps QC-L1 -> LOT1 (wildcard), QC-L2 -> LOT2 (wildcard); LOT1 on LVL1, LOT2 on LVL2, LOT4 on LVL2, LOT5 on LVL3 (not in the plan);
 *  active targets for (PLN1, LOT1) and (PLN1, LOT2) (mean 100, sd 2, mmol_l). Tenant B has its own plan/lots/maps/targets (ids differ) and view rows are added by tests. */
export function baseSeed(): FakeSeed {
  return {
    plans: [planRow(), planRow({ id: PLN(9), tenant_id: TENANT_B })],
    maps: [mapRow(1, 1), mapRow(2, 2, { control_id_raw: 'QC-L2' }), mapRow(9, 9, { tenant_id: TENANT_B })],
    lots: [lotRow(1, 1), lotRow(2, 2), lotRow(4, 2), lotRow(5, 3), lotRow(9, 9, { tenant_id: TENANT_B })],
    targets: [targetRow(1, 1), targetRow(2, 2)],
    runs: [],
    instruments: [INS(1), INS(2)], analytes: [ANA(1), ANA(2)],
    observations: [], view: [],
    cursor: { qc_cursor_at: '2026-10-01T00:00:00.000000Z', qc_cursor_id: null },
  };
}

/** In-memory SyncRepo emulating RLS + the explicit tenant predicate, the view, the unique index on (tenant_id, source_qc_result_id), the instrument/analyte FKs and sync_state's never-backwards guard. */
export function makeSyncRepo(seed: FakeSeed = baseSeed(), hooks: { pageOverride?: (kind: 'first' | 'after', rows: Row[]) => Row[]; onPage?: () => void; insertFails?: (row: Row) => Error | undefined; viewFails?: Error } = {}) {
  const view = (seed.view ?? []).map((r) => ({ ...r }));
  const observations: Row[] = (seed.observations ?? []).map((r) => ({ ...r }));
  const state = { cursor: seed.cursor === null ? undefined : { ...(seed.cursor ?? { qc_cursor_at: '2026-10-01T00:00:00.000000Z', qc_cursor_id: null }) } as { qc_cursor_at: string; qc_cursor_id: string | null } | undefined };
  const calls: Array<{ op: string; tenantId?: string; args: unknown[] }> = [];
  const rec = <T>(op: string, tenantId: string | undefined, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId, args }); return fn(); };
  const mine = (xs: Row[], t: string) => xs.filter((x) => x['tenant_id'] === t);
  const key = (r: Row): [string, string] => [r['created_at'], r['qc_result_id']];
  const sorted = (xs: Row[]) => [...xs].sort((a, b) => cmp(key(a), key(b)));
  const page = (kind: 'first' | 'after', rows: Row[]) => { hooks.onPage?.(); const out = structuredClone(rows); return hooks.pageOverride ? hooks.pageOverride(kind, out) : out; };
  const repo: SyncRepo = {
    async getSyncState(_tx, t) { return rec('getSyncState', t, [], () => (state.cursor ? { ...state.cursor } : undefined)); },
    async lockSyncState(_tx, t) { return rec('lockSyncState', t, [], () => undefined); },
    async readFirstPage(_tx, t, q) {
      return rec('readFirstPage', t, [q], () => {
        if (hooks.viewFails) throw hooks.viewFails;
        const floor = ms(q.cursorAt) - q.overlapSeconds * 1000;
        return page('first', sorted(mine(view, t).filter((r) => ms(r['created_at']) >= floor)).slice(0, q.limit));
      });
    },
    async readPageAfter(_tx, t, q) {
      return rec('readPageAfter', t, [q], () => {
        if (hooks.viewFails) throw hooks.viewFails;
        return page('after', sorted(mine(view, t).filter((r) => cmp(key(r), [q.afterAt, q.afterId]) > 0)).slice(0, q.limit));
      });
    },
    async findExistingSourceIds(_tx, t, ids) { return rec('findExistingSourceIds', t, [ids], () => mine(observations, t).map((o) => o['source_qc_result_id']).filter((id) => ids.includes(id))); },
    async lockPair(_tx, t, i, a) { return rec('lockPair', t, [i, a], () => undefined); },
    async findActivePlan(_tx, t, i, a) { return rec('findActivePlan', t, [i, a], () => { const p = mine(seed.plans ?? [], t).find((x) => x['instrument_id'] === i && x['analyte_id'] === a && x['status'] === 'active'); return p ? structuredClone(p) : undefined; }); },
    async findControlMaps(_tx, t, i, raw) { return rec('findControlMaps', t, [i, raw], () => structuredClone(mine(seed.maps ?? [], t).filter((m) => m['is_active'] && m['instrument_id'] === i && m['control_id_raw'] === raw))); },
    async findLot(_tx, t, id) { return rec('findLot', t, [id], () => { const l = mine(seed.lots ?? [], t).find((x) => x['id'] === id); return l ? structuredClone(l) : undefined; }); },
    async listTargets(_tx, t, p, l) { return rec('listTargets', t, [p, l], () => structuredClone(mine(seed.targets ?? [], t).filter((x) => x['plan_id'] === p && x['lot_id'] === l))); },
    async latestEvaluatedRunAt(_tx, t, p) { return rec('latestEvaluatedRunAt', t, [p], () => (seed.runs ?? []).filter((r) => r.plan_id === p).map((r) => r.run_at).sort().pop()); },
    async insertObservation(_tx, t, row) {
      return rec('insertObservation', t, [row], () => {
        const bad = hooks.insertFails?.(row);
        if (bad) throw bad;
        if (!(seed.instruments ?? []).includes(row['instrument_id'])) throw pgErr('23503', 'qc_observations__instrument__fk');
        if (row['analyte_id'] && !(seed.analytes ?? []).includes(row['analyte_id'])) throw pgErr('23503', 'qc_observations__analyte__fk');
        if (row['tenant_id'] !== t) throw pgErr('42501');
        if (row['status'] === 'assigned' && !(row['qc_run_id'] && row['target_id'] && row['mean'] && row['sd'] && row['value'])) throw pgErr('23514', 'qc_observations__assigned__ck');
        if (mine(observations, t).some((o) => o['source_qc_result_id'] === row['source_qc_result_id'])) return undefined;
        observations.push(structuredClone(row));
        return { id: row['id'] };
      });
    },
    async advanceCursor(_tx, t, k) {
      return rec('advanceCursor', t, [k], () => {
        const c = state.cursor!;
        if (cmp([c.qc_cursor_at, c.qc_cursor_id ?? '00000000-0000-0000-0000-000000000000'], [k.at, k.id]) >= 0) return false;
        state.cursor = { qc_cursor_at: k.at, qc_cursor_id: k.id };
        return true;
      });
    },
  };
  return {
    repo, view, observations, state, calls,
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    obsOf: (n: number) => observations.find((o) => o['source_qc_result_id'] === QCR(n)),
    statusOf: (n: number) => observations.find((o) => o['source_qc_result_id'] === QCR(n))?.['status'],
  };
}
export type FakeSync = ReturnType<typeof makeSyncRepo>;

/** Recording RunAssembler: returns RUN(1) for every draft. */
export function makeAssembler(fail?: Error) {
  const drafts: Row[] = [];
  return { drafts, assembler: { async assign(_ctx: unknown, draft: Row) { if (fail) throw fail; drafts.push(structuredClone(draft)); return { qc_run_id: RUN(1) }; } } };
}

/** Service ctx (real shape). tx.query records every statement (SAVEPOINT ...); log captures every call. */
export function makeCtx(over: { tenantId?: string; now?: string } = {}) {
  const b = baseCtx(over);
  const logs: Array<{ level: string; args: unknown[] }> = [];
  b.ctx.log = { info: (...a: unknown[]) => logs.push({ level: 'info', args: a }), warn: (...a: unknown[]) => logs.push({ level: 'warn', args: a }), error: (...a: unknown[]) => logs.push({ level: 'error', args: a }), child() { return this; } };
  return { ...b, logs, logText: () => JSON.stringify(logs) };
}

/** A clock that advances `stepMs` every time `tick()` is called (the fake repo's onPage). */
export function makeClock(stepMs: number) { let t = 1_000_000; return { nowMs: () => t, tick: () => { t += stepMs; } }; }
export { LimsError };
