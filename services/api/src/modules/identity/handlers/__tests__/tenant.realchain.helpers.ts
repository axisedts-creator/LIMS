// T0B-PROVFIX-2 helpers (not a test file). Synthetic data only. Drives the REAL request chain of the platform tenant handlers:
//   core/pipeline createPipeline (it builds the ctx exactly as the router does: ctx.now() is an ISO STRING, ctx.requestId a string, frozen actor,
//   platform keys from verified claims, ctx.db.withTenantScope = the real createDb one with the D-214 allowlist and the identity system actor)
//   -> the real handler (bindTenant) -> the real createTenantService -> the real createTenantRepo / invitations repo / core/audit/access.
// Only two seams are faked: the pg pool (a recording pool that answers every statement with a pg shaped result: rows + rowCount + command)
// and the GoTrue HTTP gateway (the real gateway shape: { userId } or { exists: true, userId }).
import { createDb } from '../../../../core/db/tx.js';
import { recorder } from '../../../../core/db/__tests__/helpers.js';
import { createAuthzGuard } from '../../../../core/ports/authz-guard.js';
import { createPipeline } from '../../../../core/pipeline/index.js';

export const idN = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT = idN(0xa001);          // the synthetic tenant_a of the live evidence
export const STAFF_USER = idN(0xd001), STAFF_ID = idN(0xd002), PSESSION = idN(0xe002), SYS = idN(0xf001), REQ_ID = idN(0xe001);
export const GOTRUE_USER = idN(0xc001);
export const HMAC_KEY = 'synthetic-hmac-key-for-tests-only-0123456789';
export const TX_START = new Date('2026-11-16T16:34:00.000Z');
export const INVITE_TTL_MS = 72 * 3_600_000;

/** Verified platform claims (core/auth shape): scope platform, no tenant_id, platform_ role, aal2. */
export const PLATFORM_CLAIMS: any = {
  sub: STAFF_USER, actor_type: 'user', scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2',
  platform_staff_id: STAFF_ID, lims_session_id: PSESSION,
};

export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly claims: Record<string, any> | undefined; readonly n: number }

/** Recording pg-shaped pool: every statement answered like node-postgres ({ rows, rowCount, command }); tx-local claims tracked like set_config(..., true). */
/** T0B-PROVPACK-1: optional stateful handler, called for EVERY statement before the stock answers; return a pg shaped result to answer it, undefined to fall through. */
export type PoolHandle = (text: string, values: unknown[], res: (rows: any[], command: string, rowCount?: number | null) => unknown) => unknown;
export function makePool(o: { tenantStatus?: string; tenantExists?: boolean; handle?: PoolHandle } = {}) {
  const log: Stmt[] = [];
  const injections: Array<{ match: RegExp; make: () => Error }> = [];
  let claims: Record<string, any> | undefined;
  const res = (rows: any[], command: string, rowCount: number | null = rows.length) => ({ rows, rowCount, command, oid: 0, fields: [] });
  const tenantRow = (id: string, code = 'tenant_a') => ({
    id, code, legal_name: 'Synthetic Tenant A', display_name: 'Tenant A', status: o.tenantStatus ?? 'provisioning', timezone: 'Asia/Kathmandu', status_reason: null,
    activated_at: null, suspended_at: null, offboarded_at: null, billing_live_on: null, created_at: TX_START, version: 1,
  });
  function exec(text: string, values: unknown[]) {
    const t = text.trim();
    log.push({ text: t, values, claims: claims && { ...claims }, n: log.length });
    const inj = injections.find((i) => i.match.test(t));
    if (inj) { injections.splice(injections.indexOf(inj), 1); throw inj.make(); }
    const handled = o.handle?.(t, values, res);
    if (handled !== undefined) return handled as ReturnType<typeof res>;
    if (/^BEGIN\b/i.test(t)) return res([], 'BEGIN', null);
    if (/^(COMMIT|ROLLBACK)\b/i.test(t) && !/^ROLLBACK\s+TO\b/i.test(t)) { claims = undefined; return res([], t.split(/\s/)[0]!.toUpperCase(), null); }
    if (/^(SAVEPOINT|RELEASE|ROLLBACK\s+TO)\b/i.test(t)) return res([], 'SAVEPOINT', null);
    if (/tx_started_at/i.test(t)) { claims = JSON.parse(String(values[0])); return res([{ set_config: values[0], tx_started_at: TX_START }], 'SELECT', 1); }
    if (/^SELECT set_config\('request\.jwt\.claims'/i.test(t)) { claims = JSON.parse(String(values[0])); return res([{ set_config: values[0] }], 'SELECT', 1); }
    if (/FROM core\.tenants t WHERE t\.id = \$1/i.test(t)) return res(o.tenantExists === false || values[0] !== TENANT ? [] : [tenantRow(TENANT)], 'SELECT');
    if (/FROM core\.tenants t WHERE t\.tenant_code = \$1/i.test(t)) return res([], 'SELECT');
    if (/^INSERT INTO core\.tenants/i.test(t)) return res([{ ...tenantRow(String(values[0]), String(values[1])), legal_name: values[2], display_name: values[3], status: 'provisioning' }], 'INSERT', 1);
    if (/^INSERT INTO core\.membership_roles/i.test(t)) return res([{ role_id: idN(0x7001) }], 'INSERT', 1);
    if (/app\.enqueue_job\s*\(/i.test(t)) return res([{ enqueue_job: { id: '1' } }], 'SELECT', 1);
    if (/app\.identity_user_exists/i.test(t)) return res([{ e: false }], 'SELECT', 1);
    return res([], /^INSERT/i.test(t) ? 'INSERT' : /^UPDATE/i.test(t) ? 'UPDATE' : 'SELECT', /^(INSERT|UPDATE)/i.test(t) ? 1 : 0);
  }
  const pool = {
    async connect() {
      let released = false;
      return {
        async query(textOrCfg: string | { text: string; values?: unknown[] }, vals?: unknown[]) {
          if (released) throw new Error('query on a released client');
          await Promise.resolve();
          return typeof textOrCfg === 'string' ? exec(textOrCfg, vals ?? []) : exec(textOrCfg.text, textOrCfg.values ?? []);
        },
        release() { released = true; },
      };
    },
  };
  return {
    pool, log, inject: (match: RegExp, make: () => Error) => { injections.push({ match, make }); },
    texts: () => log.map((s) => s.text),
    find: (re: RegExp) => log.filter((s) => re.test(s.text)),
    one: (re: RegExp) => { const hit = log.filter((s) => re.test(s.text)); if (hit.length !== 1) throw new Error(`expected exactly 1 statement matching ${re}, got ${hit.length}`); return hit[0]!; },
  };
}
export type PoolRig = ReturnType<typeof makePool>;

export interface ChainOpts { tenantStatus?: string; tenantExists?: boolean; idempotency?: boolean; handle?: PoolHandle }
/** One request through createPipeline: stages 5-11 with the real db + ctx builder. Returns the pipeline result or throws what the pipeline throws. */
export function makeChain(o: ChainOpts = {}) {
  const rig = makePool(o);
  const rec = recorder();
  const finished: unknown[] = [];
  const metrics = { setGauge() {}, inc() {} };
  const db = createDb({ pool: rig.pool as any, log: rec.log as any, metrics: rec.metrics as any, identitySystemActorId: SYS, sleep: async () => undefined, random: () => 0 } as any);
  const authz = createAuthzGuard({ env: 'ci', log: rec.log as any, metrics: metrics as any });
  const ports = { portsFor: () => ({ IdentityPort: { async assertRole() { /* platform ops assert through PlatformAuthz */ }, async getActor() { return {}; } } }) };
  const idempotency = o.idempotency === false ? undefined : {
    async begin(r: any) { return { action: 'proceed' as const, handle: { request: r } }; },
    // stage 10 stores the response: it must be serialisable (a Date / BigInt / circular body would throw here exactly as in the core store)
    async finish(_tx: unknown, _h: unknown, out: unknown) { finished.push(JSON.parse(JSON.stringify(out))); },
    async release() { /* nothing */ },
  };
  const shared = { core: {}, events: {}, uploads: {}, files: {}, storage: {}, download: {} };
  const pipeline = createPipeline({
    env: 'ci', db, idempotency, rateLimiter: { async consume() { /* allowed */ } }, authz, ports, shared, log: rec.log, metrics,
  } as any);
  const run = (handler: any, call: { operationId: string; routeTemplate: string; params?: Record<string, string>; body?: unknown; claims?: unknown; headers?: Record<string, string> }) => pipeline.run({
    op: { module: 'identity', operationId: call.operationId, method: 'POST', routeTemplate: call.routeTemplate, public: false, context: 'platform', idempotency: 'required', rateLimitTier: 'general' },
    claims: (call.claims ?? PLATFORM_CLAIMS) as any, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest', idempotencyKey: 'synthetic-key-1',
    req: { params: call.params ?? {}, query: {}, headers: { 'idempotency-key': 'synthetic-key-1', ...(call.headers ?? {}) }, body: call.body },
    handler, log: rec.log,
  } as any);
  return { rig, rec, finished, run };
}

export const INVITE_BODY = { email: 'New.Admin@Synthetic.Example.test', display_name: 'Synthetic Admin' };
export const acc = (v: string) => ({ version: v, accepted_by_name: 'Demo Owner', accepted_by_title: 'Managing Director', accepted_at: '2026-11-10T09:00:00.000Z' });
export const PROVISION_BODY = {
  code: 'synthetic_gamma', legal_name: 'Synthetic Gamma Lab Pvt. Ltd.', display_name: 'Synthetic Gamma', timezone: 'Asia/Kathmandu', calendar_display: 'AD_BS',
  first_branch: { code: 'KTM-01', name: 'Gamma main branch', address_text: 'Synthetic Road 1' }, first_centre: { code: 'C000000010', name: 'Gamma collection centre', kind: 'own' },
  first_admin: { email: 'Admin@Gamma.Example.test', display_name: 'Gamma Admin' }, contract_acceptance: { tos: acc('2026-11'), dpa: acc('2026-10') },
};
