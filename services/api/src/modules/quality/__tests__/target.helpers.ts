// C9 T-08 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Sibling convention: plan.helpers.ts (T-07), setup.helpers.ts (T-06). Plans/levels/catalog fixtures are reused from plan.helpers.ts.
//
//   ../repository/target.repo.ts   exports `TargetRepo` (interface below) + `createTargetRepo(): TargetRepo`. SQL on the request tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on
//                                  EVERY statement (REQ-SEC-022/024/082), schema-qualified quality.* only. Column names = 05-SCHEMA qc_targets verbatim; timestamps ISO strings; numeric columns come back
//                                  as DECIMAL STRINGS (never JS numbers); RLS-invisible rows -> undefined. It has NO method that deletes, and updateTarget can only ever SET the lifecycle columns the trigger
//                                  `qc_targets__mutable_columns` allows (status, effective_from, effective_to, activated_at, activated_by, retired_at, retired_by, retire_reason, updated_at, updated_by);
//                                  version = version + 1 is added by the repo. Postgres errors (unique 23505, trigger P0001 'immutable_row', CHECK 23514) pass through UNCHANGED for the service to map.
//   ../service/target.service.ts   exports `createTargetService(deps?: { repo?: TargetRepo })` -> one async method per operationId #20-#25 `(ctx, input) => { status, body, version? }`:
//                                    listQcTargets{planId?,lotId?,status?(csv string, as on the wire),cursor?,limit?}   createQcTarget{body}   establishQcTarget{body}
//                                    activateQcTarget{targetId,expectedVersion,body}   retireQcTarget{targetId,expectedVersion,body}   discardQcTarget{targetId,expectedVersion,body}
//                                  `body` = the SNAKE_CASE request body exactly as in quality.yaml; `version` = the target row's `version` (the ETag). The service validates bodies itself (defence in depth,
//                                  REQ-SEC-080): 400 common.validation_failed, errors[] = [{ path:'/json/pointer', code:'common.unknown_field'|'common.field_invalid'|'common.field_required' }].
//                                  Order of every operation: assertRole (first, before any repo/port call) -> validate -> (If-Match present? 428) -> load via the tenant-scoped repo (404 when invisible)
//                                  -> version check (409 common.version_conflict) -> state check (409 common.immutable_record) -> write. Reads: quality.qc_run.read; writes: quality.qc.manage (02-TRD §5.0).
//   catalog                        establish: ctx.ports.CatalogPort.getTest(ctx, { testId: plan.test_id }) -> the analyte (plan.analyte_id) gives `decimals` (stored mean/sd = half-up to min(decimals+2, 6) places,
//                                  02-TRD §7.6) and `unitCode` (the established target's unit_code). Statistics = domain/target-stats.ts (T-02), values are decimal STRINGS end to end.
//   lot expiry                     today = the tenant calendar day (IdentityPort.getTenantSettings timezone; setup.service tenantToday): lot.expires_on < today -> 422 quality.lot_expired (#21 only).
//   job enqueue                    #23 runs `ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['quality.reprocess_pending_observations', JSON.stringify({tenant_id, plan_id}), 'reproc:<plan_id>'])`
//                                  AFTER the updates, in the same transaction (03-APP-FLOW §2.5: "Activating a target enqueues reprocess_pending_observations for the plan").
//   transaction                    every repo call receives `ctx.tx`; the service never opens/commits/rolls back a transaction or savepoint itself (the core owns the tx).
//   dto users                      created_by_display / activated_by_display via repo.listUserLabels (same OPEN seam as plan.helpers.ts / .orchestra/cr/C9.T-15.md); placeholder, never the raw id.
import { LimsError } from '../../../core/errors.js';
import { ANA, CATALOG, PLN, TST, makeCatalog, makePlanCtx, planRow } from './plan.helpers.js';
import { INS, INS_B, LOT, LVL, NOW, TENANT_A, TENANT_B, USER, idN, type Row } from './setup.helpers.js';
export { ANA, CATALOG, PLN, TST, makeCatalog, makePlanCtx, INS, INS_B, LOT, LVL, NOW, TENANT_A, TENANT_B, USER, idN, type Row };
export { MEM, REQ_ID, UUID7, code, forbidden, readOnly, noRights, rejection } from './setup.helpers.js';

export const TGT = (n: number) => idN(0x8800 + n);
export const OBS = (n: number) => idN(0x9000 + n);
export const OTHER_USER = idN(0xd9);
export const PLANTED = 'PLANTED-INTERNAL-7c1e';
export const OPS = ['listQcTargets', 'createQcTarget', 'establishQcTarget', 'activateQcTarget', 'retireQcTarget', 'discardQcTarget'] as const;
export const DTO_KEYS = ['activated_by_display', 'basis', 'created_by_display', 'cv_pct', 'effective_from', 'effective_to', 'id', 'level_id', 'lot_id', 'mean', 'note', 'plan_id', 'sd', 'source', 'status', 'unit_code', 'version'];
export const MUTABLE = ['status', 'effective_from', 'effective_to', 'activated_at', 'activated_by', 'retired_at', 'retired_by', 'retire_reason', 'updated_at', 'updated_by', 'version'];
export const FROM = '2026-11-01T00:00:00.000Z';   // establish range used by the fixtures
export const TO = '2026-11-12T00:00:00.000Z';
export const FUTURE = '2026-11-20T00:00:00.000Z';  // a valid effective_from (>= NOW)
export const PAST = '2026-11-01T00:00:00.000Z';

// ---------------------------------------------------------------------------------------------------- bodies
export const createBody = (o: Row = {}): Row => ({ plan_id: PLN(1), lot_id: LOT(1), mean: '100.0', sd: '2.0', unit_code: 'mmol_l', source: 'manufacturer', ...o });
export const estBody = (o: Row = {}): Row => ({ plan_id: PLN(1), lot_id: LOT(1), observed_at_from: FROM, observed_at_to: TO, ...o });

// ---------------------------------------------------------------------------------------------------- fixtures (rows as the repo returns them)
const audit = { created_at: '2026-11-01T08:00:00.000Z', created_by: USER, updated_at: '2026-11-01T08:00:00.000Z', updated_by: USER, internal_note: PLANTED };
export const lotRow = (n: number, level: number, o: Row = {}): Row => ({
  id: LOT(n), tenant_id: TENANT_A, level_id: LVL(level), material_id: idN(0x3001), lot_no: `LOT-SYN-0${n}`, expires_on: '2026-12-31', is_active: true, version: 1, ...audit, ...o,
});
export const targetRow = (n: number, plan: number, lot: number, level: number, o: Row = {}): Row => ({
  id: TGT(n), tenant_id: TENANT_A, plan_id: PLN(plan), lot_id: LOT(lot), level_id: LVL(level), mean: '100.000000', sd: '2.000000', unit_code: 'mmol_l', source: 'manufacturer', status: 'draft',
  is_active: true, version: 1, ...audit, ...o,
});
/** An observation as listEstablishCandidates returns it (raw: the SERVICE applies the population rule). */
export const obsRow = (n: number, o: Row = {}): Row => ({
  id: OBS(n), tenant_id: TENANT_A, plan_id: PLN(1), lot_id: LOT(1), value: '100', status: 'assigned', run_outcome: 'accepted', observed_at: '2026-11-05T08:00:00.000Z', ...o,
});
/** 25 clean observations of (PLN(1), LOT(1)): values 98,99,100,101,102 x5 (mean 100, sample SD = sqrt(50/24) = 1.4433756729...), runs accepted / accepted_warning, inside [FROM, TO]. */
export const cleanObs = (): Row[] => Array.from({ length: 25 }, (_, i) => obsRow(i + 1, {
  value: String(100 + (i % 5) - 2), run_outcome: i % 2 ? 'accepted_warning' : 'accepted', observed_at: `2026-11-${String(2 + (i % 9)).padStart(2, '0')}T08:00:00.000Z`,
}));
/** Observations that are NOT in the establish population: each alone must leave n / digest unchanged. */
export const NOISE: Array<[string, Row]> = [
  ['rejected run', obsRow(30, { value: '110', run_outcome: 'rejected' })],
  ['assigned, run not evaluated (outcome null)', obsRow(31, { value: '110', run_outcome: null })],
  ['status excluded', obsRow(32, { value: '110', status: 'excluded', run_outcome: 'accepted' })],
  ['status no_plan', obsRow(33, { value: '110', status: 'no_plan', run_outcome: null })],
  ['status late_unassigned', obsRow(34, { value: '110', status: 'late_unassigned', run_outcome: null })],
  ['status import_error', obsRow(35, { value: '110', status: 'import_error', run_outcome: null })],
  ['observed before the range', obsRow(36, { value: '110', observed_at: '2026-10-31T23:59:59.000Z' })],
  ['observed after the range', obsRow(37, { value: '110', observed_at: '2026-11-12T00:00:01.000Z' })],
  ['other lot', obsRow(38, { value: '110', lot_id: LOT(2) })],
  ['other plan', obsRow(39, { value: '110', plan_id: PLN(2) })],
  ['tenant B', obsRow(40, { value: '110', tenant_id: TENANT_B })],
  ['non-numeric value (null)', obsRow(41, { value: null })],
];

export interface Seed { plans?: Row[]; lots?: Row[]; targets?: Row[]; observations?: Row[]; compositions?: Record<string, Array<{ level_id: string; count: number }>>; settings?: Row; users?: Row[] }
/**
 * Tenant A: PLN(1) K on I1 (active, test TST(1), analyte ANA(1) = Potassium mmol/L 1 dp; composition L1:1 + L2:1), PLN(2) GLU (ANA(3), 2 dp; L1 + L2). Tenant B: PLN(9).
 * Lots: LOT(1) level L1 (LOT-SYN-01), LOT(2) level L2, LOT(3) level L3 (NOT in any seeded composition), LOT(4) level L1 EXPIRED 2026-11-13 (today in Asia/Kathmandu is 2026-11-14), LOT(9) tenant B.
 * Targets: TGT(1) ACTIVE (PLN(1), LOT(1), mean 100 sd 2, from 2026-11-01); TGT(2) DRAFT same key (mean 101, sd 2.5) = "T2"; TGT(3) DRAFT (PLN(1), LOT(2)) with no active target on its key;
 *          TGT(4) SUPERSEDED, TGT(5) RETIRED, TGT(6) DISCARDED (all PLN(1)/LOT(1)); TGT(9) tenant B ACTIVE. Observations: none (see cleanObs). Settings: none (target_min_points defaults to 20).
 */
export function baseSeed(): Seed {
  const win = { effective_from: '2026-11-01T00:00:00.000Z' };
  return {
    plans: [planRow(1, { status: 'active' }), planRow(2, { analyte_id: ANA(3) }), planRow(9, { tenant_id: TENANT_B, instrument_id: INS_B, status: 'active' })],
    lots: [lotRow(1, 1), lotRow(2, 2), lotRow(3, 3), lotRow(4, 1, { expires_on: '2026-11-13' }), lotRow(9, 9, { tenant_id: TENANT_B })],
    compositions: { [PLN(1)]: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }], [PLN(2)]: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }], [PLN(9)]: [{ level_id: LVL(9), count: 2 }] },
    targets: [
      targetRow(1, 1, 1, 1, { status: 'active', activated_at: '2026-10-31T08:00:00.000Z', activated_by: USER, ...win }),
      targetRow(2, 1, 1, 1, { mean: '101.000000', sd: '2.500000' }),
      targetRow(3, 1, 2, 2),
      targetRow(4, 1, 1, 1, { status: 'superseded', effective_from: '2026-09-01T00:00:00.000Z', effective_to: '2026-11-01T00:00:00.000Z', mean: '99.000000' }),
      targetRow(5, 1, 1, 1, { status: 'retired', retired_at: '2026-10-01T00:00:00.000Z', retired_by: USER, retire_reason: 'old', effective_from: '2026-08-01T00:00:00.000Z' }),
      targetRow(6, 1, 1, 1, { status: 'discarded' }),
      targetRow(9, 9, 9, 9, { tenant_id: TENANT_B, status: 'active', ...win }),
    ],
    observations: [], users: [{ tenant_id: TENANT_A, user_id: USER, display_name: 'Synthetic Lab Manager' }, { tenant_id: TENANT_A, user_id: OTHER_USER, display_name: 'Synthetic Technologist' }],
  };
}
/** baseSeed with NO targets at all (clean slate for AC-04.1 create -> activate). */
export const emptyTargets = (): Seed => ({ ...baseSeed(), targets: [] });

// ---------------------------------------------------------------------------------------------------- repo interface
export interface Page<T = Row> { rows: T[]; nextCursor?: string }
export interface TargetRepo {
  listTargets(tx: any, tenantId: string, q: { planId?: string; lotId?: string; statuses?: string[]; cursor?: string; limit: number }): Promise<Page>;
  findTarget(tx: any, tenantId: string, id: string): Promise<Row | undefined>;
  findActiveTarget(tx: any, tenantId: string, planId: string, lotId: string): Promise<Row | undefined>;   // the target with status='active' for the key (plan x lot), at most one
  insertTarget(tx: any, tenantId: string, row: Row): Promise<Row>;
  updateTarget(tx: any, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined>;   // undefined = version mismatch (WHERE version = $n, version = version + 1)
  findPlan(tx: any, tenantId: string, id: string): Promise<Row | undefined>;                      // quality.qc_plans row: id, test_id, analyte_id, status, ...
  currentComposition(tx: any, tenantId: string, planId: string): Promise<Array<{ level_id: string; count: number }> | undefined>;   // composition of the version whose version_no = plan.current_version_no
  findLot(tx: any, tenantId: string, id: string): Promise<Row | undefined>;                        // quality.control_lots row: id, level_id, lot_no, expires_on ('YYYY-MM-DD'), is_active
  listEstablishCandidates(tx: any, tenantId: string, q: { planId: string; lotId: string; from: string; to: string }): Promise<Row[]>;   // RAW observations of plan x lot with observed_at in [from, to]:
                                                                                                          //   { id, value (decimal string | null), status, observed_at, run_outcome (qc_runs.outcome | null) }
  getSettings(tx: any, tenantId: string): Promise<Row | undefined>;                                // quality.settings row (target_min_points); undefined = defaults
  listUserLabels(tx: any, tenantId: string, userIds: string[]): Promise<Array<{ user_id: string; display_name: string }>>;
}

export const pgErr = (code: string, constraint?: string, message = 'pg error') => Object.assign(new Error(message), { code, ...(constraint ? { constraint } : {}) });
/** What the trigger qc_targets__mutable_columns raises (db/tests/core/T0B-03: `EP0001:immutable_row`). */
export const immutableRow = () => pgErr('P0001', undefined, 'immutable_row');
const COLUMNS = ['id', 'tenant_id', 'plan_id', 'lot_id', 'level_id', 'mean', 'sd', 'unit_code', 'source', 'basis_n', 'basis_from', 'basis_to', 'basis_observation_ids_sha256', 'note', 'status', 'effective_from', 'effective_to', 'created_by', 'updated_by'];

/** In-memory repo: tenant-aware like RLS + the explicit predicate; emulates the 05-SCHEMA constraints (sd>0, source, basis, sha hex, status, effective, window, text), the unknown-column error, the
 *  active-per-key partial unique index, the version check and the `qc_targets__mutable_columns` trigger (a changed immutable column -> P0001 immutable_row). */
export function makeTargetRepo(seed: Seed = baseSeed()) {
  const targets = (seed.targets ?? []).map((r) => ({ ...r })), plans = seed.plans ?? [], lots = seed.lots ?? [], observations = seed.observations ?? [], users = seed.users ?? [];
  const compositions = seed.compositions ?? {};
  const calls: Array<{ op: string; tenantId?: string; tx: unknown; args: unknown[] }> = [];
  const rec = <T>(op: string, tx: unknown, tenantId: string | undefined, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId, tx, args }); return fn(); };
  const mine = (xs: Row[], t: string) => xs.filter((x) => x['tenant_id'] === t);
  const check = (n: Row) => {
    if (!(Number(n['sd']) > 0)) throw pgErr('23514', 'qc_targets__sd__ck');
    if (!['manufacturer', 'established'].includes(n['source'])) throw pgErr('23514', 'qc_targets__source__ck');
    if (n['source'] === 'established' && !(n['basis_n'] >= 2 && n['basis_from'] && n['basis_to'])) throw pgErr('23514', 'qc_targets__basis__ck');
    if (n['basis_observation_ids_sha256'] != null && !/^[0-9a-f]{64}$/.test(n['basis_observation_ids_sha256'])) throw pgErr('23514', 'qc_targets__basis_sha__ck');
    if (!['draft', 'active', 'superseded', 'retired', 'discarded'].includes(n['status'])) throw pgErr('23514', 'qc_targets__status__ck');
    if (!['draft', 'discarded'].includes(n['status']) && !n['effective_from']) throw pgErr('23514', 'qc_targets__effective__ck');
    if (n['effective_to'] && !(Date.parse(n['effective_to']) > Date.parse(n['effective_from']))) throw pgErr('23514', 'qc_targets__window__ck');
    if (String(n['note'] ?? '').length > 500 || String(n['retire_reason'] ?? '').length > 500) throw pgErr('23514', 'qc_targets__text__ck');
    if (n['status'] === 'active' && targets.some((x) => x['id'] !== n['id'] && x['tenant_id'] === n['tenant_id'] && x['plan_id'] === n['plan_id'] && x['lot_id'] === n['lot_id'] && x['status'] === 'active')) throw pgErr('23505', 'qc_targets__tenant_plan_lot_active__p_uq');
  };
  const repo: TargetRepo = {
    async listTargets(tx, t, q) {
      return rec('listTargets', tx, t, [q], () => {
        const rows = mine(targets, t).filter((r) => (!q.planId || r['plan_id'] === q.planId) && (!q.lotId || r['lot_id'] === q.lotId) && (!q.statuses || q.statuses.includes(r['status'])));
        return { rows: structuredClone(rows) };
      });
    },
    async findTarget(tx, t, id) { return rec('findTarget', tx, t, [id], () => { const r = mine(targets, t).find((x) => x['id'] === id); return r ? structuredClone(r) : undefined; }); },
    async findActiveTarget(tx, t, planId, lotId) {
      return rec('findActiveTarget', tx, t, [planId, lotId], () => { const r = mine(targets, t).find((x) => x['plan_id'] === planId && x['lot_id'] === lotId && x['status'] === 'active'); return r ? structuredClone(r) : undefined; });
    },
    async insertTarget(tx, t, row) {
      return rec('insertTarget', tx, t, [row], () => {
        for (const k of Object.keys(row)) if (!COLUMNS.includes(k)) throw pgErr('42703', undefined, `column "${k}" of relation "qc_targets" does not exist`);
        for (const k of ['id', 'plan_id', 'lot_id', 'level_id', 'mean', 'sd', 'unit_code', 'source', 'created_by', 'updated_by']) if (row[k] == null) throw pgErr('23502', undefined, `null value in column "${k}"`);
        if (!mine(plans, t).some((p) => p['id'] === row['plan_id'])) throw pgErr('23503', 'qc_targets__plan__fk');
        if (!mine(lots, t).some((l) => l['id'] === row['lot_id'])) throw pgErr('23503', 'qc_targets__lot__fk');
        const r: Row = { status: 'draft', is_active: true, version: 1, created_at: NOW, updated_at: NOW, ...row, tenant_id: t }; check(r); targets.push(r); return structuredClone(r);
      });
    },
    async updateTarget(tx, t, id, v, patch) {
      return rec('updateTarget', tx, t, [id, v, patch], () => {
        const r = mine(targets, t).find((x) => x['id'] === id);
        if (!r || r['version'] !== v) return undefined;
        for (const [k, val] of Object.entries(patch)) if (!MUTABLE.includes(k) && val !== r[k]) throw immutableRow();
        const next = { ...r, ...patch, version: r['version'] + 1, updated_at: NOW }; check(next); Object.assign(r, next); return structuredClone(r);
      });
    },
    async findPlan(tx, t, id) { return rec('findPlan', tx, t, [id], () => { const r = mine(plans, t).find((x) => x['id'] === id); return r ? structuredClone(r) : undefined; }); },
    async currentComposition(tx, t, planId) { return rec('currentComposition', tx, t, [planId], () => (mine(plans, t).some((p) => p['id'] === planId) ? structuredClone(compositions[planId]) : undefined)); },
    async findLot(tx, t, id) { return rec('findLot', tx, t, [id], () => { const r = mine(lots, t).find((x) => x['id'] === id); return r ? structuredClone(r) : undefined; }); },
    async listEstablishCandidates(tx, t, q) {
      return rec('listEstablishCandidates', tx, t, [q], () => structuredClone(mine(observations, t).filter((o) => o['plan_id'] === q.planId && o['lot_id'] === q.lotId && o['observed_at'] >= q.from && o['observed_at'] <= q.to)
        .map((o) => ({ id: o['id'], value: o['value'], status: o['status'], observed_at: o['observed_at'], run_outcome: o['run_outcome'] }))));
    },
    async getSettings(tx, t) { return rec('getSettings', tx, t, [], () => (seed.settings ? structuredClone(seed.settings) : undefined)); },
    async listUserLabels(tx, t, ids) { return rec('listUserLabels', tx, t, [ids], () => mine(users, t).filter((u) => ids.includes(u['user_id'])).map((u) => ({ user_id: u['user_id'], display_name: u['display_name'] }))); },
  };
  return {
    repo, targets, calls,
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    mutations: () => calls.filter((c) => /^(insert|update)/.test(c.op)),
    byId: (id: string) => targets.find((x) => x['id'] === id),
    activeOf: (planId: string, lotId: string, t = TENANT_A) => targets.filter((x) => x['tenant_id'] === t && x['plan_id'] === planId && x['lot_id'] === lotId && x['status'] === 'active'),
  };
}
export type FakeTargetRepo = ReturnType<typeof makeTargetRepo>;

export { LimsError };
export const ctxFor = makePlanCtx;
