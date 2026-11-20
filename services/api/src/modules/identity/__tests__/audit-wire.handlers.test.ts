// T0C-AUDIT-WIRE-1 (audit RS-13, LD-277; 07-SECURITY audit-tables row: old/new_values are P3, read only through C2's viewer with the privileged audit.log.read).
// Each of listAuditEntries, getAuditEntry, listAccessLogEntries, listAuthEvents, taken FROM handlers/index.ts (the registered handler), must:
//   - call the existing guard ctx.ports.IdentityPort.assertRole(ctx, { permission: 'audit.log.read' }) (exactly the x-permission of the contract), once,
//     BEFORE any read (no tx statement, no repository call, no access-log write);
//   - deny without a read when the guard rejects (auth.forbidden, and any other guard failure e.g. auth.mfa_required, passes through unchanged);
//   - answer the contract shape (the body is run through the response validator of core/openapi.ts RESPONSE_AJV_OPTIONS) reading only via repository/audit-read.repo.
// Why the guard call matters: core/pipeline stage 9 (core/ports/authz-guard.ts) answers common.internal in every env but production for a 2xx of a
// non-public operation whose handler never called IdentityPort.assertRole, and nothing else in the pipeline calls it (x-permission is NOT enforced by the core).
// Fake tx = audit-view.helpers.ts. Synthetic data only.
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { AJV_OPTIONS } from '../../../core/openapi.js';
import { createAuthzGuard } from '../../../core/ports/authz-guard.js';
import { LimsError } from '../../../core/errors.js';
import { handlers } from '../handlers/index.js';
import { createIdentityPort } from '../ports/IdentityPort.impl.js';
import { makeFakeRepo, member } from '../ports/__tests__/helpers';
import * as repo from '../repository/audit-read.repo.js';
import { CENTRE_A1, FROM, MEM_A, PHI_SENTINEL, TENANT_A, TO, USER_A, accessRow, auditRow, authRow, idN, makeEnv } from './audit-view.helpers.js';

// every exported repository function is wrapped so the test can see whether the handler read anything (the real function still runs)
vi.mock('../repository/audit-read.repo.js', async (orig) => {
  const m = await orig<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v]));
});
const repoCalls = () => Object.entries(repo as Record<string, any>).filter(([, v]) => typeof v === 'function' && 'mock' in v).reduce((n, [, v]) => n + v.mock.calls.length, 0);
const repoFn = (name: string) => (repo as Record<string, any>)[name] as ReturnType<typeof vi.fn>;

const PERM = 'audit.log.read';
const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => ((v: unknown) => boolean) & { errors?: any[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false, keywords: [...AJV_OPTIONS.keywords, 'components'] } });
function operation(op: string): any {
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'put', 'post', 'delete', 'patch']) if (item?.[m]?.operationId === op) return item[m];
  throw new Error(`no operation ${op}`);
}
const violations = (op: string, body: unknown): any[] => {
  const v = compile({ schema: { components: spec.components, ...operation(op).responses['200'].content['application/json'].schema } });
  return v(body) ? [] : [...(v.errors ?? [])];
};

const seed = () => ({ audit_log: [auditRow(1), auditRow(2, { centre_id: CENTRE_A1 })], access_log: [accessRow(1)], auth_events: [authRow(1)] });
const RANGE = { occurred_at_from: FROM, occurred_at_to: TO };
const CASES = [
  { op: 'listAuditEntries', repoFn: 'listAudit', req: { params: {}, query: { ...RANGE }, headers: {} } },
  { op: 'getAuditEntry', repoFn: 'getAudit', req: { params: { audit_id: idN(0x1000 + 1) }, query: {}, headers: {} } },
  { op: 'listAccessLogEntries', repoFn: 'listAccess', req: { params: {}, query: { ...RANGE }, headers: {} } },
  { op: 'listAuthEvents', repoFn: 'listAuth', req: { params: {}, query: { ...RANGE }, headers: {} } },
] as const;
const run = (op: string, req: unknown, ctx: unknown): Promise<any> => (handlers as Record<string, any>)[op](req, ctx);
const fail = async (p: Promise<unknown>): Promise<any> => p.then(() => undefined, (e) => e);

/** a context as the pipeline builds it, with a scripted guard: grant | deny (auth.forbidden) | an Error */
function scripted(grant: 'yes' | 'no' | Error, seedRows = seed()) {
  const env = makeEnv(seedRows);
  const calls: Array<{ ctx: unknown; req: any; stmtsAtCall: number; accessAtCall: number }> = [];
  const assertRole = vi.fn(async (c: unknown, r: any) => {
    calls.push({ ctx: c, req: r, stmtsAtCall: env.stmts.length, accessAtCall: env.accessWrites.length });
    if (grant instanceof Error) throw grant;
    if (grant === 'no') throw new LimsError('auth.forbidden');
  });
  const ctx = { ...env.ctx(), ports: { IdentityPort: { assertRole } } };
  return { env, ctx, assertRole, calls };
}

beforeEach(() => { for (const [, v] of Object.entries(repo as Record<string, any>)) if (typeof v === 'function' && 'mock' in v) v.mockClear(); });

describe.each(CASES)('$op: the guard (07-SECURITY audit.log.read)', ({ op, req }) => {
  it('the contract names exactly audit.log.read in tenant context (what the guard must be called with)', () => {
    expect(operation(op)['x-permission']).toBe(PERM);
    expect(operation(op)['x-context']).toBe('tenant');
  });
  it('calls IdentityPort.assertRole(ctx, { permission: "audit.log.read" }) exactly once, before any read or access-log write', async () => {
    const s = scripted('yes');
    await run(op, req, s.ctx);
    expect(s.assertRole).toHaveBeenCalledTimes(1);
    expect(s.calls[0]!.ctx).toBe(s.ctx);
    expect(s.calls[0]!.req).toEqual({ permission: PERM });
    expect(s.calls[0]!.stmtsAtCall, 'no statement may run before the guard').toBe(0);
    expect(s.calls[0]!.accessAtCall, 'no access-log write before the guard').toBe(0);
  });
  it('a user without the permission is denied (auth.forbidden): no repository call, no statement, no access-log write, nothing from the rows in the error', async () => {
    const s = scripted('no');
    const e = await fail(run(op, req, s.ctx));
    expect(e?.code).toBe('auth.forbidden');
    expect(repoCalls()).toBe(0);
    expect(s.env.stmts).toHaveLength(0);
    expect(s.env.accessWrites).toHaveLength(0);
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(PHI_SENTINEL);
  });
  it('any other guard failure (auth.mfa_required, a thrown error) passes through unchanged and nothing is read', async () => {
    for (const err of [new LimsError('auth.mfa_required'), new LimsError('common.internal')]) {
      const s = scripted(err);
      const e = await fail(run(op, req, s.ctx));
      expect(e?.code, String(err.code)).toBe(err.code);
      expect(repoCalls()).toBe(0);
      expect(s.env.stmts).toHaveLength(0);
    }
  });
  it('the guard is not skipped by what the request carries (permission / role / tenant keys in query, params, headers are ignored)', async () => {
    const s = scripted('no');
    const evil = { permission: 'x', roles: ['admin'], tenant_id: '0190a000-0000-7000-8000-00000000bbbb', 'x-permission': PERM };
    const e = await fail(run(op, { params: { ...req.params, ...evil }, query: { ...req.query, ...evil }, headers: evil, body: evil }, s.ctx));
    expect(e?.code).toBe('auth.forbidden');
    expect(s.assertRole).toHaveBeenCalledTimes(1);
    expect(s.calls[0]!.req).toEqual({ permission: PERM });
    expect(repoCalls()).toBe(0);
  });
  it('a context without tenant / actor / tx is auth.unauthenticated and never reaches the guard or a read', async () => {
    const assertRole = vi.fn(async () => undefined);
    const e = await fail(run(op, req, { operationId: 'x', clientIp: '203.0.113.9', ports: { IdentityPort: { assertRole } }, log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated');
    expect(repoCalls()).toBe(0);
  });
});

describe.each(CASES)('$op: a user with the permission gets the contract shape, read only through the repository', ({ op, repoFn: fn, req }) => {
  it('200 and the body validates against the 200 schema of contracts/openapi/identity.yaml', async () => {
    const s = scripted('yes');
    const r = await run(op, req, s.ctx);
    expect(r.status).toBe(200);
    expect(violations(op, r.body)).toEqual([]);
    expect(repoFn(fn)).toHaveBeenCalledTimes(1);
    expect(repoCalls(), 'every read goes through the one repository function of the operation').toBe(1);
    expect(s.assertRole).toHaveBeenCalledTimes(1);
  });
  it('the validator is not vacuous: a body missing its required members is rejected', () => {
    const bad = op === 'getAuditEntry' ? { occurred_at: 'nope' } : { data: 'nope' };
    expect(violations(op, bad).length).toBeGreaterThan(0);
  });
  it('tenant comes from the context: a row of another tenant is not returned', async () => {
    const other = '0190a000-0000-7000-8000-00000000bbbb';
    const s = scripted('yes', { audit_log: [auditRow(1, { tenant_id: other })], access_log: [accessRow(1, { tenant_id: other })], auth_events: [authRow(1, { tenant_id: other })] });
    const e = await fail(run(op, req, s.ctx));
    if (op === 'getAuditEntry') expect(e?.code).toBe('common.not_found');
    else expect((await run(op, req, s.ctx)).body.data).toEqual([]);
  });
});

describe('list handlers: contract content (no old/new values in lists; the detail has them and logs the view)', () => {
  it('listAuditEntries returns metadata only (no old_values / new_values, no PHI)', async () => {
    const r = await run('listAuditEntries', CASES[0].req, scripted('yes').ctx);
    expect(r.body.data.length).toBe(2);
    expect(JSON.stringify(r.body)).not.toContain(PHI_SENTINEL);
    for (const d of r.body.data) { expect(d).not.toHaveProperty('old_values'); expect(d).not.toHaveProperty('new_values'); }
  });
  it('getAuditEntry returns the values and writes the audit_entry.view access-log row AFTER the guard (D-T3)', async () => {
    const s = scripted('yes');
    const r = await run('getAuditEntry', CASES[1].req, s.ctx);
    expect(r.body.old_values).toContain(PHI_SENTINEL);
    expect(s.env.viewWrites()).toHaveLength(1);
    expect(s.calls[0]!.accessAtCall).toBe(0);
  });
  it('listAuthEvents never returns email_hmac', async () => {
    const r = await run('listAuthEvents', CASES[3].req, scripted('yes').ctx);
    expect(r.body.data.length).toBe(1);
    expect(JSON.stringify(r.body)).not.toMatch(/email_hmac/);
  });
});

describe('with the REAL IdentityPort (fake repo): permission holder allowed, others denied before any read', () => {
  const portCtx = (perms: string[]) => {
    const port = createIdentityPort({
      repo: makeFakeRepo({ members: [member('A', 'p', 1, { tenantId: TENANT_A, actorId: USER_A, membershipId: MEM_A, roleCodes: ['custom_role'], permissions: perms })] }).repo as any,
      systemActorPermissions: () => [],
    });
    const env = makeEnv(seed());
    return { env, ctx: { ...env.ctx(), ports: { IdentityPort: port } } };
  };
  it.each(CASES)('$op: holds audit.log.read -> 200', async ({ op, req }) => {
    const { ctx } = portCtx([PERM]);
    expect((await run(op, req, ctx)).status).toBe(200);
  });
  it.each(CASES)('$op: holds other permissions only -> auth.forbidden, no read', async ({ op, req }) => {
    const { ctx, env } = portCtx(['audit.log.export', 'identity.user.read']);
    expect((await fail(run(op, req, ctx)))?.code).toBe('auth.forbidden');
    expect(repoCalls()).toBe(0);
    expect(env.stmts).toHaveLength(0);
  });
});

describe('pipeline stage 9 (core/ports/authz-guard.ts): the 2xx is accepted because assertRole was called through the pipeline-wrapped port', () => {
  it.each(CASES)('$op: authz guard check does not throw for the 200 and logs nothing', async ({ op, req }) => {
    const logs: unknown[] = [];
    const guard = createAuthzGuard({ env: 'staging', log: { error: (o: unknown) => logs.push(o), info() {}, warn() {}, debug() {} } as any, metrics: { inc() {}, set() {}, observe() {} } as any });
    const az = guard.forRequest();
    const env = makeEnv(seed());
    const port = az.identity({ assertRole: async () => undefined });
    const r = await run(op, req, { ...env.ctx(), ports: { IdentityPort: port } });
    expect(() => guard.check(az, { operationId: op, public: false, status: r.status })).not.toThrow();
    expect(logs).toEqual([]);
  });
});
