// T0B-TESTMGMT-1 harness (LD-318, LD-310 blanket authority, LD-325). Catalog handlers are driven like the frontdesk REGAPI tests: a request-shaped object plus a
// HandlerContext over a REAL PG17 tx (lims_api, RLS on, audit triggers live), responses checked against catalog.yaml with ajv. The core pipeline (schema, auth,
// x-permission, Idempotency-Key) is NOT re-run; permissions are asserted statically from the contract (boot.test.ts) and, for publish, through the fake IdentityPort.
// Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL (tests/catalog/T0B-TESTMGMT-1.pg.sh boots a throwaway PG17, migrated through 20261117170000). Synthetic data only.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createEvents } from '../../../../core/events/publish.js';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid } from '../../../frontdesk/__tests__/integration/helpers.js';

export { SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid };
export const T = 120_000;

export const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
export const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`);
};

export const tag = (n = 6): string => Array.from({ length: n }, () => 'BCDFGHJKLMNPQRSTVWXZ'[Math.floor(Math.random() * 20)]).join('');
export const MEM = { a: '01a1a98a-ac40-7000-8000-00000000a500', b: '01a1a98a-ac40-7000-8000-00000000b500' } as const;

export const PERM = { manage: 'catalog.test.manage', read: 'catalog.test.read', publish: 'catalog.reference_range.publish' } as const;
export type Reply = { status: number; body?: any; headers?: Record<string, string> };
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
export const im = (version: number) => ({ 'if-match': `"${version}"` });
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<Reply>>;
const WRITE = /^\s*(insert|update|delete|truncate)\b/i;

export interface CallOpts { tenant?: string; grants?: readonly string[]; now?: string }
export interface Called extends Reply { writes: string[]; assertCalls: string[]; requestId: string }

/** One request = one committed tx under `tenant`'s claims (RLS on); a throw rolls back. `writes` = the write statements the request issued (domain-first proofs). */
let registryDone = false;
/** core events.publish enqueues 'core.event_fanout'; the job registry row must exist (same fixture as frontdesk registration/helpers.ts ensureTaskRegistry) */
async function ensureTaskRegistry(): Promise<void> {
  if (registryDone) return;
  await superTx(async (tx) => { await tx.query(`INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('core.event_fanout','core','core','per_tenant',25) ON CONFLICT DO NOTHING`); });
  registryDone = true;
}

export async function call(operationId: string, r: ReturnType<typeof req>, o: CallOpts = {}): Promise<Called> {
  await ensureTaskRegistry();
  const tenant = o.tenant ?? TENANT_A;
  const grants = o.grants ?? [PERM.manage, PERM.read, PERM.publish];
  const writes: string[] = []; const assertCalls: string[] = []; const requestId = uid();
  const out = await appTx(tenant, async (raw) => {
    (raw as any).startedAt = new Date();
    const tx = { startedAt: (raw as any).startedAt, query: async (text: string, values?: unknown[]) => { if (WRITE.test(text)) writes.push(text); return raw.query(text, values); } };
    const ctx: any = {
      operationId, tenantId: tenant, tx, requestId, now: o.now ? () => o.now! : () => new Date().toISOString(), clientIp: '203.0.113.9',
      actor: { type: 'user', id: SYS_ACTOR, membershipId: tenant === TENANT_B ? MEM.b : MEM.a },
      log: { info() {}, warn() {}, error() {}, debug() {} }, metrics: { inc: () => undefined },
      events: createEvents({ producer: 'catalog' }),
      ports: { IdentityPort: {
        async assertRole(_c: unknown, rq: { permission: string }) { assertCalls.push(rq.permission); if (!grants.includes(rq.permission)) throw new LimsError('auth.forbidden'); },
        async getActor() { return { actor: { type: 'user', id: SYS_ACTOR }, permissions: [...grants], mfa: { enrolled: true, level: 'aal2' } }; },
      } },
    };
    return H[operationId]!(r, ctx);
  });
  return { ...out, writes, assertCalls, requestId };
}
export const fails = async (operationId: string, r: ReturnType<typeof req>, o: CallOpts = {}): Promise<any> => {
  try { await call(operationId, r, o); } catch (e) { return e; }
  throw new Error(`${operationId}: expected a rejection, got success`);
};
export const errPaths = (e: any): string[] => (e?.errors ?? []).map((x: { path: string }) => x.path);
/** standard validation error (400 common.validation_failed) naming `path`, and (domain-first) no write statement was issued by the rejected request. */
export async function expectInvalid(operationId: string, r: ReturnType<typeof req>, path: string, o: CallOpts = {}): Promise<void> {
  let writes: string[] = [];
  let err: any;
  try { const c = await call(operationId, r, o); writes = c.writes; err = new Error(`accepted: HTTP ${c.status}`); } catch (e) { err = e; }
  expect400(err, path);
  expect(writes, 'no write on a rejected input').toEqual([]);
}
import { expect } from 'vitest';
export function expect400(e: any, path: string): void {
  expect(e?.code, `${e?.code ?? e?.message}`).toBe('common.validation_failed');
  expect(e.statusCode).toBe(400);
  expect(errPaths(e), 'field path').toContain(path);
}
export function expectCode(e: any, code: string, status: number): void { expect(e?.code, `${e?.code ?? e?.message}`).toBe(code); expect(e.statusCode).toBe(status); }

// ------------------------------------------------------------------ fixtures built through the real handlers
export interface World { tenant: string; dept: any; dept2: any; spec: any; method: any; unit: any; valueSet: any }
export async function world(tenant: string = TENANT_A): Promise<World> {
  const o = { tenant };
  const mk = async (op: string, body: object) => (await call(op, req({ body, headers: { 'idempotency-key': uid() } }), o)).body;
  const t = tag();
  const [dept, dept2, sp, method, unit] = [
    await mk('createDepartment', { code: `D${t}`, name: `Dept ${t}`, report_order: 1 }),
    await mk('createDepartment', { code: `E${t}`, name: `Dept two ${t}`, report_order: 2 }),
    await mk('createSpecimenType', { code: `S${t}`, name: `Specimen ${t}`, report_label: `SPEC ${t}` }),
    await mk('createMethod', { code: `M${t}`, name: `Method ${t}` }),
    await mk('createUnit', { code: `U${t}`, display: 'mg/dL' }),
  ];
  const valueSet = await mk('createValueSet', { code: `V${t}`, display: `VS ${t}`, is_ordered: false, values: [{ code: 'POS', display: 'Positive' }, { code: 'NEG', display: 'Negative' }] });
  return { tenant, dept, dept2, spec: sp, method, unit, valueSet };
}
export const testBody = (w: World, o: Record<string, unknown> = {}) => ({
  code: `T${tag()}`, name: 'Synthetic test', department_id: w.dept.id, workflow_type: 'standard',
  specimen_requirements: [{ specimen_type_id: w.spec.id, is_preferred: true }], tags: ['syn'], ...o,
});
export async function mkTest(w: World, o: Record<string, unknown> = {}): Promise<any> {
  const r = await call('createTest', req({ body: testBody(w, o), headers: { 'idempotency-key': uid() } }), { tenant: w.tenant });
  expect(r.status).toBe(201);
  return r.body;
}
/** a test created the OLD way (no parity field, no tags): fixtures that are not about the new Test fields use it, so they fail only for their own reason */
export const mkLegacyTest = (w: World, o: Record<string, unknown> = {}): Promise<any> => mkTest(w, { tags: undefined, ...o });
export const analyteBody = (o: Record<string, unknown> = {}, v: Record<string, unknown> = {}) => ({
  code: `A${tag(5)}`, name: 'Synthetic analyte', initial_version: { result_type: 'numeric', decimals: 1, unit_code: undefined, ...v }, ...o,
});
export async function mkAnalyte(w: World, testId: string, o: Record<string, unknown> = {}, v: Record<string, unknown> = {}): Promise<any> {
  const body = JSON.parse(JSON.stringify(analyteBody(o, { unit_code: w.unit.code, ...v })));
  const r = await call('createAnalyte', req({ params: { test_id: testId }, body, headers: { 'idempotency-key': uid() } }), { tenant: w.tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
/** publishes the analyte's draft version (needs the publish permission) */
export async function publishVersion(a: any, tenant: string = TENANT_A): Promise<any> {
  const det = (await call('getAnalyte', req({ params: { analyte_id: a.id } }), { tenant })).body;
  const draft = det.versions.find((v: any) => v.status === 'draft');
  const r = await call('publishAnalyteVersion', req({ params: { analyte_version_id: draft.id }, headers: im(draft.version), body: { change_reason: 'synthetic publish', allow_without_ranges: true } }), { tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
export async function mkRangeDraft(analyteId: string, bands: object[] | undefined, tenant: string = TENANT_A): Promise<any> {
  const r = await call('createReferenceRangeSetDraft', req({ params: { analyte_id: analyteId }, body: bands ? { bands } : {}, headers: { 'idempotency-key': uid() } }), { tenant });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
export const band = (o: Record<string, unknown> = {}) => ({ sex: 'any', kind: 'numeric', low: '3.5', high: '5.5', sort_order: 0, ...o });
export const years = (value: number) => ({ value, unit: 'year' });

// ------------------------------------------------------------------ owner-side truth
export const auditRows = (table: string, rowId: string) => ownerRows('audit.audit_log', 'schema_name = $1 AND table_name = $2 AND row_id = $3 ORDER BY occurred_at, id', ['catalog', table, rowId]);
export const changedEvents = (tenant: string, entityId: string) =>
  ownerRows('core.event_log', `tenant_id = $1 AND event_type = 'catalog.changed.v1' AND envelope->'payload'->>'entity_id' = $2 ORDER BY aggregate_seq`, [tenant, entityId]);
export const catalogRevision = async (tenant: string): Promise<number> => Number((await ownerRows('catalog.catalog_state', 'tenant_id = $1', [tenant]))[0]?.catalog_revision ?? 0);
export const dbRow = async (table: string, id: string) => (await ownerRows(`catalog.${table}`, 'id = $1', [id]))[0];
