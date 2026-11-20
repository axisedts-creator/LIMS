// AUTH-ACTOR-1 (C1, AUTH-SENSITIVE; LD-204, LD-189; 02-TRD s6.3/s6.4; 08 A25 D-212 / R10). Behaviour-only, over bootPipeline with a fake `pg`
// (same rig idea as identity-db-handoff.test.ts); no name of the writer's wiring is assumed. No network, synthetic ids only.
//
// FACT being fixed: a public operation without claims ran with ctx.actor === undefined, so loginStaff / resolveSession / ... threw
// common.internal before GoTrue ("system actor = created_by of every write"). Rule under test: ONLY an operation with identityAuth true AND
// module 'identity' gets ctx.actor = { type: 'system', id }, id read lazily from core.g_system_actors (module 'identity', is_active, exactly
// one row), UUID-validated, memoised on success only; any failure = common.internal (code only, nothing cached). Never env / request / JWT.
// Also covered: ctx.db.identityAuthTx of that same request must work (it needs the same actor to open its transaction).
// Errors are compared by `.code` (vi.resetModules() gives every test a fresh LimsError class).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTOR = '0190a000-0000-7000-8000-00000000a5a5';
const OTHER = '0190a000-0000-7000-8000-00000000a6a6';
const USER = '0190a000-0000-7000-8000-00000000c0c0';
const TENANT = '0190a000-0000-7000-8000-00000000b0b0';
const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
const TOKEN = 'A'.repeat(43); // matches /^[A-Za-z0-9_-]{43}$/

type Stmt = { text: string; values: unknown[] };
const h = vi.hoisted(() => ({
  stmts: [] as Array<{ text: string; values: unknown[] }>,
  actors: (() => ({ rows: [] })) as () => { rows: any[] } | Error,
  signIn: [] as Array<{ email: string; password: string }>,
}));

vi.mock('pg', () => {
  const handle = (text: string, values: unknown[] = []) => {
    h.stmts.push({ text: String(text), values });
    const t = String(text).trim();
    if (/g_system_actors/i.test(t)) { const r = h.actors(); if (r instanceof Error) throw r; return r; }
    if (/set_config\(\s*'request\.jwt\.claims'/i.test(t) && /tx_started_at/i.test(t)) return { rows: [{ tx_started_at: new Date() }] };
    if (/ratelimit_hit/i.test(t)) return { rows: [{ allowed: true, retry_after_seconds: 0 }] };
    if (/ratelimit_peek/i.test(t)) return { rows: [{ hits: 0, last_hit: null }] };
    if (/ratelimit_clear/i.test(t)) return { rows: [{}] };
    return { rows: [] };
  };
  class Pool {
    on() { return this; }
    async end() {}
    async query(text: string, values?: unknown[]) { return handle(text, values); }
    async connect() { return { async query(text: string, values?: unknown[]) { return handle(text, values); }, release() {} }; }
  }
  return { default: { Pool }, Pool };
});

// fake GoTrue: the module's one lazily built HTTP gateway is replaced; sign-in is recorded and answers "wrong credentials" (no network, no secret)
vi.mock('../../../modules/identity/gotrue/gateway.http.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const gw = {
    signInWithPassword: async (email: string, password: string) => { h.signIn.push({ email, password }); return { ok: false as const }; },
    refresh: async () => ({ ok: false as const }),
  };
  return { ...real, gotrueGatewayFromEnv: () => gw };
});

let scratch: string;
let keyFile: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-identity-actor-'));
  keyFile = join(scratch, 'ratelimit.key');
  writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 }); // synthetic, not a secret
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  h.stmts.length = 0;
  h.signIn.length = 0;
  h.actors = () => ({ rows: [{ module: 'identity', actor_id: ACTOR }] });
});

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };

/** Fresh module registry per call: the identity binding and any actor memo are process-level state, every test starts cold. */
async function load(envOver: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const { loadConfig } = await import('../../config.js');
  const { bootPipeline } = await import('../boot.js');
  const { manifest } = await import('../../../modules/identity/index.js');
  const config = loadConfig({
    ...process.env,
    LIMS_CORE_DATABASE_URL: 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims', LIMS_CORE_RATELIMIT_KEY_FILE: keyFile,
    ...envOver,
  } as Record<string, string>);
  const other = (name: string) => ({ manifest: { name, openapi: `contracts/openapi/${name}.yaml`, handlers: {}, produces: [], createServices: () => Object.freeze({}) }, spec: {} });
  const boot = await bootPipeline({ config, modules: [{ manifest, spec: {} }, other('frontdesk')] as any, log: quiet as any, metrics: metrics as any });
  return { boot, manifest: manifest as any };
}

const op = (over: Record<string, unknown> = {}) => ({
  module: 'identity', operationId: 'loginStaff', method: 'POST', routeTemplate: '/v1/identity/auth/login',
  public: true, identityAuth: true, context: 'identity_auth', idempotency: 'none', ...over,
}) as any;
const call = (handler: any, o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  op: op(o), requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest', log: quiet,
  req: { params: {}, query: {}, headers: {}, body: {} }, handler, ...extra,
}) as any;
/** handler that records ctx.actor and answers 200 */
function spy() {
  const seen: Array<{ actor: unknown; ctx: any }> = [];
  const handler = async (_req: any, ctx: any) => { seen.push({ actor: ctx.actor, ctx }); return { status: 200, body: {} }; };
  return { seen, handler };
}
async function rejection(p: Promise<unknown>): Promise<any> { try { await p; } catch (e) { return e; } throw new Error('expected a rejection, but it resolved'); }
const expectInternal = (e: any, ...secrets: string[]) => {
  expect(e?.code).toBe('common.internal');
  const blob = `${e.message} ${e.detail ?? ''} ${JSON.stringify(e)}`;
  for (const s of secrets) expect(blob, 'error must not leak this value').not.toContain(s);
};
const lookups = (): Stmt[] => h.stmts.filter((s) => /g_system_actors/i.test(s.text));
const openingClaims = (): Array<Record<string, unknown>> =>
  h.stmts.filter((s) => /set_config\(\s*'request\.jwt\.claims'/i.test(s.text)).map((s) => JSON.parse(String(s.values[0])));

describe('which operations get the system actor (LD-204)', () => {
  it('identityAuth operation of module identity: ctx.actor = { type: "system", id } with the id from core.g_system_actors', async () => {
    const { boot } = await load();
    const s = spy();
    const r = await boot.pipelineFor('identity').run(call(s.handler));
    expect(r.status).toBe(200);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.actor).toMatchObject({ type: 'system', id: ACTOR });
    expect(Object.keys(s.seen[0]!.actor as object).sort(), 'only type and id, nothing from the request').toEqual(['id', 'type']);
    expect(Object.isFrozen(s.seen[0]!.actor), 'a handler cannot swap the actor').toBe(true);
    const q = lookups();
    expect(q).toHaveLength(1);
    expect(q[0]!.text).toMatch(/\bFROM\s+core\.g_system_actors\b/i);
    expect(q[0]!.text).toMatch(/\bis_active\b/i);
    expect(`${q[0]!.text} ${JSON.stringify(q[0]!.values)}`, "module 'identity' named").toMatch(/identity/);
    expect(q[0]!.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    await boot.close();
  });

  it('every identityAuth operation of the allowlist gets it, not only login', async () => {
    const { boot } = await load();
    for (const operationId of ['resolveSession', 'requestPasswordRecovery', 'confirmEmailToken', 'setPasswordFromSetup', 'verifyMfaChallenge']) {
      const s = spy();
      await boot.pipelineFor('identity').run(call(s.handler, { operationId }));
      expect(s.seen[0]!.actor, operationId).toMatchObject({ type: 'system', id: ACTOR });
    }
    await boot.close();
  });

  it('a public operation of module identity that is NOT identityAuth gets no actor and triggers no read', async () => {
    const { boot } = await load();
    for (const identityAuth of [undefined, false]) {
      const s = spy();
      await boot.pipelineFor('identity').run(call(s.handler, { operationId: 'getPublicThing', context: 'public', identityAuth }));
      expect(s.seen[0]!.actor).toBeUndefined();
    }
    expect(lookups()).toEqual([]);
    await boot.close();
  });

  it('an identityAuth operation of ANOTHER module gets no actor and triggers no read', async () => {
    const { boot } = await load();
    const s = spy();
    await boot.pipelineFor('frontdesk').run(call(s.handler, { module: 'frontdesk', operationId: 'loginStaff', identityAuth: true }));
    expect(s.seen[0]!.actor).toBeUndefined();
    expect(lookups()).toEqual([]);
    await boot.close();
  });

  it('an authenticated operation is unchanged: actor comes from the verified claims, g_system_actors is not read', async () => {
    const { boot } = await load();
    const s = spy();
    const stop = new Error('stop-after-capture');
    const handler = async (req: any, ctx: any) => { await s.handler(req, ctx); throw stop; };
    const claims = { sub: USER, tenant_id: TENANT, actor_type: 'user', aal: 'aal1' };
    const e = await rejection(boot.pipelineFor('identity').run(call(handler, { operationId: 'getMe', public: false, identityAuth: undefined, context: 'tenant' }, { claims })));
    expect(e).toBe(stop);
    expect(s.seen[0]!.actor).toMatchObject({ type: 'user', id: USER });
    expect(lookups()).toEqual([]);
    await boot.close();
  });

  it('the id never comes from env, request headers/body/params or claims: the table row wins', async () => {
    h.actors = () => ({ rows: [{ module: 'identity', actor_id: ACTOR }] });
    const { boot } = await load({ LIMS_CORE_IDENTITY_SYSTEM_ACTOR_ID: OTHER, LIMS_IDENTITY_SYSTEM_ACTOR_ID: OTHER, SYSTEM_ACTOR_ID: OTHER });
    const s = spy();
    await boot.pipelineFor('identity').run(call(s.handler, {}, {
      req: { params: { actor: OTHER }, query: { actor_id: OTHER }, headers: { 'x-actor-id': OTHER, 'x-system-actor': OTHER, cookie: `actor=${OTHER}` }, body: { actor: { type: 'system', id: OTHER }, actor_id: OTHER } },
    }));
    expect(s.seen[0]!.actor).toMatchObject({ type: 'system', id: ACTOR });
    await boot.close();
  });
});

describe('lazy and memoised on success only', () => {
  it('boot reads nothing (no g_system_actors read at boot, none until an identityAuth call)', async () => {
    const { boot } = await load();
    expect(lookups()).toEqual([]);
    await boot.pipelineFor('identity').run(call(spy().handler, { operationId: 'getPublicThing', context: 'public', identityAuth: false }));
    expect(lookups()).toEqual([]);
    await boot.close();
  });

  it('read once per process: later calls (also for another operation) do not query again', async () => {
    const { boot } = await load();
    const s = spy();
    for (let i = 0; i < 4; i++) await boot.pipelineFor('identity').run(call(s.handler, { operationId: i % 2 ? 'resolveSession' : 'loginStaff' }));
    expect(lookups()).toHaveLength(1);
    expect(s.seen.map((x) => (x.actor as any).id)).toEqual(Array(4).fill(ACTOR));
    await boot.close();
  });

  it('concurrent first calls all see the same actor (no half-bound state)', async () => {
    const { boot } = await load();
    const s = spy();
    await Promise.all([1, 2, 3, 4].map(() => boot.pipelineFor('identity').run(call(s.handler))));
    expect(new Set(s.seen.map((x) => (x.actor as any).id))).toEqual(new Set([ACTOR]));
    expect(lookups().length).toBeGreaterThanOrEqual(1);
    await boot.close();
  });
});

describe('fail closed: common.internal (code only), handler never runs, nothing cached, the next call retries', () => {
  it('a read error: rejected, no driver text / id, handler not invoked, next call retries and succeeds', async () => {
    let n = 0;
    h.actors = () => (n++ === 0 ? Object.assign(new Error(`permission denied for table g_system_actors ${ACTOR}`), { code: '42501' }) : { rows: [{ module: 'identity', actor_id: ACTOR }] });
    const { boot } = await load();
    const s = spy();
    const e = await rejection(boot.pipelineFor('identity').run(call(s.handler)));
    expectInternal(e, ACTOR, 'permission denied', '42501', 'g_system_actors');
    expect(s.seen, 'handler must not run without an actor').toEqual([]);
    const r = await boot.pipelineFor('identity').run(call(s.handler));
    expect(r.status).toBe(200);
    expect(s.seen[0]!.actor).toMatchObject({ type: 'system', id: ACTOR });
    expect(lookups()).toHaveLength(2);
    await boot.close();
  });

  it.each([
    ['no row (missing / inactive)', { rows: [] }],
    ['two active rows (must be exactly one)', { rows: [{ module: 'identity', actor_id: ACTOR }, { module: 'identity', actor_id: OTHER }] }],
    ['a NULL actor_id', { rows: [{ module: 'identity', actor_id: null }] }],
    ['plain text', { rows: [{ module: 'identity', actor_id: 'not-a-uuid-secret-value' }] }],
    ['a uuid with a SQL tail', { rows: [{ module: 'identity', actor_id: `${ACTOR}'; DROP TABLE core.g_system_actors; --` }] }],
    ['a uuid with a suffix', { rows: [{ module: 'identity', actor_id: `${ACTOR}00` }] }],
    ['a number', { rows: [{ module: 'identity', actor_id: 42 }] }],
  ])('%s: rejected common.internal, value not in the error, handler not invoked, retried next time', async (_n, bad) => {
    let n = 0;
    h.actors = () => (n++ === 0 ? bad : { rows: [{ module: 'identity', actor_id: ACTOR }] });
    const { boot } = await load();
    const s = spy();
    const leak = String((bad.rows[0] as any)?.actor_id ?? 'x-no-value');
    expectInternal(await rejection(boot.pipelineFor('identity').run(call(s.handler))), leak, 'DROP TABLE');
    expect(s.seen).toEqual([]);
    expect((await boot.pipelineFor('identity').run(call(s.handler))).status).toBe(200);
    expect(lookups()).toHaveLength(2);
    await boot.close();
  });

  it('a failed read does not break operations that do not use the actor (public non-identityAuth, other module)', async () => {
    h.actors = () => new Error('boom');
    const { boot } = await load();
    const a = spy(); const b = spy();
    expect((await boot.pipelineFor('identity').run(call(a.handler, { operationId: 'getPublicThing', context: 'public', identityAuth: false }))).status).toBe(200);
    expect((await boot.pipelineFor('frontdesk').run(call(b.handler, { module: 'frontdesk', identityAuth: true }))).status).toBe(200);
    expect(lookups()).toEqual([]);
    await boot.close();
  });
});

describe('through the pipeline, with NO injected ctx.actor: real handlers, fake DB source, fake GoTrue', () => {
  // The pipeline does not set ctx.bffKey (the BFF kind is a separate gap, NOT part of AUTH-ACTOR-1; the note says so). The test supplies ONLY the
  // bffKey the staff BFF would carry, by wrapping ctx; ctx.actor is left exactly as the pipeline built it.
  const withBff = (handler: any) => (req: any, ctx: any) => handler(req, Object.freeze({ ...ctx, bffKey: 'staff_web' }));

  it('POST login reaches the GoTrue call (signInWithPassword), not common.internal before it; the tx opens as the identity system actor', async () => {
    const { boot, manifest } = await load();
    const handler = withBff(manifest.handlers.loginStaff);
    const e = await rejection(boot.pipelineFor('identity').run(call(handler, {}, { req: { params: {}, query: {}, headers: { 'user-agent': 'vitest' }, body: { email: 'Synthetic.User@example.invalid', password: 'synthetic-password-1' } } })));
    expect(e.code, 'wrong credentials from the fake GoTrue').toBe('auth.login_failed');
    expect(h.signIn).toEqual([{ email: 'synthetic.user@example.invalid', password: 'synthetic-password-1' }]);
    expect(openingClaims()).toEqual([{ sub: ACTOR, actor_type: 'system' }]);
    expect(lookups()).toHaveLength(1);
    await boot.close();
  }, 15_000);

  it('POST login without the BFF wrapper is still not common.internal (the actor is there); it is refused as a wrong BFF before GoTrue', async () => {
    const { boot, manifest } = await load();
    const e = await rejection(boot.pipelineFor('identity').run(call(manifest.handlers.loginStaff, {}, { req: { params: {}, query: {}, headers: {}, body: { email: 'synthetic.user@example.invalid', password: 'synthetic-password-1' } } })));
    expect(e.code).not.toBe('common.internal');
    await boot.close();
  }, 15_000);

  it('POST session resolve reaches the session lookup in an identity_auth transaction (not common.internal before it)', async () => {
    const { boot, manifest } = await load();
    const handler = withBff(manifest.handlers.resolveSession);
    const e = await rejection(boot.pipelineFor('identity').run(call(handler, { operationId: 'resolveSession', routeTemplate: '/v1/identity/auth/session/resolve' },
      { req: { params: {}, query: {}, headers: { cookie: `__Host-lims_sid=${TOKEN}` }, body: { touch: false } } })));
    expect(e.code, 'unknown token on the fake DB').toBe('auth.session_expired');
    expect(openingClaims()).toEqual([{ sub: ACTOR, actor_type: 'system' }]);
    await boot.close();
  }, 15_000);

  it('a read failure on the real login handler fails closed: common.internal, GoTrue never called, no transaction opened', async () => {
    h.actors = () => new Error('db down 10.0.0.9');
    const { boot, manifest } = await load();
    const handler = withBff(manifest.handlers.loginStaff);
    const e = await rejection(boot.pipelineFor('identity').run(call(handler, {}, { req: { params: {}, query: {}, headers: {}, body: { email: 'synthetic.user@example.invalid', password: 'synthetic-password-1' } } })));
    expectInternal(e, '10.0.0.9', 'db down');
    expect(lookups(), 'the read was attempted (common.internal is not just the missing actor)').toHaveLength(1);
    expect(h.signIn).toEqual([]);
    expect(openingClaims()).toEqual([]);
    await boot.close();
  }, 15_000);
});
