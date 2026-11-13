// T0D-18 integration (LD-133): the booted app driven through HTTP against the migrated dev database (role lims_api, RLS on).
// Stages 5-11 and 13 of 02-TRD §6.2 on real requests; ACs 2.3 (tenant per request), 2.4 (authz guard), 4.1 + 4.5 (idempotency),
// 6.1 (ports in the context). Needs LIMS_TEST_DATABASE_URL (lims_api) + LIMS_TEST_ADMIN_DATABASE_URL (superuser) from tests/db/c5-t03/run.sh;
// without them the suite skips, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails.
// Boot contract the tests expect: loadConfig() reads LIMS_CORE_DATABASE_URL, LIMS_CORE_DB_POOL_MAX, LIMS_CORE_RATELIMIT_BACKEND=postgres,
// LIMS_CORE_RATELIMIT_KEY_FILE, LIMS_CORE_TENANT_RPS, LIMS_CORE_TENANT_BURST (02-TRD §11); bootstrap() builds the pool, limiter, idempotency,
// ports and the per-request pipeline from them. Production mode cannot boot with a fixture module set (every port must be real or a listed
// phase stub, AC-0D-6.2), so the production half of stage 9 is proven in stage09-authz-guard.test.ts.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../../bootstrap.js';
import { loadConfig } from '../../config.js';
import { AUD, ISS, makeKeys, makeToken, tmpFile } from '../../auth/__tests__/helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const requireDb = process.env['LIMS_T03_REQUIRE_DB'] === '1';
const APP = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'app');
const SUB_A = '0190a000-0000-7000-8000-00000000a001';
const SUB_B = '0190a000-0000-7000-8000-00000000b001';
const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
const APPNAME = 't0d18-app';
const KEY_PREFIX = 't0d18-';
const MEMBERS = [
  'tenantId', 'actor', 'requestId', 'tx', 'now', 'ports', 'db', 'core', 'audit', 'events', 'rateLimit', 'uploads', 'files', 'storage',
  'log', 'services', 'operationId', 'clientIp', 'download', 'commitOnError', 'noRetry',
].sort();

const ks = makeKeys('ES256');
const nowS = () => Math.floor(Date.now() / 1000);
const bearer = (sub: string) => ({ authorization: `Bearer ${makeToken(ks, { sub }, {}, nowS())}` });
const hooks = () => ((globalThis as any).__t0d18 ??= { handlerRuns: 0 }) as { gate?: Promise<void>; during?: () => Promise<unknown>; handlerRuns: number };

let admin: pg.Pool;
let apiPool: pg.Pool;
const apps: FastifyInstance[] = [];
let logLines: string[] = [];

async function bootApp(extra: Record<string, string> = {}): Promise<FastifyInstance> {
  const url = new URL(API_URL!);
  url.searchParams.set('application_name', APPNAME);
  const config = loadConfig({
    LIMS_CORE_ENV: 'ci',
    LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
    LIMS_CORE_DATABASE_URL: url.toString(), LIMS_CORE_DB_POOL_MAX: '4',
    LIMS_CORE_RATELIMIT_BACKEND: 'postgres', LIMS_CORE_RATELIMIT_KEY_FILE: tmpFile('t0d18-ratelimit-hmac-key-0123456789abcdef'),
    ...extra,
  });
  const app = await bootstrap({ config, repoRoot: APP, modulesDir: join(APP, 'modules'), logStream: { write: (l) => { logLines.push(l); } } });
  apps.push(app);
  return app;
}

const post = (app: FastifyInstance, body: Record<string, unknown>, key?: string, sub = SUB_A) =>
  app.inject({ method: 'POST', url: '/v1/frontdesk/marks', headers: { ...bearer(sub), ...(key ? { 'idempotency-key': key } : {}) }, payload: body });
const notes = async (tenant: string) =>
  (await admin.query('SELECT note FROM public.t0d18_marks WHERE tenant_id = $1 ORDER BY note', [tenant])).rows.map((r) => r.note as string);
const keyRows = async (key: string) => (await admin.query('SELECT state, response_status FROM core.idempotency_keys WHERE key = $1', [key])).rows;
const codeOf = (r: { body: string }): string | undefined => { try { return JSON.parse(r.body).code; } catch { return undefined; } };

describe('T0D-18 request pipeline against the dev database', () => {
  it('database is provided', () => {
    if (requireDb) expect(live, 'LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL').toBe(true);
  });
  const d = live ? describe : describe.skip;

  d('stages', () => {
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
      apiPool = new pg.Pool({ connectionString: API_URL, max: 2 });
      await admin.query('DROP TABLE IF EXISTS public.t0d18_marks');
      await admin.query('CREATE TABLE public.t0d18_marks (tenant_id uuid NOT NULL DEFAULT app.current_tenant_id(), note text NOT NULL)');
      await admin.query('GRANT ALL ON public.t0d18_marks TO lims_api');
    }, 120000);
    afterAll(async () => {
      await Promise.all(apps.splice(0).map((a) => a.close()));
      await admin.query('DROP TABLE IF EXISTS public.t0d18_marks');
      await admin.query('DELETE FROM core.idempotency_keys WHERE key LIKE $1', [`${KEY_PREFIX}%`]);
      await Promise.all([admin.end(), apiPool.end()]);
    });
    afterEach(async () => {
      hooks().gate = undefined; hooks().during = undefined; hooks().handlerRuns = 0; logLines = [];
      await admin.query('TRUNCATE public.t0d18_marks');
      await admin.query('DELETE FROM core.idempotency_keys WHERE key LIKE $1', [`${KEY_PREFIX}%`]);
    });

    // ------------------------------------------------------------------ stage 8
    it('stage 8: the handler gets the FULL HandlerContext of 02-TRD §6.3 (no more, no fewer members) built from the verified claims', { timeout: 120000 }, async () => {
      const app = await bootApp();
      const r = await app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_A), remoteAddress: '127.0.0.1' });
      expect(r.statusCode).toBe(200);
      const b = r.json();
      expect(b.ctxKeys).toEqual(MEMBERS);
      expect(b).toMatchObject({
        tenant: TENANT_A, tenantId: TENANT_A, operationId: 'probeContext', clientIp: '127.0.0.1', services: 'frontdesk-services',
        catalogPort: 'object', txOpen: true,
      });
      expect(b.actor).toMatchObject({ type: 'user', id: SUB_A });
      expect(b.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isNaN(Date.parse(b.nowIso))).toBe(false);
    });

    it('AC-0D-6.1: ctx.ports.CatalogPort is the fake in ci/dev and lims_core_fake_ports_active counts it', async () => {
      const app = await bootApp({ LIMS_CORE_ENV: 'dev' });
      const r = await app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_A) });
      expect(r.json().catalogPort).toBe('object');
      expect(await app.metrics.render()).toMatch(/lims_core_fake_ports_active(\{[^}]*\})? [1-9]/);
    });

    // ------------------------------------------------------------------ stage 7 / AC-0D-2.3
    it('AC-0D-2.3 stage 7: tenants A and B over ONE pooled server connection each see their own tenant; no transaction or tenant stays behind', async () => {
      const app = await bootApp({ LIMS_CORE_DB_POOL_MAX: '1' });
      const [a, b] = await Promise.all([
        app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_A) }),
        app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_B) }),
      ]);
      expect(a.json().tenant).toBe(TENANT_A);
      expect(b.json().tenant).toBe(TENANT_B);
      const open = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND (xact_start IS NOT NULL AND state <> 'idle')`, [APPNAME]);
      expect(open.rows[0].n).toBe(0);
      expect((await apiPool.query('SELECT app.current_tenant_id() AS t')).rows[0].t).toBeNull(); // outside a transaction: NULL
    });

    it('stage 7: the request transaction is open while the handler runs (tenant op) and the public op has NONE', async () => {
      const app = await bootApp();
      hooks().during = async () => (await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND xact_start IS NOT NULL AND state <> 'idle'`, [APPNAME])).rows[0].n;
      const t = await app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_A) });
      expect(t.json().during).toBeGreaterThanOrEqual(1);
      const p = await app.inject({ method: 'GET', url: '/v1/frontdesk/public-probe' });
      expect(p.statusCode).toBe(200);
      expect(p.json()).toMatchObject({ tx: 'none', tenantId: null, operationId: 'publicProbe', during: 0 });
    });

    // ------------------------------------------------------------------ stage 11
    it('stage 11: 2xx COMMITS (row visible to its tenant only)', async () => {
      const app = await bootApp();
      expect((await post(app, { note: 't0d18-ok' }, `${KEY_PREFIX}c1`)).statusCode).toBe(201);
      expect(await notes(TENANT_A)).toEqual(['t0d18-ok']);
      expect(await notes(TENANT_B)).toEqual([]);
      const listed = await app.inject({ method: 'GET', url: '/v1/frontdesk/marks', headers: bearer(SUB_B) });
      expect(listed.json().notes).toEqual([]);
    });

    it('stage 11: a 4xx result ROLLS BACK the handler\'s write', async () => {
      const app = await bootApp();
      const r = await post(app, { note: 't0d18-bad', mode: 'bad_request' }, `${KEY_PREFIX}r1`);
      expect(r.statusCode).toBe(400);
      expect(await notes(TENANT_A)).toEqual([]);
    });

    it('stage 11: a thrown error (500 common.internal) ROLLS BACK and does not leak the message', async () => {
      const app = await bootApp();
      const r = await post(app, { note: 't0d18-boom', mode: 'boom' }, `${KEY_PREFIX}r2`);
      expect(r.statusCode).toBe(500);
      expect(codeOf(r)).toBe('common.internal');
      expect(r.body).not.toContain('boom');
      expect(await notes(TENANT_A)).toEqual([]);
    });

    it('stage 11: ctx.commitOnError() keeps the write of a 403 (and the idempotency key is released, AC-0D-4.5)', async () => {
      const app = await bootApp();
      const k = `${KEY_PREFIX}coe`;
      expect((await post(app, { note: 't0d18-denied', mode: 'denied_commit' }, k)).statusCode).toBe(403);
      expect(await notes(TENANT_A)).toEqual(['t0d18-denied']);
      expect(await keyRows(k)).toEqual([]);
      // retry with the same key runs the handler again
      expect((await post(app, { note: 't0d18-denied', mode: 'denied_commit' }, k)).statusCode).toBe(403);
      expect(hooks().handlerRuns).toBe(2);
      expect(await notes(TENANT_A)).toEqual(['t0d18-denied', 't0d18-denied']);
    });

    // ------------------------------------------------------------------ stages 6 + 10
    it('AC-0D-4.1 stage 6: x-idempotency required without Idempotency-Key -> 400 common.idempotency_key_required, handler not run', async () => {
      const app = await bootApp();
      const r = await post(app, { note: 't0d18-nokey' });
      expect(r.statusCode).toBe(400);
      expect(codeOf(r)).toBe('common.idempotency_key_required');
      expect(hooks().handlerRuns).toBe(0);
    });

    it('AC-0D-4.2 stages 6+10: success is stored in the same transaction and replayed with Idempotent-Replayed: true; handler runs once', async () => {
      const app = await bootApp();
      const k = `${KEY_PREFIX}rep`;
      const first = await post(app, { note: 't0d18-once' }, k);
      expect(first.statusCode).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await keyRows(k)).toEqual([{ state: 'completed', response_status: 201 }]);
      const second = await post(app, { note: 't0d18-once' }, k);
      expect(second.statusCode).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());
      expect(hooks().handlerRuns).toBe(1);
      expect(await notes(TENANT_A)).toEqual(['t0d18-once']);
    });

    it('AC-0D-4.3: same key, different body -> 422 common.idempotency_key_reused; handler not run again', async () => {
      const app = await bootApp();
      const k = `${KEY_PREFIX}reuse`;
      await post(app, { note: 't0d18-a' }, k);
      const r = await post(app, { note: 't0d18-b' }, k);
      expect(r.statusCode).toBe(422);
      expect(codeOf(r)).toBe('common.idempotency_key_reused');
      expect(hooks().handlerRuns).toBe(1);
    });

    it('AC-0D-4.4: same key while the first request is still running -> 409 common.idempotency_in_progress, Retry-After: 1', async () => {
      const app = await bootApp();
      const k = `${KEY_PREFIX}busy`;
      let open!: () => void;
      hooks().gate = new Promise<void>((res) => { open = res; });
      const first = post(app, { note: 't0d18-slow', mode: 'slow' }, k);
      for (let i = 0; i < 100 && hooks().handlerRuns === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(hooks().handlerRuns).toBe(1);
      const second = await post(app, { note: 't0d18-slow', mode: 'slow' }, k);
      expect(second.statusCode).toBe(409);
      expect(codeOf(second)).toBe('common.idempotency_in_progress');
      expect(second.headers['retry-after']).toBe('1');
      open();
      expect((await first).statusCode).toBe(201);
      expect(hooks().handlerRuns).toBe(1);
    });

    it('AC-0D-4.5: a 4xx / 5xx stores nothing and releases the key after the rollback; a retry with the same key runs the handler again', async () => {
      const app = await bootApp();
      for (const [mode, status] of [['bad_request', 400], ['boom', 500]] as const) {
        const k = `${KEY_PREFIX}rel-${mode}`;
        const before = hooks().handlerRuns;
        expect((await post(app, { note: `t0d18-${mode}`, mode }, k)).statusCode, mode).toBe(status);
        expect(await keyRows(k), mode).toEqual([]);
        // identical retry with the same key runs the handler again (not a 409 in_progress, not a replay)
        const retry = await post(app, { note: `t0d18-${mode}`, mode }, k);
        expect(retry.statusCode, mode).toBe(status);
        expect(retry.headers['idempotent-replayed'], mode).toBeUndefined();
        expect(hooks().handlerRuns - before, mode).toBe(2);
        expect(await notes(TENANT_A), mode).toEqual([]);
      }
    });

    it('idempotency keys are per tenant/actor: the same key from tenant B is its own row and runs its own handler', async () => {
      const app = await bootApp();
      const k = `${KEY_PREFIX}tenants`;
      expect((await post(app, { note: 't0d18-x' }, k, SUB_A)).statusCode).toBe(201);
      const b = await post(app, { note: 't0d18-x' }, k, SUB_B);
      expect(b.statusCode).toBe(201);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
      expect(await notes(TENANT_B)).toEqual(['t0d18-x']);
    });

    // ------------------------------------------------------------------ stage 5
    it('stage 5: tenant tier `general` is enforced by the pipeline: over the burst -> 429 common.rate_limited + Retry-After, no handler, no idempotency claim, metric counted', { timeout: 120000 }, async () => {
      await admin.query('DELETE FROM core.rate_limit_counters');
      const app = await bootApp({ LIMS_CORE_TENANT_RPS: '1', LIMS_CORE_TENANT_BURST: '2' });
      const get = () => app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_B) });
      expect((await get()).statusCode).toBe(200);
      expect((await get()).statusCode).toBe(200);
      const k = `${KEY_PREFIX}limited`;
      const denied = await post(app, { note: 't0d18-limited' }, k, SUB_B);
      expect(denied.statusCode).toBe(429);
      expect(codeOf(denied)).toBe('common.rate_limited');
      expect(Number(denied.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(hooks().handlerRuns).toBe(0);
      expect(await keyRows(k)).toEqual([]);
      expect(await notes(TENANT_B)).toEqual([]);
      expect(await app.metrics.render()).toMatch(/lims_ratelimit_rejections_total\{[^}]*tier="general"[^}]*\} [1-9]/);
      await new Promise((r) => setTimeout(r, 4100)); // window = ceil(burst / rps) = 2 s; two full windows so the sliding estimate (05-SCHEMA ratelimit_hit, denied hits count) sees 0 previous hits
      expect((await get()).statusCode).toBe(200);
      await admin.query('DELETE FROM core.rate_limit_counters');
    });

    // ------------------------------------------------------------------ stage 9 / AC-0D-2.4
    it.each(['ci', 'dev'])('AC-0D-2.4 stage 9 (%s): 2xx without IdentityPort.assertRole -> 500 common.internal, log authz_not_asserted{operationId}, the write is rolled back, the key released', async (env) => {
      const app = await bootApp({ LIMS_CORE_ENV: env });
      const k = `${KEY_PREFIX}noassert-${env}`;
      const r = await post(app, { note: 't0d18-noassert', mode: 'no_assert' }, k);
      expect(r.statusCode).toBe(500);
      expect(codeOf(r)).toBe('common.internal');
      const line = logLines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).find((o) => o?.event === 'authz_not_asserted');
      expect(line, 'log line authz_not_asserted').toBeDefined();
      expect(line.operationId).toBe('createMark');
      expect(await notes(TENANT_A)).toEqual([]);
      expect(await keyRows(k)).toEqual([]);
      expect(await app.metrics.render()).toMatch(/lims_core_authz_not_asserted_total\{[^}]*operation_id="createMark"[^}]*\} [1-9]/);
    });

    it('stage 9: an operation that does assert, and a public operation, are not touched by the guard', async () => {
      const app = await bootApp();
      expect((await post(app, { note: 't0d18-fine' }, `${KEY_PREFIX}fine`)).statusCode).toBe(201);
      expect((await app.inject({ method: 'GET', url: '/v1/frontdesk/public-probe' })).statusCode).toBe(200);
      expect(logLines.some((l) => l.includes('authz_not_asserted'))).toBe(false);
    });

    // ------------------------------------------------------------------ stage 12 (unchanged) with the pipeline in place
    it('stage 12 toggle still works behind the pipeline: on -> 500 response_contract_violation, off -> the handler body', async () => {
      const on = await bootApp({ LIMS_CORE_RESPONSE_VALIDATION: 'on' });
      const r = await on.inject({ method: 'GET', url: '/v1/frontdesk/bad-shape', headers: bearer(SUB_A) });
      expect(r.statusCode).toBe(500);
      expect(logLines.some((l) => l.includes('response_contract_violation'))).toBe(true);
      const off = await bootApp({ LIMS_CORE_RESPONSE_VALIDATION: 'off' });
      expect((await off.inject({ method: 'GET', url: '/v1/frontdesk/bad-shape', headers: bearer(SUB_A) })).statusCode).toBe(200);
    });

    // ------------------------------------------------------------------ stage 13
    it('stage 13: one request log line with tenant and actor of the verified claims, and lims_http_requests_total for the operation', async () => {
      const app = await bootApp();
      await app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_A) });
      const lines = logLines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter((o) => o?.msg === 'request' && o.operation_id === 'probeContext');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ module: 'frontdesk', status: 200, tenant_id: TENANT_A, actor_id: SUB_A, actor_type: 'user', route: '/v1/frontdesk/probe' });
      expect(await app.metrics.render()).toMatch(/lims_http_requests_total\{[^}]*operation_id="probeContext"[^}]*status="200"[^}]*\} [1-9]/);
    });

    // ------------------------------------------------------------------ attack
    it('attack: tenant id / actor in the body, query or headers never reach the transaction (claims only)', async () => {
      const app = await bootApp();
      const r = await app.inject({
        method: 'GET', url: '/v1/frontdesk/probe', headers: { ...bearer(SUB_A), 'x-tenant-id': TENANT_B, 'x-lims-tenant': TENANT_B },
      });
      expect(r.json().tenant).toBe(TENANT_A);
    });

    it('attack: a bad token never opens a transaction or consumes a rate-limit slot for a tenant', async () => {
      const app = await bootApp();
      const r = await app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: { authorization: 'Bearer not.a.token' } });
      expect(r.statusCode).toBe(401);
      expect(hooks().handlerRuns).toBe(0);
    });

    it('attack: 20 parallel creates with the SAME key run the handler once and leave exactly one row', { timeout: 120000 }, async () => {
      await admin.query('DELETE FROM core.rate_limit_counters');
      const app = await bootApp();
      const k = `${KEY_PREFIX}race`;
      const rs = await Promise.all(Array.from({ length: 20 }, () => post(app, { note: 't0d18-race' }, k)));
      expect(rs.filter((r) => r.statusCode === 201 && !r.headers['idempotent-replayed'])).toHaveLength(1);
      expect(rs.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
      expect(await notes(TENANT_A)).toEqual(['t0d18-race']);
    });

    it('attack: a dependency failure (database unreachable) is 503 common.dependency_unavailable, not a hang or a 500 with detail', { timeout: 120000 }, async () => {
      const url = new URL(API_URL!);
      url.port = '1'; // nothing listens
      const app = await bootApp({ LIMS_CORE_DATABASE_URL: url.toString() });
      const r = await app.inject({ method: 'GET', url: '/v1/frontdesk/probe', headers: bearer(SUB_A) });
      expect(r.statusCode).toBe(503);
      expect(codeOf(r)).toBe('common.dependency_unavailable');
    });
  });
});
