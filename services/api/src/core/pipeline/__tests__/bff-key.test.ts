// AUTH-BFF-1 (C1, AUTH-SENSITIVE; LD-206, LD-189; 02-TRD s6.3; 08 R10 / A13 D-32): ctx.bffKey = the BffKind the verifier returned for the
// request's X-Lims-Bff-Key header (staff_web | partner | portal), undefined otherwise, set as an OWN key on every request and frozen with ctx.
// Three layers, behaviour only, no network, synthetic values (the key strings below are made up and never appear in a test title or message):
//   1. pipeline.run({ bffKey }) -> ctx.bffKey (own key, value passed through, frozen)           [makeRig]
//   2. the REAL onRequest hook (installRouteHooks + mountSpec + bootPipeline), fake key files    [probe route]
//   3. the REAL loginStaff handler through that hook, NO ctx wrapper, fake DB source + fake GoTrue
// Errors are compared by `.code` / problem body `code` (vi.resetModules() gives every test a fresh LimsError class).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRig, okHandler } from './helpers.js';

const STAFF_KEY = 'synthetic-staff-web-bff-key-0123456789abcdef0123456789';
const PARTNER_KEY = 'synthetic-partner-bff-key-fedcba9876543210fedcba98765432';
const PORTAL_KEY = 'synthetic-portal-bff-key-aaaabbbbccccddddeeeeffff00001111';
const WRONG_KEY = 'synthetic-not-a-configured-key-9999999999999999999999';

const h = vi.hoisted(() => ({ signIn: [] as Array<{ email: string; password: string }> }));

vi.mock('pg', () => {
  const handle = (text: string) => {
    const t = String(text).trim();
    if (/g_system_actors/i.test(t)) return { rows: [{ module: 'identity', actor_id: '0190a000-0000-7000-8000-00000000a5a5' }] };
    if (/set_config\(\s*'request\.jwt\.claims'/i.test(t) && /tx_started_at/i.test(t)) return { rows: [{ tx_started_at: new Date() }] };
    if (/ratelimit_hit/i.test(t)) return { rows: [{ allowed: true, retry_after_seconds: 0 }] };
    return { rows: [] };
  };
  class Pool {
    on() { return this; }
    async end() {}
    async query(text: string) { return handle(text); }
    async connect() { return { async query(text: string) { return handle(text); }, release() {} }; }
  }
  return { default: { Pool }, Pool };
});

// fake GoTrue: sign-in is recorded and answers "wrong credentials" (no network, no secret)
vi.mock('../../../modules/identity/gotrue/gateway.http.js', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const gw = {
    signInWithPassword: async (email: string, password: string) => { h.signIn.push({ email, password }); return { ok: false as const }; },
    refresh: async () => ({ ok: false as const }),
  };
  return { ...real, gotrueGatewayFromEnv: () => gw };
});

let scratch: string;
let files: { ratelimit: string; staff: string; partner: string; portal: string; empty: string };
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-bff-key-'));
  const w = (name: string, text: string) => { const f = join(scratch, name); writeFileSync(f, text, { mode: 0o600 }); return f; };
  files = { ratelimit: w('ratelimit.key', 'a'.repeat(64)), staff: w('staff.key', `${STAFF_KEY}\n`), partner: w('partner.key', `${PARTNER_KEY}\n`), portal: w('portal.key', `${PORTAL_KEY}\n`), empty: w('empty.key', '') };
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => { h.signIn.length = 0; });

// ---------------------------------------------------------------------------------------------------------------- 1. pipeline.run -> ctx
describe('pipeline.run: ctx.bffKey comes from the call (LD-206 scope 2)', () => {
  async function ctxFor(over: Record<string, unknown>) {
    let ctx: any;
    const rig = makeRig({ handler: async (r, c) => { ctx = c; return okHandler()(r, c); } });
    await rig.run(over);
    return ctx;
  }

  it.each(['staff_web', 'partner', 'portal'] as const)('bffKey %s is passed to the handler as ctx.bffKey, an own key', async (kind) => {
    const ctx = await ctxFor({ bffKey: kind });
    expect(Object.hasOwn(ctx, 'bffKey')).toBe(true);
    expect(ctx.bffKey).toBe(kind);
  });

  it('absent in the call: ctx.bffKey is an OWN key with value undefined (the member exists on every request, like tenantId)', async () => {
    const ctx = await ctxFor({});
    expect(Object.hasOwn(ctx, 'bffKey')).toBe(true);
    expect(ctx.bffKey).toBeUndefined();
    expect(Object.keys(ctx)).toContain('bffKey');
  });

  it('bffKey undefined in the call: same, own key with value undefined', async () => {
    const ctx = await ctxFor({ bffKey: undefined });
    expect(Object.hasOwn(ctx, 'bffKey')).toBe(true);
    expect(ctx.bffKey).toBeUndefined();
  });

  it('ctx is frozen, so a handler cannot set or swap ctx.bffKey', async () => {
    const ctx = await ctxFor({ bffKey: 'partner' });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => { 'use strict'; (ctx as any).bffKey = 'staff_web'; }).toThrow();
    expect(ctx.bffKey).toBe('partner');
  });

  it('the value is not read from the request: headers / body / query / params carrying a kind or key change nothing', async () => {
    const ctx = await ctxFor({
      req: {
        params: { bffKey: 'staff_web' }, query: { bffKey: 'staff_web', bff_key: STAFF_KEY },
        headers: { 'x-lims-bff-key': STAFF_KEY, 'x-bff-kind': 'staff_web' }, body: { bffKey: 'staff_web', bff_key: STAFF_KEY },
      },
    });
    expect(ctx.bffKey, 'only the call-level bffKey (the verifier result) counts').toBeUndefined();
  });

  it('claims (JWT) cannot set it either', async () => {
    const ctx = await ctxFor({ claims: { sub: '0190a000-0000-7000-8000-00000000a001', tenant_id: '01a1a98a-ac40-7000-8000-00000000a001', actor_type: 'user', bffKey: 'staff_web', bff_key: 'staff_web' } });
    expect(ctx.bffKey).toBeUndefined();
  });

  it('a public (no transaction) operation gets it too: the member does not depend on the tx path', async () => {
    let ctx: any;
    const rig = makeRig({ handler: async (_r, c) => { ctx = c; return { status: 200, body: {} }; } });
    await rig.run({ op: { module: 'frontdesk', operationId: 'publicProbe', method: 'GET', routeTemplate: '/v1/frontdesk/public-probe', public: true, idempotency: 'none', rateLimitTier: 'general' }, claims: undefined, bffKey: 'staff_web' });
    expect(Object.hasOwn(ctx, 'bffKey')).toBe(true);
    expect(ctx.bffKey).toBe('staff_web');
  });
});

// ---------------------------------------------------------------------------------------------------------------- 2/3. real hook
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };

/** Fresh module registry per call (identity binding / actor memo are process state). Real onRequest hook, fake key files, real bootPipeline over a fake `pg`. */
async function load(keyFiles: Record<string, string[]> = { staff_web: [files.staff], partner: [files.partner], portal: [files.portal] }) {
  vi.resetModules();
  const { default: Fastify } = await import('fastify');
  const { loadConfig } = await import('../../config.js');
  const { bootPipeline } = await import('../boot.js');
  const { createBffKeyVerifier } = await import('../../auth/bff-key.js');
  const { createClientIpResolver } = await import('../../auth/client-ip.js');
  const { installErrorHandlers, genReqId } = await import('../../errors.js');
  const { installRouteHooks, mountSpec, schemaController } = await import('../../openapi.js');
  const { loadSpec, REPO_ROOT } = await import('../../module.js');
  const { manifest } = await import('../../../modules/identity/index.js');

  const config = loadConfig({
    ...process.env,
    LIMS_CORE_DATABASE_URL: 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims', LIMS_CORE_RATELIMIT_KEY_FILE: files.ratelimit,
  } as Record<string, string>);
  const boot = await bootPipeline({ config, modules: [{ manifest, spec: {} }] as any, log: quiet as any, metrics: metrics as any });
  const auth = { bff: createBffKeyVerifier(keyFiles), clientIp: createClientIpResolver([]) };

  const app = Fastify({ schemaController, genReqId, frameworkErrors: (err: any, _req: any, reply: any) => { reply.code(400).send({ code: String(err?.code ?? 'common.validation_failed') }); } } as any);
  installErrorHandlers(app);
  installRouteHooks(app, { responseValidation: false, auth });

  // (2) probe: a public identity-module operation that reports what the handler saw in ctx.bffKey
  const probeSpec = {
    openapi: '3.0.3', info: { title: 'bff probe (AUTH-BFF-1 test)', version: '1.0.0' },
    paths: {
      '/v1/identity/bff-probe': {
        get: {
          operationId: 'bffProbeGet', security: [], 'x-public': 'test', 'x-idempotency': 'none', 'x-rate-limit-tier': 'general',
          parameters: ['bffKey', 'bff_key', 'x-lims-bff-key'].map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
        },
        post: {
          operationId: 'bffProbePost', security: [], 'x-public': 'test', 'x-idempotency': 'none', 'x-rate-limit-tier': 'general',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
        },
      },
    },
  };
  const seen: Array<{ own: boolean; kind: unknown; frozen: boolean }> = [];
  const probe = async (_req: any, ctx: any) => { seen.push({ own: Object.hasOwn(ctx, 'bffKey'), kind: ctx.bffKey, frozen: Object.isFrozen(ctx) }); return { status: 200, body: { ok: true } }; };
  await mountSpec(app, 'identity', probeSpec, { bffProbeGet: probe, bffProbePost: probe }, auth as any, boot.pipelineFor('identity'));

  // (3) the REAL loginStaff handler on the real spec, reduced to that one path (no bearerJwt operation, so no JWT verifier is needed)
  const real = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
  const loginOnly = { ...real, security: undefined, paths: { '/v1/identity/auth/login': real.paths['/v1/identity/auth/login'] } };
  await mountSpec(app, 'identity', loginOnly, { loginStaff: (manifest as any).handlers.loginStaff }, auth as any, boot.pipelineFor('identity'));

  await app.ready();
  return { app, seen, close: async () => { await app.close(); await boot.close(); } };
}

const codeOf = (r: { body: string }): string | undefined => { try { return JSON.parse(r.body).code; } catch { return undefined; } };
let rig: Awaited<ReturnType<typeof load>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

describe('the real onRequest hook sets ctx.bffKey from the verifier result only (LD-206 scope 3)', () => {
  const get = (headers: Record<string, string> = {}, url = '/v1/identity/bff-probe') => rig!.app.inject({ method: 'GET', url, headers, remoteAddress: '203.0.113.9' });

  it.each([
    ['staff_web', STAFF_KEY],
    ['partner', PARTNER_KEY],
    ['portal', PORTAL_KEY],
  ] as const)('the configured %s key gives ctx.bffKey === that kind', async (kind, key) => {
    rig = await load();
    const r = await get({ 'x-lims-bff-key': key });
    expect(r.statusCode).toBe(200);
    expect(rig.seen).toEqual([{ own: true, kind, frozen: true }]);
  });

  it.each([
    ['no header', {}],
    ['an empty header', { 'x-lims-bff-key': '' }],
    ['a wrong key', { 'x-lims-bff-key': WRONG_KEY }],
    ['a configured key with one more character', { 'x-lims-bff-key': `${STAFF_KEY}x` }],
    ['a configured key with a case change', { 'x-lims-bff-key': STAFF_KEY.toUpperCase() }],
    ['a configured key in the Authorization header', { authorization: `Bearer ${STAFF_KEY}` }],
    ['a configured key in the cookie header', { cookie: `x-lims-bff-key=${STAFF_KEY}` }],
    ['a kind name instead of a key', { 'x-lims-bff-key': 'staff_web' }],
    ['a header longer than the verifier accepts', { 'x-lims-bff-key': 'k'.repeat(5000) }],
  ] as const)('%s: ctx.bffKey is undefined (still an own key)', async (_n, headers) => {
    rig = await load();
    const r = await get({ ...headers });
    expect(r.statusCode).toBe(200);
    expect(rig.seen).toEqual([{ own: true, kind: undefined, frozen: true }]);
  });

  it('a configured key sent as a QUERY field gives undefined', async () => {
    rig = await load();
    const r = await get({}, `/v1/identity/bff-probe?bffKey=${STAFF_KEY}&bff_key=${STAFF_KEY}&x-lims-bff-key=${STAFF_KEY}`);
    expect(r.statusCode).toBe(200);
    expect(rig.seen).toEqual([{ own: true, kind: undefined, frozen: true }]);
  });

  it('a configured key or kind sent as a BODY field gives undefined', async () => {
    rig = await load();
    const r = await rig.app.inject({
      method: 'POST', url: '/v1/identity/bff-probe', remoteAddress: '203.0.113.9',
      payload: { bffKey: 'staff_web', bff_key: STAFF_KEY, 'x-lims-bff-key': STAFF_KEY, ctx: { bffKey: 'staff_web' } },
    });
    expect(r.statusCode).toBe(200);
    expect(rig.seen).toEqual([{ own: true, kind: undefined, frozen: true }]);
  });

  it('a body key does not override a REAL partner header: the header verifier result wins and nothing from the body is merged', async () => {
    rig = await load();
    const r = await rig.app.inject({
      method: 'POST', url: '/v1/identity/bff-probe', remoteAddress: '203.0.113.9',
      headers: { 'x-lims-bff-key': PARTNER_KEY }, payload: { bffKey: 'staff_web' },
    });
    expect(r.statusCode).toBe(200);
    expect(rig.seen).toEqual([{ own: true, kind: 'partner', frozen: true }]);
  });

  it('an empty key file leaves no valid key: even an empty or kind-name header gives undefined (fail closed)', async () => {
    rig = await load({ staff_web: [files.empty] });
    for (const headers of [{ 'x-lims-bff-key': '' }, { 'x-lims-bff-key': 'staff_web' }, {}]) await get(headers);
    expect(rig.seen.map((s) => s.kind)).toEqual([undefined, undefined, undefined]);
  });

  it('requests do not leak into each other: a staff_web request followed by one without a header sees undefined', async () => {
    rig = await load();
    await get({ 'x-lims-bff-key': STAFF_KEY });
    await get();
    await Promise.all([get({ 'x-lims-bff-key': PARTNER_KEY }), get(), get({ 'x-lims-bff-key': STAFF_KEY })]);
    expect(rig.seen.map((s) => s.kind).sort()).toEqual([undefined, undefined, 'partner', 'staff_web', 'staff_web'].sort());
  });
});

describe('through the real pipeline: the staff login passes the bff check on the real server (no ctx wrapper)', () => {
  const login = (headers: Record<string, string> = {}) => rig!.app.inject({
    method: 'POST', url: '/v1/identity/auth/login', remoteAddress: '203.0.113.9',
    headers: { 'user-agent': 'vitest', ...headers }, payload: { email: 'Synthetic.User@example.invalid', password: 'synthetic-password-1' },
  });

  it('with the staff_web header the real loginStaff reaches GoTrue (bff check passed); the fake answers wrong credentials -> auth.login_failed', async () => {
    rig = await load();
    const r = await login({ 'x-lims-bff-key': STAFF_KEY });
    expect(codeOf(r)).toBe('auth.login_failed');
    expect(h.signIn, 'the bff check passed, so the credentials were checked').toEqual([{ email: 'synthetic.user@example.invalid', password: 'synthetic-password-1' }]);
  }, 15_000);

  it('the same call WITHOUT the header returns auth.login_failed and GoTrue is never called (wrong bff)', async () => {
    rig = await load();
    const r = await login();
    expect(codeOf(r)).toBe('auth.login_failed');
    expect(h.signIn).toEqual([]);
  }, 15_000);

  it.each([
    ['the partner key', { 'x-lims-bff-key': PARTNER_KEY }],
    ['the portal key', { 'x-lims-bff-key': PORTAL_KEY }],
    ['a wrong key', { 'x-lims-bff-key': WRONG_KEY }],
    ['an empty header', { 'x-lims-bff-key': '' }],
  ] as const)('%s: auth.login_failed, GoTrue never called (only staff_web may log staff in)', async (_n, headers) => {
    rig = await load();
    const r = await login({ ...headers });
    expect(codeOf(r)).toBe('auth.login_failed');
    expect(h.signIn).toEqual([]);
  }, 15_000);

  it('the refusal body does not say it was the bff check (same body for wrong bff and wrong credentials)', async () => {
    rig = await load();
    const noKey = await login();
    const withKey = await login({ 'x-lims-bff-key': STAFF_KEY });
    const strip = (b: string) => { const j = JSON.parse(b); delete j.request_id; delete j.instance; delete j.trace_id; return JSON.stringify(j); };
    expect(noKey.statusCode).toBe(withKey.statusCode);
    expect(strip(noKey.body)).toBe(strip(withKey.body));
    for (const body of [noKey.body, withKey.body]) { expect(body).not.toMatch(/wrong_bff|bff/i); expect(body).not.toContain(STAFF_KEY); }
  }, 15_000);
});
