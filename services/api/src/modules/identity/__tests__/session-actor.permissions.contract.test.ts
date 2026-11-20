// AUTH-ACTOR-2 (LD-222): ONE contract test with the REAL response validator. The real Fastify route stack (installRouteHooks with response validation ON from loadConfig of
// LIMS_CORE_ENV=staging, mountSpec of the real contracts/openapi/identity.yaml reduced to six paths, real bootPipeline + onRequest BFF-key hook over a fake `pg`) serves the REAL handlers
// of loginStaff, resolveSession, verifyMfaChallenge, completeMfaEnrolment, setPasswordFromSetup and confirmEmailToken over fake repos / fake GoTrue. For a tenant and a platform case every 2xx
// must pass the validator (a violation is a 500 common.internal + log response_contract_violation). Also pins the contract: SessionState.actor.permissions is ONE optional array
// (<= 400 items of <= 100 chars) and nothing else about the actor changes.
// Seams: the six handlers take fakes through their factories (createLoginHandler, createResolveSession, createVerifyMfaChallenge, createCompleteMfaEnrolment, createSetPasswordFromSetup,
// createConfirmEmailToken); only ctx.db is swapped for the fake worlds' transaction envelope. Expected now: setPasswordFromSetup / confirmEmailToken fail (no actor: the live 500),
// every `permissions` body fails (additionalProperties: false on the actor).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createBffKeyVerifier } from '../../../core/auth/bff-key.js';
import { createClientIpResolver } from '../../../core/auth/client-ip.js';
import { loadConfig } from '../../../core/config.js';
import { genReqId, installErrorHandlers } from '../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { installRouteHooks, mountSpec, schemaController } from '../../../core/openapi.js';
import { bootPipeline } from '../../../core/pipeline/boot.js';
import { manifest } from '../index.js';
import { permissionsOfRoles } from '../domain/permission-set.js';
import { createLoginHandler, parseBody } from '../handlers/loginStaff.js';
import { createResolveSession } from '../handlers/resolveSession.js';
import { createVerifyMfaChallenge } from '../handlers/verifyMfaChallenge.js';
import { createCompleteMfaEnrolment } from '../handlers/completeMfaEnrolment.js';
import { createStartMfaEnrolment } from '../handlers/startMfaEnrolment.js';
import { createSetPasswordFromSetup } from '../handlers/setPasswordFromSetup.js';
import { createConfirmEmailToken } from '../handlers/confirmEmailToken.js';
import { EMAIL, PASSWORD, SUB, makeWorld as makeAuthWorld, platformRow, tenantRow } from '../service/__tests__/auth.helpers.js';
import { makeMfaWorld, totp } from '../handlers/__tests__/mfa.helpers.js';
import { GOOD_PW, makeWorld as makeRecoveryWorld } from '../handlers/__tests__/recovery.helpers.js';
import { makeSessionWorld } from '../handlers/__tests__/session.helpers.js';

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

const STAFF_KEY = 'synthetic-staff-web-bff-key-0123456789abcdef0123456789';
const OPS = ['loginStaff', 'resolveSession', 'verifyMfaChallenge', 'completeMfaEnrolment', 'setPasswordFromSetup', 'confirmEmailToken'] as const;
type Op = (typeof OPS)[number];
type Fn = (req: any, ctx: any) => Promise<unknown>;
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };
const fakeTx = () => ({ query: async () => ({ rows: [] }), bindTenant: async () => undefined });
/** ctx.db replaced by a fake world's transaction envelope; everything else of the pipeline ctx (actor, bffKey, requestId, clientIp, commitOnError, log) stays real */
const withDb = (run: (fn: () => Promise<unknown>) => Promise<unknown>) => (h: Fn): Fn => (req, ctx) =>
  h(req, { ...ctx, db: { identityAuthTx: (_i: unknown, fn: any) => run(() => fn(fakeTx(), { noRetry: () => undefined })) } });
const plain = withDb((f) => f());

const cur: Partial<Record<Op, Fn>> = {};
let scratch: string; let app: Awaited<ReturnType<typeof Fastify>>; let close: () => Promise<void>; let responseValidation = false;
const paths: Record<string, { url: string; method: 'GET' | 'POST' }> = {};

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-actor2-'));
  const f = (n: string, t: string) => { const p = join(scratch, n); writeFileSync(p, t, { mode: 0o600 }); return p; };
  const staff = f('staff.key', `${STAFF_KEY}\n`); const ratelimit = f('ratelimit.key', 'a'.repeat(64));
  const env = { ...process.env, LIMS_CORE_DATABASE_URL: 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims', LIMS_CORE_RATELIMIT_KEY_FILE: ratelimit } as Record<string, string>;
  // staging config decides response validation (ON outside production); the pipeline itself boots under ci (staging would demand every module's port owner, not loaded in this test)
  const staging = loadConfig({ ...env, LIMS_CORE_ENV: 'staging' }); responseValidation = staging.responseValidation;
  const config = loadConfig({ ...env, LIMS_CORE_ENV: 'ci' });
  const boot = await bootPipeline({ config, modules: [{ manifest, spec: {} }] as any, log: quiet as any, metrics: metrics as any });
  const auth = { bff: createBffKeyVerifier({ staff_web: [staff] }), clientIp: createClientIpResolver([]) };
  app = Fastify({ schemaController, genReqId, frameworkErrors: (err: any, _r: any, reply: any) => { reply.code(400).send({ code: String(err?.code ?? 'common.validation_failed') }); } } as any);
  installErrorHandlers(app);
  installRouteHooks(app, { responseValidation: staging.responseValidation, auth });   // the REAL response validator, switched by the real config
  const real: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
  const keep: Record<string, unknown> = {};
  for (const [url, item] of Object.entries<any>(real.paths)) for (const m of ['get', 'post']) {
    const id = item?.[m]?.operationId; if ((OPS as readonly string[]).includes(id)) { keep[url] = { ...(keep[url] as object), [m]: item[m] }; paths[id] = { url, method: m.toUpperCase() as 'GET' | 'POST' }; }
  }
  const spec = { ...real, security: undefined, paths: keep };
  const handlers = Object.fromEntries(OPS.map((op) => [op, (async (req: any, ctx: any) => { const h = cur[op]; if (!h) throw new Error(`no fake wired for ${op}`); return h(req, ctx); }) as any]));
  await mountSpec(app as any, 'identity', spec, handlers, auth as any, boot.pipelineFor('identity'));
  await app.ready();
  close = async () => { await app.close(); await boot.close(); };
}, 120_000);
afterAll(async () => { await close?.(); rmSync(scratch, { recursive: true, force: true }); });

const call = (op: Op, o: { token?: string; body?: unknown; params?: Record<string, string> } = {}) => app.inject({
  method: paths[op]!.method, url: Object.entries(o.params ?? {}).reduce((u, [k, v]) => u.replace(`{${k}}`, v), paths[op]!.url), remoteAddress: '203.0.113.9',
  headers: { 'x-lims-bff-key': STAFF_KEY, 'user-agent': 'vitest', ...(o.token ? { cookie: `__Host-lims_sid=${o.token}` } : {}) }, payload: (o.body ?? {}) as any,
});
const json = (r: { body: string }) => { try { return JSON.parse(r.body); } catch { return undefined; } };
const stateOf = (b: any) => (b?.session ?? b)?.state as string;
const actorOf = (b: any) => (b?.session ?? b)?.actor;

/** wire the six fakes for one kind; returns the requests that exercise each operation */
async function scenario(kind: 'tenant_staff' | 'platform') {
  const platform = kind === 'platform';
  // loginStaff
  const aw = makeAuthWorld({ rows: { [SUB]: platform ? platformRow() : tenantRow() } });
  cur.loginStaff = plain(createLoginHandler('loginStaff', parseBody, () => aw.deps as any, (svc, c, i) => svc.loginStaff(c, i)) as Fn);
  // resolveSession (active)
  const sw = await makeSessionWorld(); const rs = sw.addSession({ kind });
  cur.resolveSession = withDb((fn) => { const tx = {}; return (sw.store as any).envelope(tx, fn); })(createResolveSession(sw.deps as any) as Fn);
  // verifyMfaChallenge + completeMfaEnrolment (one MFA world, two sessions)
  const mw = await makeMfaWorld({ kind }); const vs = await mw.addSession({ verifiedFactor: true }); const es = await mw.addSession({ state: 'mfa_enrolment_required' });
  const started: any = await (createStartMfaEnrolment(mw.deps as any) as any)(mw.req({ token: es.token, body: {} }), mw.makeHctx({ operationId: 'startMfaEnrolment' }).hctx);
  const mfaDb = withDb((fn) => (mw.store as any).envelope(fn));
  cur.verifyMfaChallenge = mfaDb(createVerifyMfaChallenge(mw.deps as any) as Fn); cur.completeMfaEnrolment = mfaDb(createCompleteMfaEnrolment(mw.deps as any) as Fn);
  // setPasswordFromSetup + confirmEmailToken
  const rw = await makeRecoveryWorld(); const setup = await rw.addSetupSession(platform ? { kind: 'platform' } : {});
  const recDb = withDb((fn) => (rw.store as any).envelope(fn));
  cur.setPasswordFromSetup = recDb(createSetPasswordFromSetup(rw.deps as any) as Fn); cur.confirmEmailToken = recDb(createConfirmEmailToken(rw.deps as any) as Fn);
  const u = await rw.addUser({ row: platform ? platformRow() : tenantRow() }); await rw.gw.sendRecovery(u.email, '/auth/confirm');
  const hash = rw.fake!.mailbox.latestTokenHash(u.email, 'recovery')!;
  return {
    loginStaff: () => call('loginStaff', { body: { email: EMAIL, password: PASSWORD } }),
    resolveSession: () => call('resolveSession', { token: rs.token, body: { touch: false } }),
    verifyMfaChallenge: () => call('verifyMfaChallenge', { token: vs.token, body: { code: totp(vs.secret!) } }),
    completeMfaEnrolment: () => call('completeMfaEnrolment', { token: es.token, body: { code: totp(started.body.secret_base32) }, params: { factor_id: started.body.factor_id } }),
    setPasswordFromSetup: () => call('setPasswordFromSetup', { token: setup.token, body: { new_password: GOOD_PW } }),
    confirmEmailToken: () => call('confirmEmailToken', { body: { token_hash: hash, type: 'recovery' } }),
  } satisfies Record<Op, () => ReturnType<typeof call>>;
}

describe('the validator in this test is the real one and it is ON (guards against a vacuous pass)', () => {
  it('LIMS_CORE_ENV=staging gives responseValidation true; a 2xx body that violates the contract (no actor) becomes 500 common.internal', async () => {
    expect(responseValidation).toBe(true);
    cur.loginStaff = async () => ({ status: 200, body: { session_token: 'A'.repeat(43), session: { session_id: '0190a000-0000-7000-8000-000000000001', kind: 'platform', state: 'mfa_pending', aal: 'aal1', idle_expires_at: '2026-11-15T07:00:00.000Z', absolute_expires_at: '2026-11-15T15:00:00.000Z' } } });
    const r = await call('loginStaff', { body: { email: EMAIL, password: PASSWORD } });
    expect(r.statusCode).toBe(500); expect(json(r)?.code).toBe('common.internal');
  });
});

describe('SessionState.actor.permissions in the contract: ONE optional array, nothing else changes', () => {
  const session = { session_id: '0190a000-0000-7000-8000-000000000001', kind: 'tenant_staff', state: 'active', aal: 'aal2', idle_expires_at: '2026-11-15T07:00:00.000Z', absolute_expires_at: '2026-11-15T15:00:00.000Z' };
  const act = { display_name: 'Ana Demo', roles: ['lab_manager'], tenant_code: 'lab_a' };
  const serve = (actor: unknown) => { cur.loginStaff = async () => ({ status: 200, body: { session_token: 'A'.repeat(43), session: { ...session, actor } } }); return call('loginStaff', { body: { email: EMAIL, password: PASSWORD } }); };
  it('absent, empty, 400 items and 100-char entries are valid', async () => {
    for (const a of [act, { ...act, permissions: [] }, { ...act, permissions: ['lab.result.read'] }, { ...act, permissions: Array.from({ length: 400 }, (_, i) => `x.y.c${i}`) }, { ...act, permissions: ['x'.repeat(100)] }]) {
      expect((await serve(a)).statusCode).toBe(200);
    }
  });
  it('401 items, a 101-char entry, a non-string entry, a non-array and an unknown actor key are each a contract violation (500)', async () => {
    for (const a of [{ ...act, permissions: Array.from({ length: 401 }, (_, i) => `x.y.c${i}`) }, { ...act, permissions: ['x'.repeat(101)] }, { ...act, permissions: [7] }, { ...act, permissions: 'lab.result.read' }, { ...act, permissions: null }, { ...act, email: 'a@example.test' }]) {
      expect((await serve(a)).statusCode, JSON.stringify(a).slice(0, 80)).toBe(500);
    }
  });
});

describe.each(['tenant_staff', 'platform'] as const)('the 2xx body of the six operations passes the real response validator: %s', (kind) => {
  it.each(OPS)('%s', async (op) => {
    const s = await scenario(kind); const r = await s[op]();
    expect(r.statusCode, `${op}: ${r.body}`).toBe(200);              // 500 = response_contract_violation (or a handler failure)
    const b = json(r); const actor = actorOf(b);
    expect(actor, `${op} body carries actor`).toBeTruthy(); expect(actor.display_name).toBeTruthy(); expect(Array.isArray(actor.roles)).toBe(true);
    if (stateOf(b) === 'active') {
      expect(Array.isArray(actor.permissions), `${op} active -> permissions`).toBe(true);
      expect(actor.permissions.length).toBeGreaterThan(0);
      if (kind === 'platform') expect(actor.permissions).toEqual(permissionsOfRoles(['platform_support']));
    } else {
      expect(Object.keys(actor), `${op} state ${stateOf(b)} -> no permissions`).not.toContain('permissions');
    }
  });
  it('the six operations together answered with the states the rule needs: both an active and a non-active body were validated', async () => {
    const s = await scenario(kind); const states = new Set<string>();
    for (const op of OPS) states.add(stateOf(json(await s[op]())));
    expect(states.has('active')).toBe(true); expect([...states].some((x) => x !== 'active')).toBe(true);
  });
});
