// C9 T-20 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Spec: 02-TRD §5.8 (#51-#54), §5.10 (DTO allowlists), §12.1 (ranges, bootstrap), 05-SCHEMA §2 (settings, g_cs_*, cs_*), §2 coded-set table ("tenant rows shadow global rows by code"),
//       PRD AC-15.1, 07-SECURITY REQ-SEC-024/040/080/081 + S-01, contracts/openapi/quality.yaml (#51-#54, QualitySettingsDto, QualityCode, QcPlanParamsDefaults).
//
//   ../repository/settings.repo.ts   keeps its T-01 exports (insertSettingsDefaults, getSettings, insertSyncState; `getSettings` now also returns `updated_at`) and ADDS these module-level functions.
//                                    SQL on the caller's tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on every tenant-table statement, no DELETE, no other schema than quality.
//                                    `set` is the wire set_name ('corrective_actions' | 'exclusion_reasons'); the table name comes from a fixed allowlist, never from the input string.
//     updateSettings(tx, tenantId, expectedVersion, patch, actorId): Promise<Row | undefined>
//         UPDATE quality.settings SET <patch columns>, version = version + 1, updated_at = now(), updated_by = $actor WHERE tenant_id = $t AND version = $v RETURNING <COLS>; undefined = version mismatch.
//         `patch` = snake_case columns, exactly the nine mutable ones (tat_alerts_enabled … reprocess_window_days, default_plan_params as an object). Never activated_at / tenant_id / version / is_active / id.
//     listGlobalCodes(tx, set): Promise<Row[]>                       quality.g_cs_<set>: { code, display, sort_order, is_active }   (global table: no tenant column, no tenant predicate)
//     listTenantCodes(tx, tenantId, set): Promise<Row[]>             quality.cs_<set> WHERE tenant_id = $1: { code, display, sort_order, is_active }
//     upsertTenantCode(tx, tenantId, set, a: { id, code, display, sortOrder, isActive, actorId }): Promise<Row>
//         INSERT INTO quality.cs_<set> ... ON CONFLICT (tenant_id, code) DO UPDATE ... RETURNING { code, display, sort_order, is_active }   (race-safe, no check-then-insert)
//   ../service/settings.service.ts   `createSettingsService()` keeps `ensure(tx, { tenantId, actorId })` and ADDS, each `(ctx, input) => Promise<{ status: 200, body, version? }>`:
//         getQualitySettings(ctx, {})                        updateQualitySettings(ctx, { expectedVersion, body })
//         listQualityCodedSet(ctx, { setName })              upsertQualityCode(ctx, { setName, code, body })
//     Order: ctx.ports.IdentityPort.assertRole(ctx, { permission }) FIRST (before validation, ensure, any repo call): #51/#53 quality.qc_run.read, #52/#54 quality.config.manage ->
//            validate -> ensure (#51, #52) -> reads/writes. Tenant and actor only from ctx. #52: expectedVersion undefined -> 428 common.precondition_required (after validation: 400 wins);
//            stale or lost race -> 409 common.version_conflict. Validation = 400 common.validation_failed, errors[] = [{ path: '/json/pointer', code: 'common.unknown_field' | 'common.field_invalid' | 'common.field_required' }].
//            westgard_mode / auto_verification_enabled come from ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: [...] }) ({ westgardMode, autoVerificationEnabled }); absent -> 'classic' / false (§12.1).
//            #53: global rows + the tenant's rows, a tenant row SHADOWS the global row with the same code (source 'tenant'), ordered (sort_order, code), at most 500; unknown set -> 400 (path '/set_name').
//            #54: code must match the DB check ^[a-z][a-z0-9_]{1,63}$ (else 400 path '/code', never a DB error); 200 + the QualityCode (source 'tenant'); a body for a global code creates the tenant override.
//   ../handlers/settings.handlers.ts exports `settingsHandlers` ({ getQualitySettings, updateQualitySettings, listQualityCodedSet, upsertQualityCode }) merged into handlers/index.ts behind the phase switch.
//
// The repo module is replaced by the in-memory fake below (vi.mock factory: `async () => (await import('./settings.helpers.js')).fakeRepoModule()`); tests call `store.reset()` in beforeEach.
import { idN, makeCtx, NOW, TENANT_A, TENANT_B, USER, type Row } from './setup.helpers.js';
export { idN, makeCtx, NOW, TENANT_A, TENANT_B, USER, type Row };
export { rejection, code, forbidden, readOnly, noRights, PLANTED, REQ_ID, UUID7 } from './setup.helpers.js';

export const LATER = '2026-11-13T19:05:00.000Z';
export const ACTIVATED = '2026-07-16T03:15:00.000Z';
export const SETS = ['corrective_actions', 'exclusion_reasons'] as const;
export const SETTINGS_KEYS = ['version', 'tat_alerts_enabled', 'tat_warn_pct', 'tat_escalate_pct', 'tat_orphan_close_hours', 'target_min_points', 'sim_min_days', 'sim_min_decisions',
  'reprocess_window_days', 'default_plan_params', 'activated_at', 'updated_at', 'updated_by_display', 'westgard_mode', 'auto_verification_enabled'];
export const MUTABLE = ['tat_alerts_enabled', 'tat_warn_pct', 'tat_escalate_pct', 'tat_orphan_close_hours', 'target_min_points', 'sim_min_days', 'sim_min_decisions', 'reprocess_window_days', 'default_plan_params'];
export const CODE_KEYS = ['code', 'display', 'is_active', 'sort_order', 'source'];
export const DEFAULTS = { tat_alerts_enabled: true, tat_warn_pct: 80, tat_escalate_pct: 150, tat_orphan_close_hours: 72, target_min_points: 20, sim_min_days: 7, sim_min_decisions: 100, reprocess_window_days: 7 };
export const SET_ID = (n: number) => idN(0x7000 + n);

/** The full mutable body of #52 (the contract example). */
export const body = (o: Row = {}): Row => ({
  ...DEFAULTS, tat_warn_pct: 85, tat_escalate_pct: 200,
  default_plan_params: { mean_rule: '10x', two_two_s_across_runs: true, count_rules_across_materials: true, exclude_rejected_runs_from_history: true, run_window_minutes: 30, qc_validity_hours: 24, hold_lookback_hours: 24 },
  ...o,
});

/** makeCtx + a C2 IdentityPort.getTenantSettings that answers westgardMode / autoVerificationEnabled (undefined fields = C2 has nothing stored). */
export function makeSettingsCtx(over: { tenantId?: string; roles?: (c: { permission: string }) => void; c2?: Row } = {}) {
  const t = makeCtx({ ...(over.tenantId ? { tenantId: over.tenantId } : {}), ...(over.roles ? { roles: over.roles } : {}) });
  const asked: unknown[] = [];
  t.ctx.ports.IdentityPort.getTenantSettings = async (_c: unknown, q: unknown) => { asked.push(q); return { timezone: 'Asia/Kathmandu', ...(over.c2 ?? { westgardMode: 'classic', autoVerificationEnabled: false }) }; };
  return { ...t, asked };
}

const GLOBAL_SEED: Record<string, Row[]> = {
  corrective_actions: [
    { code: 'recalibration', display: 'Recalibrated', sort_order: 10, is_active: true }, { code: 'new_control_vial', display: 'New control vial', sort_order: 20, is_active: true },
    { code: 'other', display: 'Other', sort_order: 900, is_active: true },
  ],
  exclusion_reasons: [
    { code: 'wrong_material', display: 'Wrong control material', sort_order: 10, is_active: true }, { code: 'handling_error', display: 'Handling error', sort_order: 20, is_active: true },
    { code: 'other', display: 'Other', sort_order: 900, is_active: true },
  ],
};

export interface Call { op: string; tenantId?: string; args: unknown[] }
/** Shared in-memory state of the fake repo module (one per test file; `reset()` in beforeEach). Tenant-aware like RLS + the explicit predicate. */
export const store = {
  settings: new Map<string, Row>(), syncState: new Map<string, Row>(), globals: {} as Record<string, Row[]>, tenant: [] as Array<Row & { set: string; tenant_id: string }>, calls: [] as Call[],
  reset() {
    this.settings.clear(); this.syncState.clear(); this.calls = []; this.tenant = [];
    this.globals = structuredClone(GLOBAL_SEED);
  },
  /** Pre-seed a tenant's settings row (production rows are created lazily by ensure). */
  seedSettings(tenantId: string, o: Row = {}) {
    this.settings.set(tenantId, { id: SET_ID(tenantId === TENANT_A ? 1 : 2), tenant_id: tenantId, ...DEFAULTS, default_plan_params: {}, activated_at: ACTIVATED, is_active: true, version: 1, updated_at: ACTIVATED, updated_by: USER, ...o });
  },
  of(op: string) { return this.calls.filter((c) => c.op === op); },
  writes() { return this.calls.filter((c) => /^(insert|update|upsert)/.test(c.op)); },
  addTenantCode(tenantId: string, set: string, r: Row) { this.tenant.push({ is_active: true, ...r, set, tenant_id: tenantId } as any); },
};
store.reset();

const pgErr = (set: string) => { if (!(SETS as readonly string[]).includes(set)) throw new Error(`fake repo: unknown set ${set}`); };
const code4 = (r: Row) => ({ code: r['code'], display: r['display'], sort_order: r['sort_order'], is_active: r['is_active'] });

/** The module the service imports as ../repository/settings.repo.js (T-01 functions + T-20 additions). */
export function fakeRepoModule() {
  const rec = <R>(op: string, tenantId: string | undefined, args: unknown[], fn: () => R): R => { store.calls.push({ op, tenantId, args }); return fn(); };
  return {
    async insertSettingsDefaults(_tx: unknown, a: { id: string; tenantId: string; actorId: string }) {
      return rec('insertSettingsDefaults', a.tenantId, [a], () => {
        if (!store.settings.has(a.tenantId)) store.settings.set(a.tenantId, { id: a.id, tenant_id: a.tenantId, ...DEFAULTS, default_plan_params: {}, activated_at: NOW, is_active: true, version: 1, updated_at: NOW, created_by: a.actorId, updated_by: a.actorId });
        return { rows: [] };
      });
    },
    async getSettings(_tx: unknown, tenantId: string) { return rec('getSettings', tenantId, [], () => { const r = store.settings.get(tenantId); return r ? structuredClone(r) : undefined; }); },
    async insertSyncState(_tx: unknown, a: { id: string; tenantId: string; activatedAt: unknown }) {
      return rec('insertSyncState', a.tenantId, [a], () => { if (!store.syncState.has(a.tenantId)) store.syncState.set(a.tenantId, { id: a.id, tenant_id: a.tenantId }); return { rows: [] }; });
    },
    async updateSettings(_tx: unknown, tenantId: string, expectedVersion: number, patch: Row, actorId: string) {
      return rec('updateSettings', tenantId, [expectedVersion, patch, actorId], () => {
        const r = store.settings.get(tenantId);
        if (!r || r['version'] !== expectedVersion) return undefined;
        Object.assign(r, structuredClone(patch), { version: r['version'] + 1, updated_at: LATER, updated_by: actorId });
        return structuredClone(r);
      });
    },
    async listGlobalCodes(_tx: unknown, set: string) { return rec('listGlobalCodes', undefined, [set], () => { pgErr(set); return structuredClone(store.globals[set] ?? []).map(code4); }); },
    async listTenantCodes(_tx: unknown, tenantId: string, set: string) {
      return rec('listTenantCodes', tenantId, [set], () => { pgErr(set); return store.tenant.filter((r) => r.tenant_id === tenantId && r.set === set).map(code4); });
    },
    async upsertTenantCode(_tx: unknown, tenantId: string, set: string, a: { id: string; code: string; display: string; sortOrder: number; isActive: boolean; actorId: string }) {
      return rec('upsertTenantCode', tenantId, [set, a], () => {
        pgErr(set);
        const row = store.tenant.find((r) => r.tenant_id === tenantId && r.set === set && r['code'] === a.code);
        if (row) Object.assign(row, { display: a.display, sort_order: a.sortOrder, is_active: a.isActive });
        else store.tenant.push({ set, tenant_id: tenantId, code: a.code, display: a.display, sort_order: a.sortOrder, is_active: a.isActive } as any);
        return code4(store.tenant.find((r) => r.tenant_id === tenantId && r.set === set && r['code'] === a.code)!);
      });
    },
  };
}
