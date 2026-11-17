// T0B-SYNC-1 helpers (not a test): real PG17 (migrated + seeded; tests/core/T0B-SYNC-1.pg.sh boots it), tenant_a / tenant_b synthetic fixtures,
// users, and ONE universal HandlerContext over a REAL request tx (lims_api, RLS on). Synthetic data only.
// Env: LIMS_TEST_APP_URL (lims_api, under RLS) + LIMS_TEST_SUPER_URL (superuser, fixtures and owner-side truth). Missing env = hard failure.
// Module surface pinned for the writer (see .orchestra/notes/T0B-SYNC-1-tests.md):
//   services/api/src/core/sync/index.ts exports `syncHandlers` (Record<operationId, Handler>, the 7 core sync operations) and
//   `createSyncHandlers(deps?: { settings?: Partial<SyncSettings> })`; bootstrap.ts merges them over the health handlers.
//   Handler request = { params, query, headers, body }; reply = { status, body }; errors are LimsError(code).
// The core pipeline (schema, x-permission, Idempotency-Key replay) is NOT re-run here: handlers are called directly with the ctx the pipeline builds.
import { afterAll, beforeAll } from 'vitest';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../errors.js';
import { createSyncHandlers, syncHandlers } from '../index.js';

export const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
export const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const SEED_ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const CENTRE = { a1: '01a1a98a-ac40-7000-8000-00000000a201', a2: '01a1a98a-ac40-7000-8000-00000000a202', b1: '01a1a98a-ac40-7000-8000-00000000b201' } as const;
/** Users of the synthetic tenants (created idempotently by seedUsers). A1 = a plain staff user, A2 = a second staff user, AADM = tenant admin; B1 / BADM in tenant B. */
export const USER = {
  a1: '01a1a98a-ac40-7000-8000-00000000a5a1', a2: '01a1a98a-ac40-7000-8000-00000000a5a2', aadm: '01a1a98a-ac40-7000-8000-00000000a5ad',
  b1: '01a1a98a-ac40-7000-8000-00000000b5b1', badm: '01a1a98a-ac40-7000-8000-00000000b5bd',
} as const;
export const uid = (): string => uuidv7();

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: run .orchestra\\notes\\T0B-SYNC-1-verify.cmd (boots PG17 via docker) or export it against a migrated + seeded DB`);
  return v;
};
const pgModule = 'pg';
const { default: pg } = (await import(pgModule)) as any;
const app = new pg.Pool({ connectionString: need('LIMS_TEST_APP_URL'), max: 60 });
const sup = new pg.Pool({ connectionString: need('LIMS_TEST_SUPER_URL'), max: 4 });

// every live file shares tenant_a / tenant_b on ONE database: serialise files with one session advisory lock (same device as LD-314 in the frontdesk helpers).
const FILE_LOCK_KEY = 314_000_322;
let lockClient: any;
beforeAll(async () => {
  lockClient = new pg.Client({ connectionString: need('LIMS_TEST_SUPER_URL') });
  await lockClient.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [FILE_LOCK_KEY]);
  await seedUsers();
}, 3_600_000);
afterAll(async () => {
  if (lockClient) { await lockClient.query('SELECT pg_advisory_unlock($1)', [FILE_LOCK_KEY]).catch(() => {}); await lockClient.end().catch(() => {}); lockClient = undefined; }
  await app.end().catch(() => {}); await sup.end().catch(() => {});
}, 60_000);

const claims = (tenant: string, sub: string, type: string) => JSON.stringify({ tenant_id: tenant, sub, actor_type: type, membership_id: sub });

export async function superTx<T>(fn: (tx: Tx) => Promise<T>, tenant = TENANT_A): Promise<T> {
  const c = await sup.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant, SEED_ACTOR, 'system')]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
/** Owner-side truth (no RLS). */
export const ownerRows = (sql: string, values: unknown[] = []): Promise<any[]> => superTx(async (tx) => (await tx.query(sql, values)).rows);

async function seedUsers(): Promise<void> {
  const rows: Array<[string, string, string]> = [[TENANT_A, USER.a1, 'Sync User A1'], [TENANT_A, USER.a2, 'Sync User A2'], [TENANT_A, USER.aadm, 'Sync Admin A'],
    [TENANT_B, USER.b1, 'Sync User B1'], [TENANT_B, USER.badm, 'Sync Admin B']];
  for (const [t, id, name] of rows) {
    await superTx((tx) => tx.query(`INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) ON CONFLICT DO NOTHING`,
      [t, id, `${name} (SYNTHETIC)`, SEED_ACTOR]), t);
  }
}
/** Start every counter-dependent test from a known place: set both per tenant counters (superuser). */
export async function setCounters(tenant: string, o: { lab?: number; patient?: number }): Promise<void> {
  await superTx(async (tx) => {
    if (o.lab !== undefined) await tx.query(`INSERT INTO lab.barcode_counters (tenant_id, last_value, created_by, updated_by) VALUES ($1, $2, $3, $3)
      ON CONFLICT (tenant_id) DO UPDATE SET last_value = $2`, [tenant, o.lab, SEED_ACTOR]);
    if (o.patient !== undefined) await tx.query(`INSERT INTO frontdesk.number_counters (tenant_id, counter_kind, scope_key, last_value, created_by, updated_by) VALUES ($1, 'patient_code', '', $2, $3, $3)
      ON CONFLICT (tenant_id, counter_kind, scope_key) DO UPDATE SET last_value = $2`, [tenant, o.patient, SEED_ACTOR]);
  }, tenant);
}
export const counter = async (tenant: string, series: 'lab_code' | 'patient_id'): Promise<number> => {
  const r = series === 'lab_code'
    ? await ownerRows('SELECT last_value FROM lab.barcode_counters WHERE tenant_id = $1', [tenant])
    : await ownerRows(`SELECT last_value FROM frontdesk.number_counters WHERE tenant_id = $1 AND counter_kind = 'patient_code' AND scope_key = ''`, [tenant]);
  return r[0] ? Number(r[0].last_value) : 0;
};

export interface Who { tenant: string; userId: string; type?: string }
export const as = (tenant: string, userId: string, type = 'user'): Who => ({ tenant, userId, type });
export const A1 = as(TENANT_A, USER.a1); export const A2 = as(TENANT_A, USER.a2); export const AADM = as(TENANT_A, USER.aadm);
export const B1 = as(TENANT_B, USER.b1); export const BADM = as(TENANT_B, USER.badm);

export interface Reply { status: number; body?: any; headers?: Record<string, string> }
export interface Outcome { reply?: Reply; error?: any; logs: string[]; requestId: string; asserted?: string[] }
export const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
/** `grants`: permission codes the fake IdentityPort grants (default: all three sync codes). A handler must call IdentityPort.assertRole(ctx, { permission }) itself: the central
 *  stage 8a defaults to SHADOW mode (LIMS_CORE_AUTHZ_MODE, LD-261) and does not refuse anything there, so sync.device.manage would be open to every staff user otherwise. */
export interface FireOpts { now?: Date; handlers?: Record<string, any>; bypassRls?: boolean; requestId?: string; grants?: readonly string[] }
const ALL_GRANTS = ['sync.use', 'sync.device.manage', 'sync.conflict.resolve'];
function identityFake(o: FireOpts, asserted: string[]) {
  const grants = o.grants ?? ALL_GRANTS;
  return { async assertRole(_ctx: unknown, r: { permission: string; centreId?: string }) {
    asserted.push(r?.permission);
    if (!grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
  } };
}

/** One request = one tx under `who`'s claims (RLS on). Commits on success; on a throw the tx rolls back and the error is RETURNED, never thrown. */
export async function fire(operationId: string, r: ReturnType<typeof req>, who: Who, o: FireOpts = {}): Promise<Outcome> {
  const requestId = o.requestId ?? uid();
  const logs: string[] = [];
  const asserted: string[] = [];
  const at = o.now ?? new Date();
  const log = (lvl: string) => (obj: unknown, msg?: string) => { logs.push(`${lvl} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
  const handler = (o.handlers ?? syncHandlers)[operationId];
  if (!handler) return { error: new Error(`no handler for ${operationId}`), logs, requestId };
  const pool = o.bypassRls ? sup : app;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(who.tenant, who.userId, who.type ?? 'user')]);
    await c.query("SELECT set_config('app.request_id', $1, true)", [requestId]);
    const tx: any = { query: (t: string, v?: unknown[]) => c.query(t, v), startedAt: at, operation: { module: 'core', operationId },
      savepoint: async (fn: (t: unknown) => Promise<unknown>) => { await c.query('SAVEPOINT sp'); try { const x = await fn(tx); await c.query('RELEASE SAVEPOINT sp'); return x; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT sp'); throw e; } } };
    const ctx: any = {
      operationId, tenantId: who.tenant, requestId, tx, now: () => at.toISOString(), clientIp: '203.0.113.9',
      actor: { type: who.type ?? 'user', id: who.userId, membershipId: who.userId },
      log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      audit: { access: async () => undefined }, events: {}, core: {}, ports: { IdentityPort: identityFake(o, asserted) }, db: {},
    };
    const reply = await handler(r, ctx);
    await c.query('COMMIT');
    return { reply, logs, requestId, asserted };
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); return { error, logs, requestId, asserted }; } finally { c.release(); }
}
/** Runs `fn(ctx)` in one tx under `who`'s claims (RLS on) with the same ctx `fire` builds; for service functions that are not operations. Error is RETURNED, never thrown. */
export async function withCtx<T>(who: Who, fn: (ctx: any) => Promise<T>, o: FireOpts = {}): Promise<{ reply?: T; error?: any; logs: string[]; requestId: string }> {
  const requestId = o.requestId ?? uid();
  const logs: string[] = [];
  const asserted: string[] = [];
  const at = o.now ?? new Date();
  const log = (lvl: string) => (obj: unknown, msg?: string) => { logs.push(`${lvl} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(who.tenant, who.userId, who.type ?? 'user')]);
    await c.query("SELECT set_config('app.request_id', $1, true)", [requestId]);
    const tx: any = { query: (t: string, v?: unknown[]) => c.query(t, v), startedAt: at, operation: { module: 'core', operationId: 'service' } };
    const ctx: any = { operationId: 'service', tenantId: who.tenant, requestId, tx, now: () => at.toISOString(), clientIp: '203.0.113.9',
      actor: { type: who.type ?? 'user', id: who.userId, membershipId: who.userId },
      log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined }, audit: { access: async () => undefined }, events: {}, core: {}, ports: { IdentityPort: identityFake(o, asserted) }, db: {} };
    const reply = await fn(ctx);
    await c.query('COMMIT');
    return { reply, logs, requestId };
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); return { error, logs, requestId }; } finally { c.release(); }
}
export const codeOf = (o: { error?: any }): string | undefined => (o.error instanceof LimsError ? (o.error as any).code : undefined);
export const ok = (o: Outcome): any => { if (o.error) throw o.error; return o.reply!.body; };

// ---- convenience wrappers (request shapes come from contracts/openapi/core.yaml)
export const reg = (who: Who, id: string, o: Record<string, unknown> = {}, f: FireOpts = {}) =>
  fire('registerSyncDevice', req({ body: { id, device_label: 'Front desk PC (SYNTHETIC)', platform: 'web', app_version: '1.4.0', ...o } }), who, f);
export const status = (who: Who, deviceId: string, headers: object = {}, f: FireOpts = {}) => fire('getSyncStatus', req({ query: { device_id: deviceId }, headers }), who, f);
export const reserve = (who: Who, deviceId: string, series: 'lab_code' | 'patient_id', size: number, o: Record<string, unknown> = {}, f: FireOpts = {}) =>
  fire('reserveNumberBlock', req({ body: { device_id: deviceId, series, size, ...o } }), who, f);
export const revoke = (who: Who, deviceId: string, f: FireOpts = {}) => fire('revokeSyncDevice', req({ params: { device_id: deviceId } }), who, f);
export const wipe = (who: Who, deviceId: string, f: FireOpts = {}) => fire('requestSyncDeviceWipe', req({ params: { device_id: deviceId } }), who, f);
export const ack = (who: Who, deviceId: string, f: FireOpts = {}) => fire('ackDeviceWipe', req({ params: { device_id: deviceId } }), who, f);
export const list = (who: Who, query: object = {}, f: FireOpts = {}) => fire('listSyncDevices', req({ query }), who, f);
/** A freshly registered device of `who` (throws when registration fails). */
export async function newDevice(who: Who, o: Record<string, unknown> = {}): Promise<string> { const id = uid(); ok(await reg(who, id, o)); return id; }
export { createSyncHandlers, syncHandlers };
