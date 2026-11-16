// T0B-ADMINFIX-1 helpers (not a test file). Synthetic data only.
// Drives the REAL request chain of the seven audit handlers exactly as staging boots it:
//   core/pipeline createPipeline (stage 8a central authz + stage 9 guard + the ctx builder that makes ctx.ports via portsView)
//   -> core/ports/registry resolvePorts with the REAL generated PORT_CONSUMERS (identity is NOT a consumer of its own IdentityPort)
//   -> the registered handlers from handlers/index.ts -> the real services / repositories -> the real createIdentityPort over a fake core-admin repo.
// Fakes: the pg pool only (audit tables through the audit-view fake tx, identity.audit_exports / admin_notices through a small stateful fake here).
import { createDb } from '../../../../core/db/tx.js';
import { recorder } from '../../../../core/db/__tests__/helpers.js';
import { PORT_OWNERS } from '../../../../core/module.js';
import { createPipeline } from '../../../../core/pipeline/index.js';
import { createAuthzGuard } from '../../../../core/ports/authz-guard.js';
import { resolvePorts } from '../../../../core/ports/registry.js';
import { PORT_CONSUMERS } from '../../../../../../../contracts/ports/generated/port-consumers.js';
import { createIdentityPort } from '../../ports/IdentityPort.impl.js';
import { makeFakeRepo, member, TENANTS, actorIdFor } from '../../ports/__tests__/helpers.js';
import { accessRow, auditRow, authRow, makeEnv, idN as auditIdN } from '../../__tests__/audit-view.helpers.js';
import { handlers } from '../index.js';
import { makePool } from './tenant.realchain.helpers.js';

export const TENANT = TENANTS.A;
export const REQ_ID = '01a1e5ac-7e63-7133-a001-8e8970b659f9';
export const FROM = '2026-11-01T00:00:00.000Z';
export const TO = '2026-11-08T00:00:00.000Z';
export const AUDIT_ID = auditIdN(0x1000 + 1);
export const EXPORT_ID = '01a1e5ac-91d4-7cde-bb8e-aa54900510a1';
export type Persona = 'admin' | 'reader' | 'exporter' | 'nobody';
const PERMS: Record<Persona, string[]> = {
  admin: ['audit.log.read', 'audit.log.export'], reader: ['audit.log.read'], exporter: ['audit.log.export'], nobody: ['identity.user.read'],
};
const MEMBERS = (Object.keys(PERMS) as Persona[]).map((p, i) => member('A', p, i + 1, { roleCodes: ['custom_role'], permissions: PERMS[p] }));
const mem = (p: Persona) => MEMBERS[(Object.keys(PERMS) as Persona[]).indexOf(p)]!;

export const claimsOf = (p: Persona): any => ({
  sub: actorIdFor('A', 'user', p), actor_type: 'user', tenant_id: TENANT, membership_id: mem(p).membershipId, aal: 'aal2', session_state: 'active',
});

/** [operationId, method, route template, x-permission, x-idempotency, request] of the seven operations (contracts/openapi/identity.yaml). */
export const OPS = [
  { op: 'listAuditEntries', method: 'GET', route: '/v1/identity/audit-entries', perm: 'audit.log.read', idem: 'none', req: { params: {}, query: { occurred_at_from: FROM, occurred_at_to: TO } } },
  { op: 'getAuditEntry', method: 'GET', route: '/v1/identity/audit-entries/{audit_id}', perm: 'audit.log.read', idem: 'none', req: { params: { audit_id: AUDIT_ID }, query: {} } },
  { op: 'listAccessLogEntries', method: 'GET', route: '/v1/identity/access-log-entries', perm: 'audit.log.read', idem: 'none', req: { params: {}, query: { occurred_at_from: FROM, occurred_at_to: TO } } },
  { op: 'listAuthEvents', method: 'GET', route: '/v1/identity/auth-events', perm: 'audit.log.read', idem: 'none', req: { params: {}, query: { occurred_at_from: FROM, occurred_at_to: TO } } },
  { op: 'createAuditExport', method: 'POST', route: '/v1/identity/audit-exports', perm: 'audit.log.export', idem: 'required',
    req: { params: {}, query: {}, body: { source: 'audit_log', occurred_at_from: FROM, occurred_at_to: TO, format: 'csv' } } },
  { op: 'listAuditExports', method: 'GET', route: '/v1/identity/audit-exports', perm: 'audit.log.export', idem: 'none', req: { params: {}, query: {} } },
  { op: 'getAuditExport', method: 'GET', route: '/v1/identity/audit-exports/{export_id}', perm: 'audit.log.export', idem: 'none', req: { params: { export_id: EXPORT_ID }, query: {} } },
] as const;
export type OpRow = (typeof OPS)[number];

const seedRows = () => ({
  audit_log: [auditRow(1, { tenant_id: TENANT }), auditRow(2, { tenant_id: TENANT })],
  access_log: [accessRow(1, { tenant_id: TENANT })],
  auth_events: [authRow(1, { tenant_id: TENANT })],
  people: MEMBERS.map((m) => ({ tenant_id: TENANT, user_id: m.actorId, membership_id: m.membershipId, display_name: m.displayName })),
});

/** Stateful fake of identity.audit_exports / admin_notices / quota statements (SQL text of repository/exports.repo.ts). */
function exportsFake(requesterOf: () => string) {
  const rows: any[] = [];
  const at = new Date('2026-11-17T00:00:00.000Z');
  rows.push({
    id: EXPORT_ID, tenant_id: TENANT, requested_by_membership_id: mem('admin').membershipId, source: 'audit_log', range_from: new Date(FROM), range_to: new Date(TO),
    status: 'queued', row_count: null, object_path: null, downloads_remaining: 3, ready_at: null, expires_at: null, error_code: null, version: 1,
    created_at: at, cursor_at: '2026-11-17 00:00:00+00',
  });
  void requesterOf;
  return {
    rows,
    handle(t: string, v: unknown[], res: (r: any[], c: string, n?: number | null) => unknown): unknown {
      if (/pg_advisory_xact_lock/i.test(t)) return res([{ pg_advisory_xact_lock: '' }], 'SELECT', 1);
      if (/count\(\*\)::int AS n FROM identity\.audit_exports/i.test(t)) return res([{ n: 0 }], 'SELECT', 1);
      if (/count\(\*\)::int AS n FROM \(SELECT 1 FROM/i.test(t)) return res([{ n: 3 }], 'SELECT', 1);
      if (/^INSERT INTO identity\.audit_exports/i.test(t)) {
        const row = {
          id: v[0], tenant_id: v[1], requested_by_membership_id: v[2], source: v[3], range_from: new Date(String(v[5])), range_to: new Date(String(v[6])),
          status: 'queued', row_count: null, object_path: null, downloads_remaining: 3, ready_at: null, expires_at: null, error_code: null, version: 1,
          created_at: at, cursor_at: '2026-11-17 00:00:00+00',
        };
        rows.push(row);
        return res([row], 'INSERT', 1);
      }
      if (/^INSERT INTO identity\.admin_notices/i.test(t)) return res([], 'INSERT', 1);
      if (/FROM identity\.audit_exports WHERE tenant_id = \$1 AND id = \$2/i.test(t)) return res(rows.filter((r) => r.tenant_id === v[0] && r.id === v[1]), 'SELECT');
      if (/FROM identity\.audit_exports\s+WHERE tenant_id = \$1 AND \(\$2::uuid IS NULL/i.test(t)) {
        return res(rows.filter((r) => r.tenant_id === v[0] && (v[1] == null || r.requested_by_membership_id === v[1])), 'SELECT');
      }
      return undefined;
    },
  };
}

export interface ChainOpts {
  /** LIMS_CORE_AUTHZ_MODE: shadow is the default of every environment (LD-261); enforce is what SEC-AUTHZ-9 will switch on. */
  authzMode?: 'shadow' | 'enforce';
  /** CONTROL ONLY: list `identity` as a consumer of IdentityPort (what staging lacks) to prove the fixtures are sound apart from the port visibility. */
  identityIsConsumer?: boolean;
}

export function makeAuditChain(o: ChainOpts = {}) {
  const rec = recorder();
  const env = makeEnv(seedRows());
  const exp = exportsFake(() => '');
  const rig = makePool({
    handle: (t, v, res) => {
      if (/audit\.audit_log|audit\.access_log|identity\.auth_events|core\.users|core\.memberships/i.test(t)) {
        return env.tx.query(t, v).then((r) => res(r.rows, /^\s*insert/i.test(t) ? 'INSERT' : 'SELECT', r.rowCount));
      }
      return exp.handle(t, v, res);
    },
  });
  const db = createDb({ pool: rig.pool as any, log: rec.log as any, metrics: rec.metrics as any, identitySystemActorId: idN0, sleep: async () => undefined, random: () => 0 } as any);
  const metrics = { setGauge() {}, inc() {} };
  const guard = createAuthzGuard({ env: 'staging', log: rec.log as any, metrics: metrics as any });

  // The real IdentityPort, observed: every assertRole is recorded with its permission (the "asserted exactly once" counter).
  const asserted: string[] = [];
  const real = createIdentityPort({ repo: makeFakeRepo({ members: MEMBERS }).repo as any, systemActorPermissions: () => [] });
  const identityPort = Object.assign(Object.create(real), {
    async assertRole(ctx: unknown, r: { permission: string }) { asserted.push(r.permission); return (real as any).assertRole(ctx, r); },
  });
  // The REAL registry with the REAL consumer lists: module identity is not a consumer of IdentityPort, as on staging.
  const fakes = Object.fromEntries(Object.keys(PORT_OWNERS).map((p) => [p, { kind: 'fake', port: p }]));
  const registry = resolvePorts({
    env: 'ci', modules: [{ name: 'identity', ports: { IdentityPort: identityPort } }], fakes, stubs: {},
    consumers: (o.identityIsConsumer ? { ...PORT_CONSUMERS, IdentityPort: [...PORT_CONSUMERS.IdentityPort, 'identity'] } : PORT_CONSUMERS) as any,
    log: rec.log as any, metrics: metrics as any,
  });
  const idempotency = {
    async begin(r: any) { return { action: 'proceed' as const, handle: { request: r } }; },
    async finish() { /* stage 10 */ }, async release() { /* nothing */ },
  };
  const shared = { core: {}, events: {}, uploads: {}, files: {}, storage: {}, download: {} };
  const pipeline = createPipeline({
    env: 'ci', db, idempotency, rateLimiter: { async consume() { /* allowed */ } }, authz: guard, ports: registry, shared, log: rec.log, metrics,
    authzMode: o.authzMode ?? 'shadow',
  } as any);

  const run = (row: OpRow, who: Persona) => pipeline.run({
    op: { module: 'identity', operationId: row.op, method: row.method, routeTemplate: row.route, public: false, context: 'tenant', idempotency: row.idem,
      rateLimitTier: 'general', permission: row.perm, scheme: 'bearerJwt' },
    claims: claimsOf(who), requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest', ...(row.idem === 'required' ? { idempotencyKey: 'synthetic-key-1' } : {}),
    req: { ...(row.req as object), headers: row.idem === 'required' ? { 'idempotency-key': 'synthetic-key-1' } : {} },
    handler: (handlers as Record<string, any>)[row.op], log: rec.log,
  } as any);
  return { run, asserted, env, rig, rec, exports: exp.rows };
}
const idN0 = '01a1a98a-ac40-7000-8000-00000000f001';
