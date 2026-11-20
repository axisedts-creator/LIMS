// PLATFORM-WIRE-1 (LD-267, LD-241; C2 02-TRD 5.10; C0 02-TRD 6.3 withTenantScope; 08 R10 item 4, A25 D-214). Behaviour-only, over bootPipeline
// with a fake `pg` and the REAL identity manifest, i.e. the wiring of staging: the request pool Db has NO identity system actor
// (core/pipeline/boot.ts builds `db` without identitySystemActorId), so ctx.db.withTenantScope of a platform request must be backed by the
// repository's existing mechanism (createDb().withTenantScope of core/db/tx.ts, actor from core.g_system_actors) on the SAME request
// transaction. The unit rig (platform-wire-ctx.test.ts) cannot see that; this file does. No name of the writer's wiring is assumed.
// Rules: tenant claims = { sub: <identity system actor>, actor_type: 'system', tenant_id } for the window, the platform claims are restored
// afterwards (also on error), fail closed (common.internal, fn never runs) for a foreign tx / non-UUID tenant / non-allowlisted operation /
// nested scope / actor lookup failure. Errors are compared by `.code` (vi.resetModules() gives every test a fresh LimsError class).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTOR = '0190a000-0000-7000-8000-00000000a5a5';
const SUB = '0190a000-0000-7000-8000-00000000a001';
const STAFF = '0190a000-0000-7000-8000-00000000c001';
const PSID = '0190a000-0000-7000-8000-00000000c0d1';
const T1 = '0190a000-0000-7000-8000-00000000b001';
const T2 = '0190a000-0000-7000-8000-00000000b002';
const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
const MEMBERSHIP = '0190a000-0000-7000-8000-00000000a0aa';

const h = vi.hoisted(() => ({
  stmts: [] as Array<{ client: number; text: string; values: unknown[] }>,
  clients: 0,
  actors: (() => ({ rows: [] })) as () => { rows: any[] } | Error,
}));

vi.mock('pg', () => {
  const handle = (client: number, text: string, values: unknown[] = []) => {
    h.stmts.push({ client, text: String(text), values });
    const t = String(text).trim();
    if (/g_system_actors/i.test(t)) { const r = h.actors(); if (r instanceof Error) throw r; return r; }
    if (/set_config\(\s*'request\.jwt\.claims'/i.test(t) && /tx_started_at/i.test(t)) return { rows: [{ tx_started_at: new Date() }] };
    if (/ratelimit_hit/i.test(t)) return { rows: [{ allowed: true, retry_after_seconds: 0 }] };
    return { rows: [] };
  };
  class Pool {
    on() { return this; }
    async end() {}
    async query(text: string, values?: unknown[]) { return handle(0, text, values); }
    async connect() {
      const id = ++h.clients;
      return { async query(text: string, values?: unknown[]) { await new Promise((r) => setTimeout(r, 0)); return handle(id, text, values); }, release() {} };
    }
  }
  return { default: { Pool }, Pool };
});

let scratch: string;
let keyFile: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-platform-wire-scope-'));
  keyFile = join(scratch, 'ratelimit.key');
  writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 }); // synthetic, not a secret
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => {
  h.stmts.length = 0;
  h.clients = 0;
  h.actors = () => ({ rows: [{ module: 'identity', actor_id: ACTOR }] });
});

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };

async function load() {
  vi.resetModules();
  const { loadConfig } = await import('../../config.js');
  const { bootPipeline } = await import('../boot.js');
  const { manifest } = await import('../../../modules/identity/index.js');
  const config = loadConfig({
    ...process.env,
    LIMS_CORE_DATABASE_URL: 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims', LIMS_CORE_RATELIMIT_KEY_FILE: keyFile,
  } as Record<string, string>);
  const other = (name: string) => ({ manifest: { name, openapi: `contracts/openapi/${name}.yaml`, handlers: {}, produces: [], createServices: () => Object.freeze({}) }, spec: {} });
  const boot = await bootPipeline({ config, modules: [{ manifest, spec: {} }, other('frontdesk')] as any, log: quiet as any, metrics: metrics as any });
  return { boot };
}

const platformClaims = (over: Record<string, unknown> = {}) =>
  ({ sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, platform_role: 'platform_superadmin', aal: 'aal2', lims_session_id: PSID, ...over }) as any;
const tenantClaims = { sub: SUB, tenant_id: T1, membership_id: MEMBERSHIP, actor_type: 'user', aal: 'aal2' } as any;
const op = (over: Record<string, unknown> = {}) => ({
  module: 'identity', operationId: 'provisionTenant', method: 'POST', routeTemplate: '/v1/identity/platform/tenants',
  public: false, context: 'platform', idempotency: 'none', ...over,
}) as any;
const call = (handler: any, claims: any, o: Record<string, unknown> = {}) => ({
  op: op(o), claims, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest', log: quiet,
  req: { params: {}, query: {}, headers: {}, body: {} }, handler,
}) as any;
/** a handler that opens ctx.db.withTenantScope(ctx.tx, tenantId, fn) and answers 200; it asserts a role so stage 9 is out of this file's way */
const scoped = (tenantId: unknown, fn: () => Promise<unknown>, seen: { ctx?: any; out?: unknown } = {}) => async (_r: any, ctx: any) => {
  seen.ctx = ctx;
  seen.out = await ctx.db.withTenantScope(ctx.tx, tenantId, fn);
  await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined);
  return { status: 200, body: {} };
};
async function rejection(p: Promise<unknown>): Promise<any> { try { await p; } catch (e) { return e; } throw new Error('expected a rejection, but it resolved'); }
const claimsStmts = () => h.stmts.filter((s) => /set_config\(\s*'request\.jwt\.claims'/i.test(s.text));
const claimsSeq = (client?: number) => claimsStmts().filter((s) => client === undefined || s.client === client).map((s) => JSON.parse(String(s.values[0])));
const probe = (ctx: any) => ctx.tx.query('SELECT 1 AS probe_inside_scope');

describe('ctx.db.withTenantScope on a platform request of the staging wiring (pool Db without actor)', () => {
  it('opens a tenant window as the identity system actor and restores the platform claims after it', async () => {
    const { boot } = await load();
    const seen: { ctx?: any; out?: unknown } = {};
    const handler = async (_r: any, ctx: any) => { seen.ctx = ctx; seen.out = await ctx.db.withTenantScope(ctx.tx, T1, async () => { await probe(ctx); return 'ran'; }); await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined); return { status: 200, body: {} }; };
    await boot.pipelineFor('identity').run(call(handler, platformClaims())).catch(() => undefined);
    expect(seen.out).toBe('ran');
    const seq = claimsSeq();
    expect(seq).toEqual([platformClaims(), { sub: ACTOR, actor_type: 'system', tenant_id: T1 }, platformClaims()]);
    const texts = h.stmts.map((s) => s.text.trim());
    const iProbe = texts.findIndex((t) => /probe_inside_scope/.test(t));
    const iScope = h.stmts.findIndex((s) => /set_config/i.test(s.text) && String(s.values[0]).includes(`"tenant_id":"${T1}"`));
    expect(iScope).toBeGreaterThan(-1);
    expect(iProbe, 'the work runs inside the tenant window').toBeGreaterThan(iScope);
    expect(h.stmts.findIndex((s, i) => i > iProbe && /set_config/i.test(s.text) && !String(s.values[0]).includes('tenant_id')), 'platform claims are back right after').toBeGreaterThan(iProbe);
    await boot.close();
  });

  it('the scoped claims are EXACTLY { sub: system actor, actor_type: system, tenant_id }: no platform_role, platform_staff_id, aal or session id, never the caller sub', async () => {
    const { boot } = await load();
    await boot.pipelineFor('identity').run(call(scoped(T1, async () => undefined), platformClaims())).catch(() => undefined);
    const inner = claimsSeq()[1]!;
    expect(Object.keys(inner).sort()).toEqual(['actor_type', 'sub', 'tenant_id']);
    expect(inner.sub).toBe(ACTOR);
    expect(inner.sub).not.toBe(SUB);
    await boot.close();
  });

  it('the window runs on the SAME request transaction/connection (one BEGIN, one COMMIT, every claims statement on that client)', async () => {
    const { boot } = await load();
    await boot.pipelineFor('identity').run(call(scoped(T1, async () => undefined), platformClaims())).catch(() => undefined);
    const begins = h.stmts.filter((s) => /^BEGIN\b/i.test(s.text.trim()));
    expect(begins).toHaveLength(1);
    const c = begins[0]!.client;
    expect(claimsStmts().every((s) => s.client === c)).toBe(true);
    await boot.close();
  });

  it('two sequential windows for two tenants in one request: each opens and restores, claims never leak into the next', async () => {
    const { boot } = await load();
    const handler = async (_r: any, ctx: any) => {
      await ctx.db.withTenantScope(ctx.tx, T1, async () => undefined);
      await ctx.db.withTenantScope(ctx.tx, T2, async () => undefined);
      await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined);
      return { status: 200, body: {} };
    };
    await boot.pipelineFor('identity').run(call(handler, platformClaims())).catch(() => undefined);
    expect(claimsSeq()).toEqual([
      platformClaims(), { sub: ACTOR, actor_type: 'system', tenant_id: T1 }, platformClaims(),
      { sub: ACTOR, actor_type: 'system', tenant_id: T2 }, platformClaims(),
    ]);
    await boot.close();
  });

  it('when fn throws, the platform claims are restored and the SAME error reaches the caller', async () => {
    const { boot } = await load();
    const boom = Object.assign(new Error('boom'), { code: 'synthetic' });
    let caught: unknown;
    const handler = async (_r: any, ctx: any) => {
      try { await ctx.db.withTenantScope(ctx.tx, T1, async () => { throw boom; }); } catch (e) { caught = e; }
      await ctx.db.withTenantScope(ctx.tx, T2, async () => undefined); // a failed window does not poison the next one
      await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined);
      return { status: 200, body: {} };
    };
    await boot.pipelineFor('identity').run(call(handler, platformClaims())).catch(() => undefined);
    expect(caught).toBe(boom);
    expect(claimsSeq()).toEqual([
      platformClaims(), { sub: ACTOR, actor_type: 'system', tenant_id: T1 }, platformClaims(),
      { sub: ACTOR, actor_type: 'system', tenant_id: T2 }, platformClaims(),
    ]);
    await boot.close();
  });

  it('concurrent platform requests for different tenants never share claims (each connection sees its own open / scope / restore sequence)', async () => {
    const { boot } = await load();
    const run = (tenant: string, staff: string) => boot.pipelineFor('identity').run(call(
      async (_r: any, ctx: any) => { await ctx.db.withTenantScope(ctx.tx, tenant, async () => { await new Promise((r) => setTimeout(r, 5)); await probe(ctx); }); await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined); return { status: 200, body: {} }; },
      platformClaims({ platform_staff_id: staff }))).catch(() => undefined);
    const S2 = '0190a000-0000-7000-8000-00000000c002';
    await Promise.all([run(T1, STAFF), run(T2, S2)]);
    const clients = [...new Set(claimsStmts().map((s) => s.client))];
    expect(clients).toHaveLength(2);
    for (const c of clients) {
      const seq = claimsSeq(c);
      expect(seq).toHaveLength(3);
      expect(seq[1]!.tenant_id === T1 || seq[1]!.tenant_id === T2).toBe(true);
      expect(seq[0]).toEqual(seq[2]);                       // restored to this request's own platform claims
      expect(seq[0]).toMatchObject({ scope: 'platform' });
    }
    expect(new Set(clients.map((c) => claimsSeq(c)[1]!.tenant_id))).toEqual(new Set([T1, T2]));
    await boot.close();
  });
});

describe('fails closed (common.internal, fn never runs, no tenant claims set)', () => {
  async function refused(tenantId: unknown, o: { op?: Record<string, unknown>; claims?: any; tx?: (real: any) => unknown; before?: () => void } = {}) {
    const { boot } = await load();
    o.before?.();
    let ran = false;
    let err: any;
    const handler = async (_r: any, ctx: any) => {
      try { await ctx.db.withTenantScope(o.tx ? o.tx(ctx.tx) : ctx.tx, tenantId, async () => { ran = true; }); } catch (e) { err = e; }
      await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined);
      return { status: 200, body: {} };
    };
    await boot.pipelineFor('identity').run(call(handler, o.claims ?? platformClaims(), o.op ?? {})).catch(() => undefined);
    await boot.close();
    return { ran, err };
  }
  const noTenantClaims = () => expect(claimsSeq().filter((c) => c.tenant_id !== undefined)).toEqual([]);

  it.each(['', 'not-a-uuid', `${T1} `, `${T1}0`, 42, null, undefined, {}, [T1]].map((v) => [v]))('tenant id %j', async (bad) => {
    const { ran, err } = await refused(bad);
    expect(ran).toBe(false);
    expect(err?.code).toBe('common.internal');
    noTenantClaims();
  });

  it('a transaction that is not this request\'s (foreign object with a query method)', async () => {
    const { ran, err } = await refused(T1, { tx: () => ({ query: async () => ({ rows: [] }) }) });
    expect(ran).toBe(false);
    expect(err?.code).toBe('common.internal');
    noTenantClaims();
  });

  it('no transaction at all', async () => {
    const { ran, err } = await refused(T1, { tx: () => undefined });
    expect(ran).toBe(false);
    expect(err?.code).toBe('common.internal');
    noTenantClaims();
  });

  it.each(['listTenants', 'getTenant', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions', 'listDeadLetters', 'listPlatformStaff', 'someInventedOperation'])(
    'operation %s is not in the withTenantScope allowlist (08 A25 D-214)', async (operationId) => {
      const { ran, err } = await refused(T1, { op: { operationId } });
      expect(ran).toBe(false);
      expect(err?.code).toBe('common.internal');
      noTenantClaims();
    });

  it('a platform-context operation of another module', async () => {
    const { boot } = await load();
    let ran = false;
    let err: any;
    await boot.pipelineFor('frontdesk').run(call(async (_r: any, ctx: any) => {
      try { await ctx.db.withTenantScope(ctx.tx, T1, async () => { ran = true; }); } catch (e) { err = e; }
      await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined);
      return { status: 200, body: {} };
    }, platformClaims(), { module: 'frontdesk' })).catch(() => undefined);
    expect(ran).toBe(false);
    expect(err?.code ?? 'absent', 'a non-identity module neither gets the function nor a working one').toMatch(/^(common\.internal|absent)$/);
    noTenantClaims();
    await boot.close();
  });

  it('an allowlisted operation whose x-context is not platform', async () => {
    const { ran, err } = await refused(T1, { op: { context: 'tenant' } });
    expect(ran).toBe(false);
    expect(err?.code).toBe('common.internal');
    noTenantClaims();
  });

  it('nested windows (a window inside a window)', async () => {
    const { boot } = await load();
    let inner: any;
    const handler = async (_r: any, ctx: any) => {
      await ctx.db.withTenantScope(ctx.tx, T1, async () => { try { await ctx.db.withTenantScope(ctx.tx, T2, async () => undefined); } catch (e) { inner = e; } });
      await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined);
      return { status: 200, body: {} };
    };
    await boot.pipelineFor('identity').run(call(handler, platformClaims())).catch(() => undefined);
    expect(inner?.code).toBe('common.internal');
    expect(claimsSeq().filter((c) => c.tenant_id === T2)).toEqual([]);
    await boot.close();
  });

  it('the identity system actor cannot be read: no window, no leak of the driver text', async () => {
    const leak = 'password authentication failed for user lims_app 10.9.8.7';
    const { ran, err } = await refused(T1, { before: () => { h.actors = () => new Error(leak); } });
    expect(ran).toBe(false);
    expect(err?.code).toBe('common.internal');
    expect(`${err?.message} ${JSON.stringify(err)}`).not.toContain('10.9.8.7');
    noTenantClaims();
  });

  it('the identity system actor row is missing or ambiguous (0 or 2 active rows)', async () => {
    for (const rows of [[], [{ module: 'identity', actor_id: ACTOR }, { module: 'identity', actor_id: '0190a000-0000-7000-8000-00000000a6a6' }]]) {
      const { ran, err } = await refused(T1, { before: () => { h.actors = () => ({ rows }); } });
      expect(ran).toBe(false);
      expect(err?.code).toBe('common.internal');
    }
    noTenantClaims();
  });

  it('a stale tx kept past its request cannot open a window later', async () => {
    const { boot } = await load();
    let kept: any; let ctxKept: any;
    await boot.pipelineFor('identity').run(call(async (_r: any, ctx: any) => { kept = ctx.tx; ctxKept = ctx; await ctx.ports.IdentityPort.assertRole(ctx, {}).catch(() => undefined); return { status: 200, body: {} }; }, platformClaims())).catch(() => undefined);
    const before = claimsStmts().length + h.stmts.filter((s) => /^BEGIN\b/i.test(s.text.trim())).length;
    let ran = false;
    const e = await rejection(Promise.resolve().then(() => ctxKept.db.withTenantScope(kept, T1, async () => { ran = true; })));
    expect(e?.code).toBe('common.internal');
    expect(ran).toBe(false);
    expect(claimsStmts().length + h.stmts.filter((s) => /^BEGIN\b/i.test(s.text.trim())).length, 'no claims change and no new transaction after the request ended').toBe(before);
    await boot.close();
  });
});

describe('no other session kind gets a working withTenantScope', () => {
  it('a tenant session on an identity operation: ctx.db has no withTenantScope', async () => {
    const { boot } = await load();
    let ctx: any;
    await boot.pipelineFor('identity').run(call(async (_r: any, c: any) => { ctx = c; await c.ports.IdentityPort.assertRole(c, {}).catch(() => undefined); return { status: 200, body: {} }; }, tenantClaims, { context: 'tenant', operationId: 'getMe' })).catch(() => undefined);
    expect(Object.prototype.hasOwnProperty.call(ctx.db, 'withTenantScope')).toBe(false);
    expect(Object.keys(ctx).filter((k) => /^platform/.test(k))).toEqual([]);
    await boot.close();
  });

  it('a platform session on the platform operation of a stranger module, or a session with stray platform keys on a tenant one: no tenant window is ever opened', async () => {
    const { boot } = await load();
    const stray = { ...tenantClaims, scope: 'platform', platform_role: 'platform_superadmin', platform_staff_id: STAFF, lims_session_id: PSID };
    let ctx: any;
    await boot.pipelineFor('identity').run(call(async (_r: any, c: any) => { ctx = c; await c.ports.IdentityPort.assertRole(c, {}).catch(() => undefined); return { status: 200, body: {} }; }, stray)).catch(() => undefined);
    expect(Object.prototype.hasOwnProperty.call(ctx.db, 'withTenantScope')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'platformStaffId')).toBe(false);
    await boot.close();
  });
});
