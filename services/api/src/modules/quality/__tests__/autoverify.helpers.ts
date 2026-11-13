// C9 T-15 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
//
//   ../domain/autoverify-dsl.ts       exports `validateRuleSetDefinition(def: unknown, catalog?: ReadonlyMap<string, CatalogTest | undefined>): DslError[]` (pure, never throws, returns EVERY error)
//                                       DslError = { path: '/json/pointer' (relative to the definition root, '' = root), code: 'common.unknown_field' | 'common.field_required' | 'common.field_invalid' }
//                                       `catalog` maps test_id -> { analytes: [{ id, resultType }] } | undefined (= unknown test). Without it only the structural checks run (02-TRD §8.2).
//   ../domain/ruleset.state.ts        exports `type VersionStatus`, `type VersionAction = 'edit'|'startSimulation'|'stopSimulation'|'activate'|'retire'|'discard'`,
//                                       `nextStatus(from, action): VersionStatus` (throws LimsError('quality.rule_set_invalid_transition')), `isTerminal(status): boolean` (03-APP-FLOW §2.3, D-55).
//   ../repository/autoverify.repo.ts  exports `AutoverifyRepo` (below) + `createAutoverifyRepo(): AutoverifyRepo` (SQL on the request tx, parameterised, explicit `tenant_id = $n` on EVERY statement).
//                                       Column names = 05-SCHEMA §2 (autoverify_rule_sets / autoverify_versions) verbatim. Timestamps ISO strings, RLS-invisible rows -> undefined.
//   ../service/autoverify.service.ts  exports `createAutoverifyService(deps?: { repo?: AutoverifyRepo })` -> one async method per operationId #36-#41, #44, #45 `(ctx, input) => { status, body, version? }`:
//                                       getAutoverifyRuleSet{}   createAutoverifyVersion{body}   getAutoverifyVersion{versionId}   replaceAutoverifyDraft{versionId,expectedVersion,body}
//                                       startAutoverifySimulation{versionId,expectedVersion,body}   stopAutoverifySimulation{versionId,expectedVersion,body}
//                                       retireAutoverifyVersion{versionId,expectedVersion,body}   discardAutoverifyDraft{versionId,expectedVersion,body}
//                                     `body` = the snake_case request body as in quality.yaml; the service validates it itself (400 common.validation_failed, errors[] = [{path,code}]).
//                                     Authorisation: the SERVICE calls ctx.ports.IdentityPort.assertRole(ctx, { permission }) FIRST (before any repo/port call): reads
//                                     `quality.autoverify.read`, every other op `quality.autoverify.manage`. aal2 is enforced by the port for that privileged permission: it throws
//                                     LimsError('auth.mfa_required'), which the service lets propagate (no catch/remap) — 02-TRD §5.0, 07-SECURITY S-08.
//                                     Catalog check: ctx.ports.CatalogPort.getTest(ctx, { testId }) once per distinct test_id; a LimsError('common.not_found') = unknown test -> error at /definition/rules/<i>/test_id;
//                                     any other port failure propagates (fail closed, nothing written).
//                                     Pointers of #37/#39 422 errors are relative to the REQUEST body: '/definition' + the DSL pointer.
//                                     expectedVersion undefined -> 428 common.precondition_required; stale -> 409 common.version_conflict (also when repo.updateVersion returns undefined).
//                                     ids by the service (uuidv7); created_by/updated_by/simulation_started_by/retired_by = ctx.actor.id; tenant_id only from ctx.tenantId; clock = ctx.now().
import { LimsError } from '../../../core/errors.js';
import { idN, TENANT_A, TENANT_B, USER, MEM, REQ_ID, NOW, type Row } from './setup.helpers.js';
export { idN, TENANT_A, TENANT_B, USER, MEM, REQ_ID, NOW, rejection, code, forbidden, UUID7, type Row } from './setup.helpers.js';

export const OTHER_USER = idN(0xd9);
export const RULE_SET = idN(0x7000), RULE_SET_B = idN(0x7b00);
export const VER = (n: number) => idN(0x7100 + n);
export const VER_B = idN(0x71b0);
export const TEST = (n: number) => idN(0x7200 + n);
export const ANALYTE = (n: number) => idN(0x7300 + n);
export const INSTR = (n: number) => idN(0x7400 + n);
export const PLANTED = 'PLANTED-INTERNAL-7c1e';
export const RETIRE_BODY = { reason: 'Superseded by the revised potassium limits' };

/** A valid rule: potassium-like, numeric analyte n of test 1. */
export const rule = (n: number, o: Row = {}): Row => ({
  key: `K_${n}`, test_id: TEST(1), analyte_id: ANALYTE(n), enabled: true, limits: { low: '3.5', high: '5.1' }, allowed_range_flags: ['N'],
  instrument_flags_allowed: [], qc_allow_warning: false, note: 'Synthetic potassium rule', ...o,
});
export const def = (...rules: Row[]): Row => ({ schema_version: 1, rules });
export const DEF1 = def(rule(1));

/** Catalog as CatalogPort.getTest sees it: TEST(1) has numeric analytes 1,2 and ordinal analyte 3; TEST(2) has numeric analyte 4. TEST(9) is unknown. */
export const catalogMap = (): Map<string, { analytes: Array<{ id: string; resultType: string }> } | undefined> => new Map<string, any>([
  [TEST(1), { analytes: [{ id: ANALYTE(1), resultType: 'numeric' }, { id: ANALYTE(2), resultType: 'numeric' }, { id: ANALYTE(3), resultType: 'ordinal' }] }],
  [TEST(2), { analytes: [{ id: ANALYTE(4), resultType: 'numeric' }] }],
  [TEST(9), undefined],
]);

// ---------------------------------------------------------------------------------------------------- fixtures (rows as the repo returns them)
export const setRow = (o: Row = {}): Row => ({
  id: RULE_SET, tenant_id: TENANT_A, active_version_id: null, simulating_version_id: null, is_active: true, version: 1,
  created_at: '2026-11-01T08:00:00.000Z', created_by: USER, updated_at: '2026-11-01T08:00:00.000Z', updated_by: USER, ...o,
});
export const verRow = (n: number, status: string, o: Row = {}): Row => ({
  id: VER(n), tenant_id: TENANT_A, rule_set_id: RULE_SET, version_no: n, status, definition: structuredClone(DEF1), rule_count: 1,
  simulation_started_at: null, simulation_started_by: null, simulation_stopped_at: null, activated_at: null, activated_by: null, retired_at: null, retired_by: null, retire_reason: null,
  is_active: true, version: 1, created_at: '2026-11-01T08:00:00.000Z', created_by: USER, updated_at: '2026-11-01T08:00:00.000Z', updated_by: USER, internal_note: PLANTED, ...o,
});
export interface FakeSeed { sets?: Row[]; versions?: Row[]; users?: Row[] }
/** Tenant A: rule set with v1 draft, v2 simulating (simulating pointer), v3 stopped, v4 active (active pointer), v5 retired, v6 discarded, v7 draft. Tenant B: its own set + one draft. */
export function fullSeed(): FakeSeed {
  const sim = { simulation_started_at: '2026-11-02T08:00:00.000Z', simulation_started_by: USER };
  return {
    sets: [setRow({ active_version_id: VER(4), simulating_version_id: VER(2) }), setRow({ id: RULE_SET_B, tenant_id: TENANT_B })],
    versions: [
      verRow(1, 'draft'), verRow(2, 'simulating', sim), verRow(3, 'stopped', { ...sim, simulation_stopped_at: '2026-11-03T08:00:00.000Z' }),
      verRow(4, 'active', { ...sim, activated_at: '2026-11-10T08:00:00.000Z', activated_by: OTHER_USER }),
      verRow(5, 'retired', { activated_at: '2026-11-05T08:00:00.000Z', activated_by: OTHER_USER, retired_at: '2026-11-09T08:00:00.000Z', retired_by: OTHER_USER, retire_reason: 'old' }),
      verRow(6, 'discarded'), verRow(7, 'draft'),
      verRow(1, 'draft', { id: VER_B, tenant_id: TENANT_B, rule_set_id: RULE_SET_B }),
    ],
    users: [{ tenant_id: TENANT_A, user_id: USER, display_name: 'Synthetic Pathologist' }, { tenant_id: TENANT_A, user_id: OTHER_USER, display_name: 'Synthetic Lab Manager' }],
  };
}
export const emptySeed = (): FakeSeed => ({ sets: [], versions: [], users: [{ tenant_id: TENANT_A, user_id: USER, display_name: 'Synthetic Pathologist' }] });

// ---------------------------------------------------------------------------------------------------- repo interface
export interface AutoverifyRepo {
  findRuleSet(tx: any, tenantId: string): Promise<Row | undefined>;                                           // one per tenant
  insertRuleSet(tx: any, tenantId: string, row: Row): Promise<Row>;
  updateRuleSet(tx: any, tenantId: string, id: string, patch: Row): Promise<Row>;                              // pointers: active_version_id / simulating_version_id (null clears)
  listVersions(tx: any, tenantId: string, ruleSetId: string): Promise<Row[]>;                                  // every version, any order
  findVersion(tx: any, tenantId: string, id: string): Promise<Row | undefined>;
  insertVersion(tx: any, tenantId: string, row: Row): Promise<Row>;                                            // row has version_no
  updateVersion(tx: any, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined>;   // undefined = version mismatch; 23505 on the partial unique indexes
  listUserLabels(tx: any, tenantId: string, userIds: string[]): Promise<Array<{ user_id: string; display_name: string }>>;
}
const pgErr = (code: string, constraint: string) => Object.assign(new Error('pg error'), { code, constraint });

/** In-memory repo, tenant-aware like RLS + the explicit predicate; emulates the partial unique indexes (one simulating, one active per tenant) of 05-SCHEMA §2. */
export function makeRepo(seed: FakeSeed = fullSeed()) {
  const sets = (seed.sets ?? []).map((r) => ({ ...r }));
  const versions = (seed.versions ?? []).map((r) => structuredClone(r));
  const users = seed.users ?? [];
  const calls: Array<{ op: string; tenantId: string; args: unknown[] }> = [];
  const rec = <T>(op: string, t: string, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId: t, args }); return fn(); };
  const mine = (xs: Row[], t: string) => xs.filter((x) => x['tenant_id'] === t);
  const repo: AutoverifyRepo = {
    async findRuleSet(_tx, t) { return rec('findRuleSet', t, [], () => { const r = mine(sets, t)[0]; return r ? structuredClone(r) : undefined; }); },
    async insertRuleSet(_tx, t, row) {
      return rec('insertRuleSet', t, [row], () => {
        if (mine(sets, t).length) throw pgErr('23505', 'autoverify_rule_sets__tenant__uq');
        const r = { is_active: true, version: 1, active_version_id: null, simulating_version_id: null, ...row, tenant_id: t }; sets.push(r); return structuredClone(r);
      });
    },
    async updateRuleSet(_tx, t, id, patch) {
      return rec('updateRuleSet', t, [id, patch], () => { const r = mine(sets, t).find((x) => x['id'] === id)!; Object.assign(r, patch, { version: r['version'] + 1 }); return structuredClone(r); });
    },
    async listVersions(_tx, t, rs) { return rec('listVersions', t, [rs], () => structuredClone(mine(versions, t).filter((v) => v['rule_set_id'] === rs))); },
    async findVersion(_tx, t, id) { return rec('findVersion', t, [id], () => { const r = mine(versions, t).find((v) => v['id'] === id); return r ? structuredClone(r) : undefined; }); },
    async insertVersion(_tx, t, row) {
      return rec('insertVersion', t, [row], () => {
        if (mine(versions, t).some((v) => v['rule_set_id'] === row['rule_set_id'] && v['version_no'] === row['version_no'])) throw pgErr('23505', 'autoverify_versions__set_version__uq');
        const r = { status: 'draft', is_active: true, version: 1, ...row, tenant_id: t }; versions.push(r); return structuredClone(r);
      });
    },
    async updateVersion(_tx, t, id, v, patch) {
      return rec('updateVersion', t, [id, v, patch], () => {
        const r = mine(versions, t).find((x) => x['id'] === id);
        if (!r || r['version'] !== v) return undefined;
        for (const s of ['simulating', 'active']) {
          if (patch['status'] === s && mine(versions, t).some((x) => x['id'] !== id && x['status'] === s)) throw pgErr('23505', `autoverify_versions__tenant_${s}__p_uq`);
        }
        Object.assign(r, patch, { version: r['version'] + 1 }); return structuredClone(r);
      });
    },
    async listUserLabels(_tx, t, ids) { return rec('listUserLabels', t, [ids], () => mine(users, t).filter((u) => ids.includes(u['user_id'])).map((u) => ({ user_id: u['user_id'], display_name: u['display_name'] }))); },
  };
  return {
    repo, sets, versions, calls,
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    mutations: () => calls.filter((c) => /^(insert|update)/.test(c.op)),
    ver: (n: number) => versions.find((v) => v['id'] === VER(n) && v['tenant_id'] === TENANT_A)!,
    set: () => sets.find((s) => s['tenant_id'] === TENANT_A)!,
  };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

// ---------------------------------------------------------------------------------------------------- ctx
/** Permission model of the port: `aal` 'aal1' makes the PRIVILEGED permission (quality.autoverify.manage) throw auth.mfa_required AFTER the forbidden check; `held` lists granted permissions. */
export function makeCtx(over: { tenantId?: string; held?: string[]; aal?: 'aal1' | 'aal2'; now?: string; catalog?: Map<string, any>; catalogDown?: boolean } = {}) {
  const tenantId = over.tenantId ?? TENANT_A;
  const held = over.held ?? ['quality.autoverify.read', 'quality.autoverify.manage'];
  const aal = over.aal ?? 'aal2';
  const asserted: Array<{ permission: string }> = [];
  const catalog = over.catalog ?? catalogMap();
  const getTestCalls: string[] = [];
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const ctx: any = {
    tenantId, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, now: () => over.now ?? NOW,
    tx: { async query(text: string, values: unknown[] = []) { queries.push({ text, values }); return { rows: [] }; } },
    ports: {
      IdentityPort: {
        assertRole: async (_c: unknown, r: { permission: string }) => {
          asserted.push(r);
          if (!held.includes(r.permission)) throw new LimsError('auth.forbidden');
          if (r.permission === 'quality.autoverify.manage' && aal !== 'aal2') throw new LimsError('auth.mfa_required');
        },
      },
      CatalogPort: {
        getTest: async (_c: unknown, i: { testId: string }) => {
          getTestCalls.push(i.testId);
          if (over.catalogDown) throw new LimsError('common.dependency_unavailable');
          const t = catalog.get(i.testId);
          if (!t) throw new LimsError('common.not_found');
          return t;
        },
      },
    },
    audit: { access: async () => undefined },
    log: { info() {}, warn() {}, error() {} },
  };
  return { ctx, asserted, getTestCalls, queries };
}

export const READ_OPS = ['getAutoverifyRuleSet', 'getAutoverifyVersion'] as const;
export const MANAGE_OPS = ['createAutoverifyVersion', 'replaceAutoverifyDraft', 'startAutoverifySimulation', 'stopAutoverifySimulation', 'retireAutoverifyVersion', 'discardAutoverifyDraft'] as const;
export const OPS = [...READ_OPS, ...MANAGE_OPS] as const;
/** A valid input per op against fullSeed (tenant A); expectedVersion 1 matches every seeded row. */
export const validInput = (op: (typeof OPS)[number]): Row => ({
  getAutoverifyRuleSet: {},
  createAutoverifyVersion: { body: { definition: DEF1 } },
  getAutoverifyVersion: { versionId: VER(1) },
  replaceAutoverifyDraft: { versionId: VER(1), expectedVersion: 1, body: { definition: def(rule(2)) } },
  startAutoverifySimulation: { versionId: VER(1), expectedVersion: 1, body: {} },
  stopAutoverifySimulation: { versionId: VER(2), expectedVersion: 1, body: {} },
  retireAutoverifyVersion: { versionId: VER(4), expectedVersion: 1, body: RETIRE_BODY },
  discardAutoverifyDraft: { versionId: VER(1), expectedVersion: 1, body: {} },
}[op]);
