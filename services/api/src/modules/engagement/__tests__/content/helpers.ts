// T0B-CONTENT-1 harness (LD-313, LD-325, LD-310 blanket authority). Engagement portal-content handlers are driven like the catalog TESTMGMT tests: a request-shaped object plus a
// HandlerContext over a REAL PG17 tx (lims_api, RLS on, audit triggers live). The core pipeline (ajv on the request, x-permission, Idempotency-Key) is NOT re-run, so every rule
// the contract states for a body is asserted against the handler itself (defence in depth: done_when 2). Permissions are asserted through the fake IdentityPort (assertCalls).
// Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL (tests/engagement/T0B-CONTENT-1.pg.sh boots a throwaway PG17 migrated through 20261117130000_engagement__add_portal_content.sql;
// lane/C0-0C must be merged: the contract (9 operations) and that migration are only there). Synthetic data only.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid } from '../../../frontdesk/__tests__/integration/helpers.js';

export { SYS_ACTOR, TENANT_A, TENANT_B, appTx, ownerRows, seed, superTx, uid };
export const T = 120_000;

export const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
export const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`);
};

export const MEM = { a: '01a1a98a-ac40-7000-8000-00000000a500', b: '01a1a98a-ac40-7000-8000-00000000b500' } as const;
export const PERM = { read: 'engagement.content.read', manage: 'engagement.content.manage', self: 'engagement.self.read' } as const;
export const KINDS = ['news', 'banner', 'offer', 'contact'] as const;
export type Kind = (typeof KINDS)[number];
export type Reply = { status: number; body?: any; headers?: Record<string, string> };
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
export const im = (version: number) => ({ 'if-match': `"${version}"` });
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<Reply>>;
const WRITE = /^\s*(insert|update|delete|truncate)\b/i;

export interface CallOpts { tenant?: string; grants?: readonly string[]; as?: 'staff' | 'patient'; today?: string }
export interface Called extends Reply { writes: string[]; assertCalls: string[]; requestId: string }

let registryDone = false;
async function ensureTaskRegistry(): Promise<void> {
  if (registryDone) return;
  await superTx(async (tx) => { await tx.query(`INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('core.event_fanout','core','core','per_tenant',25) ON CONFLICT DO NOTHING`); });
  registryDone = true;
}

// a second pool, only for the patient actor (claims actor_type 'patient'): the shared appTx always sets a system actor
const pgModule = 'pg';
const { default: pg } = (await import(pgModule)) as any;
let patientPool: any;
async function patientTx<T>(tenant: string, accountId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  patientPool ??= new pg.Pool({ connectionString: process.env['LIMS_TEST_APP_URL'], max: 4 });
  const c = await patientPool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: accountId, actor_type: 'patient' })]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
export const closePatientPool = async () => { await patientPool?.end(); patientPool = undefined; };

/** One request = one committed tx under `tenant`'s claims (RLS on); a throw rolls back. Default actor = staff holding read + manage. `writes` = write statements issued. */
export async function call(operationId: string, r: ReturnType<typeof req>, o: CallOpts = {}): Promise<Called> {
  await ensureTaskRegistry();
  const tenant = o.tenant ?? TENANT_A;
  const as = o.as ?? 'staff';
  const grants = o.grants ?? (as === 'patient' ? [PERM.self] : [PERM.read, PERM.manage]);
  const writes: string[] = []; const assertCalls: string[] = []; const requestId = uid();
  const accountId = uid();
  const run = async (raw: any) => {
    (raw as any).startedAt = new Date();
    const tx = { startedAt: (raw as any).startedAt, query: async (text: string, values?: unknown[]) => { if (WRITE.test(text)) writes.push(text); return raw.query(text, values); } };
    const ctx: any = {
      operationId, tenantId: tenant, tx, requestId, now: () => new Date().toISOString(), clientIp: '203.0.113.9',
      actor: as === 'patient' ? { type: 'patient', id: accountId, accountId } : { type: 'user', id: SYS_ACTOR, membershipId: tenant === TENANT_B ? MEM.b : MEM.a },
      log: { info() {}, warn() {}, error() {}, debug() {} }, metrics: { inc: () => undefined },
      events: createEvents({ producer: 'engagement' }),
      ports: { IdentityPort: {
        async assertRole(_c: unknown, rq: { permission: string }) { assertCalls.push(rq.permission); if (!grants.includes(rq.permission)) throw new LimsError('auth.forbidden'); },
        async getActor() { return { actor: { type: as === 'patient' ? 'patient' : 'user', id: SYS_ACTOR }, permissions: [...grants], mfa: { enrolled: true, level: 'aal2' } }; },
        async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
      } },
    };
    return H[operationId]!(r, ctx);
  };
  const out = as === 'patient' ? await patientTx(tenant, accountId, run) : await appTx(tenant, run);
  return { ...out, writes, assertCalls, requestId };
}
export const fails = async (operationId: string, r: ReturnType<typeof req>, o: CallOpts = {}): Promise<any> => {
  try { await call(operationId, r, o); } catch (e) { return e; }
  throw new Error(`${operationId}: expected a rejection, got success`);
};
export const errPaths = (e: any): string[] => (e?.errors ?? []).map((x: { path: string }) => x.path);
export function expectCode(e: any, code: string, status: number): void { expect(e?.code, `${e?.code ?? e?.message}`).toBe(code); expect(e.statusCode).toBe(status); }
/** 400 common.validation_failed naming `path` (JSON pointer), and no write statement was issued by the rejected request. */
export async function expectInvalid(operationId: string, r: ReturnType<typeof req>, path: string, o: CallOpts = {}): Promise<void> {
  let writes: string[] = []; let err: any;
  try { const c = await call(operationId, r, o); writes = c.writes; err = new Error(`accepted: HTTP ${c.status} ${JSON.stringify(c.body)}`); } catch (e) { err = e; }
  expect(err?.code, `${err?.code ?? err?.message}`).toBe('common.validation_failed');
  expect(err.statusCode).toBe(400);
  expect(errPaths(err), 'field path').toContain(path);
  expect(writes, 'no write on a rejected input').toEqual([]);
}

// ------------------------------------------------------------------ fixtures
export const tag = (n = 6): string => Array.from({ length: n }, () => 'BCDFGHJKLMNPQRSTVWXZ'[Math.floor(Math.random() * 20)]).join('');
export const idem = () => ({ 'idempotency-key': uid() });
export const day = (offset: number): string => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };

/** a branding asset (identity.branding_assets, what uploadBrandingAsset leaves behind), seeded as owner; `over` can make it inactive, quarantined, a signature, another tenant's */
export async function asset(tenant: string = TENANT_A, over: Record<string, unknown> = {}): Promise<string> {
  const id = uid();
  await seed('identity.branding_assets', {
    id, tenant_id: tenant, kind: 'logo', bucket: 'identity-assets', object_path: `${tenant}/synthetic/${id}.png`, content_type: 'image/png', size_bytes: 1234,
    width_px: 640, height_px: 360, sha256: `\\x${'ab'.repeat(32)}`, is_active: true, scan_state: 'clean', ...over,
  });
  return id;
}
export const mk = async (body: Record<string, unknown> = {}, o: CallOpts = {}): Promise<any> => {
  const r = await call('createPortalContent', req({ headers: idem(), body: { kind: 'news', title: `Synthetic ${tag()}`, ...body } }), o);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
export const list = async (query: object = {}, o: CallOpts = {}): Promise<any[]> => {
  const r = await call('listPortalContent', req({ query: { limit: 200, ...query } }), o);
  expect(r.status).toBe(200);
  return r.body.data;
};
export const mine = async (query: object = {}, o: CallOpts = {}): Promise<Called> =>
  call('listMyPortalContent', req({ query: { limit: 200, ...query }, headers: { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' } }), { ...o, as: 'patient' });

/** owner-side truth */
export const row = async (id: string) => (await ownerRows('engagement.portal_content', 'id = $1', [id]))[0];
export const imgRow = async (tenant: string, kind: string, profileId: string) => (await ownerRows('engagement.profile_image', 'tenant_id = $1 AND profile_kind = $2 AND profile_id = $3', [tenant, kind, profileId]))[0];
export const auditRows = (table: string, rowId: string) => ownerRows('audit.audit_log', 'schema_name = $1 AND table_name = $2 AND row_id = $3 ORDER BY occurred_at, id', ['engagement', table, rowId]);
/** hide every earlier synthetic row of a tenant from the public list tests (deactivated as owner; rows are never deleted) */
export async function quiet(tenant: string): Promise<void> {
  await superTx(async (tx) => { await tx.query(`UPDATE engagement.portal_content SET is_active = false WHERE tenant_id = $1 AND is_active`, [tenant]); }, tenant);
}
