// AN-T13 test helpers (not a test file). Synthetic data only. Used by pending.summary / pending.items handler tests and pending.security.test.ts.
// Builds on ./helpers.ts (AN-T08: ids, centres/branches, core fake, ctx factory). Three repositories are replaced by in-memory emulators:
//   sourceViews.repo  = lab.v_pub_pending_items seen THROUGH THE CALLER'S TX: the emulator applies the C5 RLS policy that the tx carries (`tx.rls`),
//                       so a service that opens another tx (pool, system actor) reads nothing and fails loudly. No other centre predicate exists.
//   rollups.repo      = analytics.report_backlog (snapshot, scope predicate exactly as TRD §6: `$all OR (centre_id IS NOT NULL AND centre_id = ANY(centres))`)
//   labels.repo       = departments + catalog.v_pub_test_directory
// Handler + service + mapper + labels.service are real. The SQL itself is covered by repository/__tests__/sourceViews.pending.repo.test.ts and rollups.backlog.repo.test.ts.
//
// SEAMS pinned here (the spec leaves repo signatures open; the writer may dispute through the reviewer). All take (tx, args):
//   sourceViews.repo.pendingSummaryRows { tenantId, centreIds?, departmentIds?, priority?, processingBranchIds? }
//        -> [{ item_status, priority, department_id, age_bucket: 'lt_4h'|'h4_24'|'d1_3'|'gt_3d', n, overdue, no_target }]   (TRD §6.7 SQL, GROUP BY 1,2,3,4)
//   sourceViews.repo.pendingItems       { tenantId, centreIds?, departmentIds?, priority?, processingBranchIds?, itemStatuses?, overdueOnly?, sort: '-age_seconds'|'age_seconds',
//                                         after?: { age_seconds, order_item_id }, limit }
//        -> [{ order_item_id, order_id, centre_id, processing_branch_id|null, department_id, test_id, priority, item_status, age_seconds, tat_target_seconds|null }]
//        the service asks for limit + 1 rows to learn whether a next page exists; `centreIds: undefined` = NO centre predicate (D-49), `[]` = match nothing.
//   rollups.repo.backlogRows            { tenantId, scope } -> [{ centre_id, stage: 'awaiting_results'|'ready_unreleased', orders, oldest_registered_at }]  (grouped by centre + stage)
//   The emulator also returns hostile extra columns (patient_name, registration_no, barcode, result_value, received_centre_id): the mapper must drop them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { parse } from 'yaml';
import { vi } from 'vitest';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { TENANTS, actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { REPO_ROOT } from '../../../../core/module.js';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { A1, A2, A3, B1, BR1, BR2, BRB, DEPT, TA, TB, db, makeCore, resetDb, rollupsMock } from './helpers.js';

export * from './helpers.js';

const SEED = 1;
export const SENTINEL = 987_654_321;
export const LABMGR = 'A:user:labmgr';         // lab_manager, all centres: analytics.dashboard.read AND lab.result.read
export const LABMGR_A1 = 'A:user:labmgra1';    // same, restricted to {A1}
// owner_viewer personas (OWNER_ALL / OWNER_A1 / OWNER_MULTI of helpers.ts) hold analytics.dashboard.read and NOT lab.result.read.
export const TEST = { CBC: idFor(SEED, 0xe1), GLU: idFor(SEED, 0xe2) };
export const TEST_NAME = { CBC: 'Complete Blood Count', GLU: 'Glucose Fasting' };
export const oi = (n: number) => idFor(SEED, 0x7100 + n); // order_item_id of item Pn (ascending with n: ties are broken by it)
export const od = (n: number) => idFor(SEED, 0x7200 + n);

// ------------------------------------------------------------------ world
export interface PendingFact {
  tenantId: string; n: number; centreId: string; receivedCentreId: string; processingBranchId: string | null; departmentId: string; testId: string;
  priority: 'routine' | 'urgent'; status: string; age: number; target: number | null;
}
export interface BacklogFact { tenantId: string; centreId: string; stage: 'awaiting_results' | 'ready_unreleased'; ageBucket: string; orders: number; oldest: string }
export const t13 = { items: [] as PendingFact[], backlog: [] as BacklogFact[], tests: [] as { tenantId: string; test_id: string; code: string; name: string; department_id: string | null; is_active: boolean }[] };
export const calls13: { fn: string; args: any; tx: unknown }[] = [];

const P = (n: number, centreId: string, receivedCentreId: string, processingBranchId: string | null, departmentId: string, testId: string,
  priority: 'routine' | 'urgent', status: string, age: number, target: number | null, tenantId = TA): PendingFact =>
  ({ tenantId, n, centreId, receivedCentreId, processingBranchId, departmentId, testId, priority, status, age, target });

/**
 * World (tenant A, "now" is inside the view: age_seconds is given directly). C5 RLS: a user sees items whose collection centre OR receiving centre is one of theirs (D-13).
 *   P1  A1 recv A1  BR1  H CBC routine in_process           3600   target 7200   lt_4h   not overdue
 *   P2  A1 recv A1  BR1  H CBC urgent  awaiting_receipt    14400   target 7200   h4_24   OVERDUE            (14400 is the first second of h4_24)
 *   P3  A2 recv A2  BR1  B GLU routine awaiting_collection 86400   no target     d1_3    no target          (86400 is the first second of d1_3)
 *   P4  A2 recv A2  BR1  B GLU routine resulted           259200   target 259200 gt_3d   NOT overdue (age == target)   (259200 is the first second of gt_3d)
 *   P5  A3 recv A1  BR1  H CBC routine in_process          20000   target 10000  h4_24   OVERDUE            <- collected at A3, processed at hub A1 (D-13)
 *   P6  A3 recv A3  BR2  B GLU urgent  verified           300000   no target     gt_3d   no target
 *   P7  A1 recv A1  none H CBC routine in_process          14399   target 14399  lt_4h   not overdue (age == target), no processing branch
 *   P8  A1 recv A1  BR1  B GLU routine in_process           3600   target 7200   lt_4h   not overdue        (same age as P1: tie-break by order_item_id)
 *   tenant B: PB at B1 with SENTINEL values (never visible to tenant A, whatever the policy emulator says).
 * Backlog (analytics.report_backlog, grouped by centre+stage): A1 awaiting 3 + ready 2, A2 awaiting 4 + ready 1, A3 awaiting 6; tenant B sentinel.
 */
export function seedT13(): void {
  resetDb();
  calls13.length = 0;
  t13.items.length = 0; t13.backlog.length = 0; t13.tests.length = 0;
  t13.items.push(
    P(1, A1, A1, BR1, DEPT.H, TEST.CBC, 'routine', 'in_process', 3600, 7200),
    P(2, A1, A1, BR1, DEPT.H, TEST.CBC, 'urgent', 'awaiting_receipt', 14400, 7200),
    P(3, A2, A2, BR1, DEPT.B, TEST.GLU, 'routine', 'awaiting_collection', 86400, null),
    P(4, A2, A2, BR1, DEPT.B, TEST.GLU, 'routine', 'resulted', 259200, 259200),
    P(5, A3, A1, BR1, DEPT.H, TEST.CBC, 'routine', 'in_process', 20000, 10000),
    P(6, A3, A3, BR2, DEPT.B, TEST.GLU, 'urgent', 'verified', 300000, null),
    P(7, A1, A1, null, DEPT.H, TEST.CBC, 'routine', 'in_process', 14399, 14399),
    P(8, A1, A1, BR1, DEPT.B, TEST.GLU, 'routine', 'in_process', 3600, 7200),
    P(99, B1, B1, BRB, DEPT.FOREIGN, TEST.CBC, 'urgent', 'in_process', SENTINEL, 1, TB),
  );
  const bl = (tenantId: string, centreId: string, stage: BacklogFact['stage'], ageBucket: string, orders: number, oldest: string): BacklogFact => ({ tenantId, centreId, stage, ageBucket, orders, oldest });
  t13.backlog.push(
    bl(TA, A1, 'awaiting_results', 'lt_4h', 2, '2026-11-06T04:00:00.000Z'), bl(TA, A1, 'awaiting_results', 'h4_24', 1, '2026-11-05T20:00:00.000Z'),
    bl(TA, A1, 'ready_unreleased', 'h4_24', 2, '2026-11-05T09:00:00.000Z'),
    bl(TA, A2, 'awaiting_results', 'd1_3', 4, '2026-11-04T01:00:00.000Z'), bl(TA, A2, 'ready_unreleased', 'lt_4h', 1, '2026-11-06T05:00:00.000Z'),
    bl(TA, A3, 'awaiting_results', 'gt_3d', 6, '2026-10-20T00:00:00.000Z'),
    bl(TB, B1, 'awaiting_results', 'gt_3d', SENTINEL, '2000-01-01T00:00:00.000Z'),
  );
  t13.tests.push(
    { tenantId: TA, test_id: TEST.CBC, code: 'CBC', name: TEST_NAME.CBC, department_id: DEPT.H, is_active: true },
    { tenantId: TA, test_id: TEST.GLU, code: 'GLU', name: TEST_NAME.GLU, department_id: DEPT.B, is_active: true },
  );
  db.departments.push(
    { tenantId: TA, department_id: DEPT.H, name: 'Haematology', is_active: true },
    { tenantId: TA, department_id: DEPT.B, name: 'Biochemistry', is_active: true },
    { tenantId: TB, department_id: DEPT.FOREIGN, name: 'Tenant B Radiology', is_active: true },
  );
}

// ------------------------------------------------------------------ emulators
type Rls = { all: boolean; centreIds: readonly string[] };
type Scope = { all: boolean; centreIds: readonly string[] };
const bucket = (age: number) => (age < 14_400 ? 'lt_4h' : age < 86_400 ? 'h4_24' : age < 259_200 ? 'd1_3' : 'gt_3d');
const isOverdue = (f: PendingFact) => f.target !== null && f.age > f.target;
const log = (fn: string, args: unknown, tx: unknown) => { calls13.push({ fn, args, tx }); if (db.fail) throw db.fail; };

/** The rows the CALLER'S TX may see (C5 policy, D-13) + the explicit filters of the call. Nothing else narrows them. */
function visible(tx: any, a: any): PendingFact[] {
  const rls: Rls | undefined = tx?.rls;
  if (!rls) throw new Error('emulator: no RLS context on this tx (the live read must run in the request tx, TRD §6.7)');
  return t13.items.filter((f) => f.tenantId === a.tenantId
    && (rls.all || rls.centreIds.includes(f.centreId) || rls.centreIds.includes(f.receivedCentreId))
    && (a.centreIds === undefined || a.centreIds.includes(f.centreId))
    && (!a.departmentIds?.length || a.departmentIds.includes(f.departmentId))
    && (!a.priority || a.priority === f.priority)
    && (!a.processingBranchIds?.length || (f.processingBranchId !== null && a.processingBranchIds.includes(f.processingBranchId)))
    && (!a.itemStatuses?.length || a.itemStatuses.includes(f.status))
    && (!a.overdueOnly || isOverdue(f)));
}

export const sourceViewsMockT13 = {
  listAgentStatus: vi.fn(async () => []),
  pendingSummaryRows: vi.fn(async (tx: unknown, a: any) => {
    log('pendingSummaryRows', a, tx);
    const g = new Map<string, any>();
    for (const f of visible(tx, a)) {
      const k = [f.status, f.priority, f.departmentId, bucket(f.age)].join('|');
      const r = g.get(k) ?? { item_status: f.status, priority: f.priority, department_id: f.departmentId, age_bucket: bucket(f.age), n: 0, overdue: 0, no_target: 0 };
      r.n += 1; r.overdue += isOverdue(f) ? 1 : 0; r.no_target += f.target === null ? 1 : 0;
      g.set(k, r);
    }
    return [...g.keys()].sort().map((k) => g.get(k));
  }),
  pendingItems: vi.fn(async (tx: unknown, a: any) => {
    log('pendingItems', a, tx);
    const dir = a.sort === 'age_seconds' ? 1 : -1;
    const rows = visible(tx, a).sort((x, y) => (x.age !== y.age ? (x.age - y.age) * dir : x.n - y.n));
    const after = a.after as { age_seconds: number; order_item_id: string } | undefined;
    const past = after
      ? rows.filter((f) => (dir === -1 ? f.age < after.age_seconds : f.age > after.age_seconds) || (f.age === after.age_seconds && oi(f.n) > after.order_item_id))
      : rows;
    return past.slice(0, a.limit).map((f) => ({
      order_item_id: oi(f.n), order_id: od(f.n), centre_id: f.centreId, processing_branch_id: f.processingBranchId, department_id: f.departmentId, test_id: f.testId,
      priority: f.priority, item_status: f.status, age_seconds: f.age, tat_target_seconds: f.target,
      // hostile columns a careless `SELECT *` / spread would leak (C5 order_tests / specimen / patient joins)
      patient_name: 'PLANTED-PATIENT', registration_no: 'PLANTED-REG', barcode: 'PLANTED-BARCODE', result_value: 'PLANTED-RESULT', received_centre_id: f.receivedCentreId,
    }));
  }),
};

export const rollupsMockT13 = {
  ...rollupsMock,
  backlogRows: vi.fn(async (tx: unknown, a: { tenantId: string; scope: Scope }) => {
    log('backlogRows', a, tx);
    const g = new Map<string, { centre_id: string; stage: string; orders: number; oldest_registered_at: string }>();
    for (const f of t13.backlog.filter((x) => x.tenantId === a.tenantId && (a.scope.all || a.scope.centreIds.includes(x.centreId)))) {
      const k = `${f.centreId}|${f.stage}`; const r = g.get(k);
      if (r) { r.orders += f.orders; if (f.oldest < r.oldest_registered_at) r.oldest_registered_at = f.oldest; }
      else g.set(k, { centre_id: f.centreId, stage: f.stage, orders: f.orders, oldest_registered_at: f.oldest });
    }
    return [...g.keys()].sort().map((k) => g.get(k)!);
  }),
};

export const labelsRepoMockT13 = {
  listDepartments: vi.fn(async (_tx: unknown, a: { tenantId: string }) =>
    db.departments.filter((d) => d.tenantId === a.tenantId).map(({ department_id, name, is_active }) => ({ department_id, name, is_active }))),
  listTests: vi.fn(async (_tx: unknown, a: { tenantId: string; ids?: readonly string[] }) =>
    t13.tests.filter((t) => t.tenantId === a.tenantId && (!a.ids || a.ids.includes(t.test_id))).map(({ test_id, code, name, department_id, is_active }) => ({ test_id, code, name, department_id, is_active }))),
  listReferrers: vi.fn(async () => []),
  listInstruments: vi.fn(async () => []),
};

// ------------------------------------------------------------------ actors + ctx
const member = (persona: string, n: number, roles: string[], centreScope: MembershipRow['centreScope']): MembershipRow => ({
  id: idFor(SEED, 0xb00 + n), tenantId: TENANTS.A, actorId: actorIdFor('A', 'user', persona), actorType: 'user',
  displayName: `Test User A-${persona}`, roles, centreScope, branchIds: [], mfaLevel: 'aal2', isLocked: false, status: 'active', email: null, version: 1,
});
const ALLC = { all: true, centreIds: [] as string[] };
const MEMBERS = [
  member('ownerall', 1, ['owner_viewer'], ALLC), member('ownera1', 2, ['owner_viewer'], { all: false, centreIds: [A1] }),
  member('ownermulti', 3, ['owner_viewer'], { all: false, centreIds: [A1, A2] }),
  member('labmgr', 4, ['lab_manager'], ALLC), member('labmgra1', 5, ['lab_manager'], { all: false, centreIds: [A1] }),
];
const RLS_OF: Record<string, Rls> = {
  'A:user:admin': { all: true, centreIds: [] }, 'A:user:ownerall': { all: true, centreIds: [] }, 'A:user:labmgr': { all: true, centreIds: [] },
  'A:user:ownera1': { all: false, centreIds: [A1] }, 'A:user:labmgra1': { all: false, centreIds: [A1] }, 'A:user:ownermulti': { all: false, centreIds: [A1, A2] },
};

/** A fresh ctx = a fresh request. ctx.tx carries the caller's RLS context (what C5's policy would derive from the session claims). `touched` records every core-port / tx use. */
export async function makeCtx13(actorKey: string, over: Record<string, unknown> = {}) {
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: MEMBERS } }) as any;
  const touched: string[] = [];
  const reports = await import('../../service/reports.service.js');
  const tx: any = { rls: RLS_OF[actorKey] ?? { all: false, centreIds: [] }, query: vi.fn(async () => { touched.push('tx.query'); return { rows: [] }; }) };
  const ctx: any = {
    ...makeCtxFor()(actorKey, { now: () => '2026-11-06T06:00:00.000Z', ...over } as any),
    operationId: 'getPendingTestsSummary', clientIp: '127.0.0.1',
    ports: { IdentityPort: identity }, core: makeCore(touched), tx,
    metrics: { inc: vi.fn() }, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: { analytics: { reports } },
  };
  return { ctx, touched, identity, tx };
}

export type Op13 = 'getPendingTestsSummary' | 'listPendingTests';
export async function call13(op: Op13, ctx: any, query: Record<string, unknown> = {}) {
  const { handlers } = await import('../index.js');
  ctx.operationId = op;
  return handlers[op]({ params: {}, query, headers: {}, body: undefined }, ctx);
}
export async function ok13(op: Op13, ctx: any, query: Record<string, unknown> = {}): Promise<any> {
  const r = await call13(op, ctx, query);
  if (r.status !== 200) throw new Error(`expected 200 from ${op}, got ${r.status}`);
  return r.body;
}
export const summary13 = (ctx: any, q: Record<string, unknown> = {}) => ok13('getPendingTestsSummary', ctx, q);
export const items13 = (ctx: any, q: Record<string, unknown> = {}) => ok13('listPendingTests', ctx, q);

// ------------------------------------------------------------------ contract validation: the 200 response schema of the operation in analytics.yaml
const readYaml = (f: string) => parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', f), 'utf8'));
const DOCS = { analytics: readYaml('analytics.yaml'), common: readYaml('_common.yaml') };
type DocName = keyof typeof DOCS;
function deref(node: any, doc: DocName): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, doc));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const [file, ptr = ''] = node.$ref.split('#');
    const target: DocName = file ? 'common' : doc;
    return deref(ptr.split('/').slice(1).reduce((o: any, k: string) => o[k], DOCS[target]), target);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, doc)]));
}
const compile = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => any;
const compiler = compile({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false } });
const PATH_OF: Record<Op13, string> = { getPendingTestsSummary: '/v1/analytics/reports/pending-tests/summary', listPendingTests: '/v1/analytics/reports/pending-tests/items' };
/** ajv errors of `body` against the operation's 200 schema (additionalProperties:false everywhere = the response allow-list); [] = valid. */
export function contractErrors13(op: Op13, body: unknown): string[] {
  const schema = DOCS.analytics.paths[PATH_OF[op]].get.responses['200'].content['application/json'].schema;
  const validate = compiler({ schema: deref(schema, 'analytics') });
  return validate(body) ? [] : (validate.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message}`);
}

export const ids13 = (body: any): string[] => body.data.map((d: any) => d.order_item_id);
export const pn = (...ns: number[]): string[] => ns.map(oi);
