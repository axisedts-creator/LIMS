// AUTH-BFFSESSION-1 (C1, AUTH-SENSITIVE; LD-212, LD-189, LD-206; 02-TRD s6.3 stage 4; contracts/openapi/_common.yaml securitySchemes.bffSession).
// securityHandlers() must ALWAYS register `bffSession`. It passes only when ALL hold: the verifier accepted X-Lims-Bff-Key (requestAuth bffKind, any kind),
// the route is under /v1/identity/auth/, and the Cookie header has a non-empty `__Host-lims_sid` pair of at most 4096 chars. Otherwise 401 auth.unauthenticated
// BEFORE the handler and before any database call. Live evidence: startMfaEnrolment answered 401 in 1-3 ms because glue's "Missing handler" stub threw.
// Behaviour only, through the real HTTP layer (mountSpec + installRouteHooks + app.inject), stub handlers, the six REAL operations of contracts/openapi/identity.yaml,
// fake key files, fake `pg`. Key and cookie strings are synthetic and never appear in a test title. Errors are compared by problem body `code`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const STAFF_KEY = 'synthetic-staff-web-bff-key-0123456789abcdef0123456789';
const PARTNER_KEY = 'synthetic-partner-bff-key-fedcba9876543210fedcba98765432';
const PORTAL_KEY = 'synthetic-portal-bff-key-aaaabbbbccccddddeeeeffff00001111';
const WRONG_KEY = 'synthetic-not-a-configured-key-9999999999999999999999';
const SID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 base64url chars (a 32-byte opaque session token)
const COOKIE = `__Host-lims_sid=${SID}`;
const FACTOR = '0193a5c0-0000-7000-8000-0000000000f1';

const h = vi.hoisted(() => ({ queries: [] as string[] }));

vi.mock('pg', () => {
  const handle = (text: string) => {
    const t = String(text).trim();
    h.queries.push(t);
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

let scratch: string;
let files: { ratelimit: string; staff: string; partner: string; portal: string };
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-bff-session-'));
  const w = (name: string, text: string) => { const f = join(scratch, name); writeFileSync(f, text, { mode: 0o600 }); return f; };
  files = { ratelimit: w('ratelimit.key', 'a'.repeat(64)), staff: w('staff.key', `${STAFF_KEY}\n`), partner: w('partner.key', `${PARTNER_KEY}\n`), portal: w('portal.key', `${PORTAL_KEY}\n`) };
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => { h.queries.length = 0; });

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };

// the six bffSession operations of contracts/openapi/identity.yaml (path as served; body valid for the contract so the 400 stage never hides the 401)
const SIX = [
  { id: 'verifyMfaChallenge', url: '/v1/identity/auth/mfa/verify', payload: { code: '123456' }, status: 200 },
  { id: 'startMfaEnrolment', url: '/v1/identity/auth/mfa/enrolment', payload: { friendly_name: 'Work phone' }, status: 200 },
  { id: 'completeMfaEnrolment', url: `/v1/identity/auth/mfa/enrolment/${FACTOR}/verify`, payload: { code: '123456' }, status: 200 },
  { id: 'resolveSession', url: '/v1/identity/auth/session/resolve', payload: { touch: true }, status: 200 },
  { id: 'logoutSession', url: '/v1/identity/auth/logout', payload: undefined, status: 204 },
  { id: 'setPasswordFromSetup', url: '/v1/identity/auth/password/set', payload: { new_password: 'synthetic-new-password-1' }, status: 200 },
] as const;
type Op = (typeof SIX)[number];

const responses = { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } };
/** A one-operation spec the real contract does not have: the same bffSession scheme under another path / the bearerJwt scheme. */
const extraSpec = (paths: Record<string, string>, scheme: 'bffSession' | 'bearerJwt') => ({
  openapi: '3.0.3', info: { title: 'bffSession probe (AUTH-BFFSESSION-1 test)', version: '1.0.0' },
  components: { securitySchemes: {
    bffSession: { type: 'apiKey', in: 'cookie', name: '__Host-lims_sid' },
    bearerJwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  } },
  paths: Object.fromEntries(Object.entries(paths).map(([path, operationId]) => [path, {
    post: { operationId, security: [{ [scheme]: [] }], 'x-public': 'test', 'x-idempotency': 'none', 'x-rate-limit-tier': 'general', responses },
  }])),
});

interface Seen { op: string; bffKey: unknown; own: boolean }
/** Fresh module registry per call (identity binding / actor memo are process state). Real onRequest hook, fake key files, real bootPipeline over a fake `pg`. */
async function load(opts: { verifier?: 'reject' } = {}) {
  vi.resetModules();
  const { default: Fastify } = await import('fastify');
  const { loadConfig } = await import('../../config.js');
  const { bootPipeline } = await import('../boot.js');
  const { createBffKeyVerifier } = await import('../../auth/bff-key.js');
  const { createClientIpResolver } = await import('../../auth/client-ip.js');
  const { AuthError } = await import('../../auth/errors.js');
  const { installErrorHandlers, genReqId } = await import('../../errors.js');
  const { installRouteHooks, mountSpec, schemaController } = await import('../../openapi.js');
  const { loadSpec, REPO_ROOT } = await import('../../module.js');
  const { manifest } = await import('../../../modules/identity/index.js');

  const config = loadConfig({
    ...process.env,
    LIMS_CORE_DATABASE_URL: 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims', LIMS_CORE_RATELIMIT_KEY_FILE: files.ratelimit,
  } as Record<string, string>);
  const boot = await bootPipeline({ config, modules: [{ manifest, spec: {} }] as any, log: quiet as any, metrics: metrics as any });
  const verified: string[] = [];
  // (g) default: NO JWT verifier. (i): a verifier that records the token and rejects it.
  const verifier = opts.verifier === 'reject'
    ? { verify: async (token: string) => { verified.push(token); throw new AuthError('auth.unauthenticated'); } }
    : undefined;
  const auth = {
    bff: createBffKeyVerifier({ staff_web: [files.staff], partner: [files.partner], portal: [files.portal] }),
    clientIp: createClientIpResolver([]),
    ...(verifier ? { verifier } : {}),
  };

  const app = Fastify({ schemaController, genReqId, frameworkErrors: (err: any, _req: any, reply: any) => { reply.code(400).send({ code: String(err?.code ?? 'common.validation_failed') }); } } as any);
  installErrorHandlers(app);
  installRouteHooks(app, { responseValidation: false, auth });

  const seen: Seen[] = [];
  const stub = (op: string, status: number) => async (_req: any, ctx: any) => {
    seen.push({ op, bffKey: ctx.bffKey, own: Object.hasOwn(ctx, 'bffKey') });
    return status === 204 ? { status } : { status, body: {} };
  };
  // the six REAL operations, reduced to those paths (no bearerJwt operation, so no verifier is needed: this is (g))
  const real = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
  const sixSpec = { ...real, security: undefined, paths: Object.fromEntries(SIX.map((o) => {
    const key = Object.keys(real.paths).find((p) => real.paths[p]?.post?.operationId === o.id);
    if (!key) throw new Error(`contract no longer has ${o.id}`);
    return [key, real.paths[key]];
  })) };
  await mountSpec(app, 'identity', sixSpec, Object.fromEntries(SIX.map((o) => [o.id, stub(o.id, o.status)])), auth as any, boot.pipelineFor('identity'));

  // (f) bffSession operations OUTSIDE /v1/identity/auth/ (including a prefix trap: no slash after "auth")
  const outside = { '/v1/identity/session-elsewhere': 'bffOutside', '/v1/identity/authx/session': 'bffPrefixTrap', '/v1/identity/other/auth/session': 'bffNested' };
  await mountSpec(app, 'identity', extraSpec(outside, 'bffSession'), Object.fromEntries(Object.values(outside).map((id) => [id, stub(id, 200)])), auth as any, boot.pipelineFor('identity'));
  // (i) a bearerJwt operation (only mountable with a verifier)
  if (verifier) await mountSpec(app, 'identity', extraSpec({ '/v1/identity/bearer-probe': 'bearerProbe' }, 'bearerJwt'), { bearerProbe: stub('bearerProbe', 200) }, auth as any, boot.pipelineFor('identity'));

  await app.ready();
  return { app, seen, verified, close: async () => { await app.close(); await boot.close(); } };
}

type Rig = Awaited<ReturnType<typeof load>>;
let rig: Rig | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; });

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  rig!.app.inject({ method: 'POST', url, headers: { 'user-agent': 'vitest', ...headers }, remoteAddress: '203.0.113.9', ...(payload === undefined ? {} : { payload: payload as object }) });
const codeOf = (r: { body: string }): string | undefined => { try { return JSON.parse(r.body).code; } catch { return undefined; } };
const send = (o: Op, headers: Record<string, string>) => post(o.url, headers, o.payload);
const T = 15_000;

describe.each(SIX)('$id: the bffSession handler is registered and gates on key + route + cookie (LD-212)', (o) => {
  it('(a) no X-Lims-Bff-Key, valid cookie -> 401 auth.unauthenticated, handler not called, no database call', async () => {
    rig = await load();
    const before = h.queries.length;
    const r = await send(o, { cookie: COOKIE });
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.unauthenticated');
    expect(rig.seen).toEqual([]);
    expect(h.queries.length, 'rejected in the security stage: no pipeline, no database').toBe(before);
  }, T);

  it.each([
    ['a wrong key', { 'x-lims-bff-key': WRONG_KEY }],
    ['an empty key', { 'x-lims-bff-key': '' }],
    ['a kind name instead of a key', { 'x-lims-bff-key': 'staff_web' }],
    ['a configured key with one more character', { 'x-lims-bff-key': `${STAFF_KEY}x` }],
    ['a configured key sent only inside the cookie header', { cookie: `x-lims-bff-key=${STAFF_KEY}; ${COOKIE}` }],
    ['a configured key sent only as a Bearer token', { authorization: `Bearer ${STAFF_KEY}` }],
  ] as const)('(b) %s with a valid cookie -> 401, handler not called', async (_n, extra) => {
    rig = await load();
    const r = await send(o, { cookie: COOKIE, ...extra });
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.unauthenticated');
    expect(rig.seen).toEqual([]);
  }, T);

  it('(c) valid staff_web key and NO Cookie header -> 401, handler not called, no database call', async () => {
    rig = await load();
    const before = h.queries.length;
    const r = await send(o, { 'x-lims-bff-key': STAFF_KEY });
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.unauthenticated');
    expect(rig.seen).toEqual([]);
    expect(h.queries.length).toBe(before);
  }, T);

  it.each([
    ['another cookie name (lims_sid)', `lims_sid=${SID}`],
    ['the name without the __Host- prefix and another cookie', `session=x; lims_sid=${SID}`],
    ['a name that only ends in the right one', `x__Host-lims_sid=${SID}`],
    ['a name that only starts with the right one', `__Host-lims_sid2=${SID}`],
    ['a wrong-case name', `__host-lims_sid=${SID}`],
    ['an empty value', '__Host-lims_sid='],
    ['an empty value among other cookies', `a=b; __Host-lims_sid=; c=d`],
    ['the right name only as a VALUE of another cookie', `other=__Host-lims_sid=${SID}`],
    ['a value of 4097 characters', `__Host-lims_sid=${'A'.repeat(4097)}`],
    ['an empty Cookie header', ''],
  ] as const)('(d) valid key and %s -> 401, handler not called', async (_n, cookie) => {
    rig = await load();
    const r = await send(o, { 'x-lims-bff-key': STAFF_KEY, cookie });
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.unauthenticated');
    expect(rig.seen).toEqual([]);
  }, T);

  it('(e) valid staff_web key and __Host-lims_sid=<43 base64url chars> -> the stub runs, answers its status, ctx.bffKey is staff_web', async () => {
    rig = await load();
    const r = await send(o, { 'x-lims-bff-key': STAFF_KEY, cookie: COOKIE });
    expect(r.statusCode, r.body).toBe(o.status);
    expect(rig.seen).toEqual([{ op: o.id, bffKey: 'staff_web', own: true }]);
  }, T);

  it.each([
    ['among other cookies', `a=b; ${COOKIE}; c=d`],
    ['first of several', `${COOKIE}; theme=dark`],
    ['a value of exactly 4096 characters', `__Host-lims_sid=${'A'.repeat(4096)}`],
  ] as const)('(e) the cookie is accepted %s', async (_n, cookie) => {
    rig = await load();
    const r = await send(o, { 'x-lims-bff-key': STAFF_KEY, cookie });
    expect(r.statusCode, r.body).toBe(o.status);
    expect(rig.seen.map((s) => s.op)).toEqual([o.id]);
  }, T);

  it('(g) works with NO JWT verifier configured, and equally with one configured', async () => {
    for (const verifier of [undefined, 'reject' as const]) {
      rig = await load(verifier ? { verifier } : {});
      const r = await send(o, { 'x-lims-bff-key': STAFF_KEY, cookie: COOKIE });
      expect(r.statusCode, `verifier=${verifier ?? 'none'}: ${r.body}`).toBe(o.status);
      expect(rig.verified, 'the JWT verifier is not involved in a bffSession operation').toEqual([]);
      await rig.close(); rig = undefined;
    }
  }, T);

  it('(h) the 401 is problem+json with code auth.unauthenticated and carries neither the key nor the cookie value', async () => {
    rig = await load();
    const cases: Array<Record<string, string>> = [
      { 'x-lims-bff-key': WRONG_KEY, cookie: COOKIE }, // wrong key, real-looking cookie
      { 'x-lims-bff-key': STAFF_KEY, cookie: `lims_sid=${SID}` }, // real key, wrong cookie name
      { 'x-lims-bff-key': STAFF_KEY }, // real key, no cookie
    ];
    for (const headers of cases) {
      const r = await send(o, headers);
      expect(r.statusCode).toBe(401);
      expect(String(r.headers['content-type'])).toMatch(/^application\/problem\+json/);
      const body = JSON.parse(r.body);
      expect(body.code).toBe('auth.unauthenticated');
      expect(body.status).toBe(401);
      const everything = r.body + JSON.stringify(r.headers);
      for (const secret of [STAFF_KEY, WRONG_KEY, SID]) expect(everything).not.toContain(secret);
      expect(everything).not.toMatch(/bff|cookie|lims_sid|session_expired/i); // does not say which check failed
    }
  }, T);

  it('does not check the key KIND (identity does): a partner or portal key with a valid cookie reaches the handler with that kind', async () => {
    rig = await load();
    for (const [key, kind] of [[PARTNER_KEY, 'partner'], [PORTAL_KEY, 'portal']] as const) {
      rig.seen.length = 0;
      const r = await send(o, { 'x-lims-bff-key': key, cookie: COOKIE });
      expect(r.statusCode, r.body).toBe(o.status);
      expect(rig.seen).toEqual([{ op: o.id, bffKey: kind, own: true }]);
    }
  }, T);
});

describe('(f) a bffSession operation outside /v1/identity/auth/ never passes', () => {
  it.each([
    ['/v1/identity/session-elsewhere', 'bffOutside'],
    ['/v1/identity/authx/session', 'bffPrefixTrap'],
    ['/v1/identity/other/auth/session', 'bffNested'],
  ] as const)('%s with a valid key and a valid cookie -> 401, handler not called', async (url, id) => {
    rig = await load();
    const r = await post(url, { 'x-lims-bff-key': STAFF_KEY, cookie: COOKIE }, {});
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.unauthenticated');
    expect(rig.seen.filter((s) => s.op === id)).toEqual([]);
  }, T);

  it('the same key + cookie on a /v1/identity/auth/ operation passes in the same server (the rule is the path, not the credentials)', async () => {
    rig = await load();
    const r = await send(SIX[3], { 'x-lims-bff-key': STAFF_KEY, cookie: COOKIE });
    expect(r.statusCode, r.body).toBe(200);
  }, T);
});

describe('(i) a bearerJwt operation behaves as before', () => {
  it('no Authorization header: 401 auth.unauthenticated, the verifier is not called, the handler is not called', async () => {
    rig = await load({ verifier: 'reject' });
    const r = await post('/v1/identity/bearer-probe', {}, {});
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.unauthenticated');
    expect(rig.verified).toEqual([]);
    expect(rig.seen).toEqual([]);
  }, T);

  it('a Bearer token reaches the verifier, which rejects it: 401, handler not called', async () => {
    rig = await load({ verifier: 'reject' });
    const r = await post('/v1/identity/bearer-probe', { authorization: 'Bearer synthetic.jwt.value' }, {});
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.unauthenticated');
    expect(rig.verified).toEqual(['synthetic.jwt.value']);
    expect(rig.seen).toEqual([]);
  }, T);

  it('a valid BFF key plus a valid session cookie does NOT authenticate a bearerJwt operation', async () => {
    rig = await load({ verifier: 'reject' });
    const r = await post('/v1/identity/bearer-probe', { 'x-lims-bff-key': STAFF_KEY, cookie: COOKIE }, {});
    expect(r.statusCode).toBe(401);
    expect(rig.seen).toEqual([]);
    expect(rig.verified).toEqual([]);
  }, T);

  it('bearerJwt operations still cannot be mounted without a verifier (boot fails closed, unchanged)', async () => {
    rig = await load();
    // fresh modules for the throw: reuse the loaded app's registry through a second mount on a throw-away server
    const { default: Fastify } = await import('fastify');
    const { mountSpec } = await import('../../openapi.js');
    const app = Fastify();
    await expect(mountSpec(app, 'identity', extraSpec({ '/v1/identity/bearer-probe': 'bearerProbe' }, 'bearerJwt'), { bearerProbe: async () => ({ status: 200 }) } as any, { bff: { verify: () => undefined, reload() {} }, clientIp: () => '0.0.0.0' } as any, {} as any))
      .rejects.toThrow(/bearerJwt operations need LIMS_CORE_JWT/);
    await app.close();
  }, T);
});
