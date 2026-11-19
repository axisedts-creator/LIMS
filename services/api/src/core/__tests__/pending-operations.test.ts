// T0B-BOOTGATE-1 (LD-325, LD-310 blanket authority): ModuleManifest.pendingOperations.
// AC-0D-1.2 kept: handlers plus pending cover the spec operation set. Rules under test:
//   - spec operationId with neither handler nor pending entry   -> boot error naming module + id
//   - pending id that is not in the spec (typo)                 -> boot error naming module + id
//   - pending id that ALSO has a handler (stale)                -> boots, handler wins, exactly one warning naming module + id
//   - pending operation                                         -> 501 problem+json, code operation_pending, after auth + request validation
//   - production (NODE_ENV=production) + any pending entry      -> boot error unless LIMS_ALLOW_PENDING_OPS is exactly "1"
//   - every real module boots; its pending list is exactly the spec operations that lack a handler
// Interface expected from the implementation: ModuleManifest.pendingOperations?: readonly string[]; bootstrap logs the stale
// warning through app.log (opts.logStream) or console.warn; the 501 stub is mounted by bootstrap/mountSpec in the normal pipeline.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { DEFAULT_MODULES_DIR, REPO_ROOT, operationIds, loadSpec, validateManifest } from '../module.js';
import { AUD, ISS, makeKeys, makeToken } from '../auth/__tests__/helpers.js';
import { SHARED_ROOT, calls, caseDir, cfg } from './helpers.js';

const FIX = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const pendingCase = (n: string): string => caseDir(`pending/${n}`);
const open: FastifyInstance[] = [];
const authCalls = (): string[] => ((globalThis as any).__pendingAuthCalls ??= []);

beforeEach(() => {
  calls().length = 0;
  authCalls().length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((a) => a.close()));
});

interface Booted { app: FastifyInstance; warnings: string[] }

/** Boots a fixture modules dir against the shared catalog spec; collects every warn line (logStream and console.warn). */
async function bootCase(modulesDir: string, extra: Record<string, string> = {}, repoRoot = SHARED_ROOT): Promise<Booted> {
  const warnings: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')); });
  const logStream = {
    write(line: string) {
      try {
        const o = JSON.parse(line);
        if (o.level === 'warn' || o.level === 40) warnings.push(line);
      } catch { /* not a json line */ }
    },
  };
  try {
    const app = await bootstrap({ config: cfg(extra), repoRoot, modulesDir, logStream });
    open.push(app);
    return { app, warnings };
  } finally {
    spy.mockRestore();
  }
}

async function bootFailure(modulesDir: string, extra: Record<string, string> = {}): Promise<string> {
  try {
    await bootCase(modulesDir, extra);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`boot of ${modulesDir} succeeded but must fail`);
}

/** Production boot: NODE_ENV and the flag are set both in process.env and in the loadConfig env, so either read path sees them. */
function prodEnv(flag?: string): Record<string, string> {
  vi.stubEnv('NODE_ENV', 'production');
  if (flag === undefined) vi.stubEnv('LIMS_ALLOW_PENDING_OPS', '');
  else vi.stubEnv('LIMS_ALLOW_PENDING_OPS', flag);
  return { NODE_ENV: 'production', ...(flag === undefined ? {} : { LIMS_ALLOW_PENDING_OPS: flag }) };
}
const unsetFlagIsEmpty = (): void => { delete process.env.LIMS_ALLOW_PENDING_OPS; };

describe('AC-0D-1.2 kept: handlers plus pending cover the spec operation set', () => {
  it('spec operation without handler and not pending: boot fails naming the module and the operationId', async () => {
    const msg = await bootFailure(pendingCase('unlisted-missing'));
    expect(msg).toContain('deleteThing');
    expect(msg).toContain('catalog');
    expect(msg).not.toContain('createThing'); // the listed pending op is not the offender
  });

  it('pending id that is not in the spec (typo): boot fails naming the module and the id', async () => {
    const msg = await bootFailure(pendingCase('unknown-pending'));
    expect(msg).toContain('ghostOp');
    expect(msg).toContain('catalog');
  });

  it('pendingOperations that is not a string array: boot fails naming the field and the module', async () => {
    const msg = await bootFailure(pendingCase('bad-type'));
    expect(msg).toContain('pendingOperations');
    expect(msg).toContain('catalog');
  });

  it('pending id with no handler boots; the other operations still reach their handlers', async () => {
    const { app } = await bootCase(pendingCase('ok-pending'));
    const r = await app.inject({ method: 'GET', url: '/v1/catalog/things/abc-1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: 'abc-1', name: 'alpha' });
    expect(calls()).toEqual(['getThing']);
  });

  it('a module with no handler at all and every operation pending boots (default list is empty, not required)', async () => {
    const { app } = await bootCase(pendingCase('all-pending'));
    for (const [method, url] of [['GET', '/v1/catalog/things'], ['GET', '/v1/catalog/things/x'], ['DELETE', '/v1/catalog/things/x']] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(501);
    }
  });

  it('a manifest without pendingOperations behaves as before: missing handler still fails boot', async () => {
    const msg = await bootFailure(caseDir('missing-handler'));
    expect(msg).toContain('deleteThing');
  });
});

describe('stale entry: pending id that ALSO has a handler boots, the handler wins, one warning names module and id (LD-325)', () => {
  it('boots and logs exactly one warning naming catalog and deleteThing', async () => {
    const { warnings } = await bootCase(pendingCase('stale'));
    const mine = warnings.filter((w) => w.includes('deleteThing'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('catalog');
  });

  it('the real handler answers (204), not the 501 stub', async () => {
    const { app } = await bootCase(pendingCase('stale'));
    const r = await app.inject({ method: 'DELETE', url: '/v1/catalog/things/t2' });
    expect(r.statusCode).toBe(204);
    expect(calls()).toEqual(['deleteThing']);
  });

  it('no warning when nothing is stale', async () => {
    const { warnings } = await bootCase(pendingCase('ok-pending'));
    expect(warnings.filter((w) => w.includes('deleteThing'))).toHaveLength(0);
  });
});

describe('a pending operation answers 501 problem+json (code operation_pending, the operationId)', () => {
  it('public pending operation: 501, application/problem+json, code operation_pending, operationId in the body, handlers not called', async () => {
    const { app } = await bootCase(pendingCase('ok-pending'));
    const r = await app.inject({ method: 'DELETE', url: '/v1/catalog/things/t2' });
    expect(r.statusCode).toBe(501);
    expect(String(r.headers['content-type'])).toContain('application/problem+json');
    const body = r.json();
    expect(body.status).toBe(501);
    expect(body.code).toBe('operation_pending');
    expect(JSON.stringify(body)).toContain('deleteThing');
    expect(typeof body.request_id).toBe('string'); // normal problem envelope (AC-0D-3.1)
    expect(calls()).toEqual([]);
  });

  it('the stub adds no route: unknown path and an undeclared method are still 404/405', async () => {
    const { app } = await bootCase(pendingCase('ok-pending'));
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/nothing' })).statusCode).toBe(404);
    expect([404, 405]).toContain((await app.inject({ method: 'PUT', url: '/v1/catalog/things/x' })).statusCode);
  });

  describe('protected pending operation (bearerJwt): normal auth and pipeline run first, permission and tenant rules unchanged', () => {
    const ks = makeKeys('ES256');
    const nowS = () => Math.floor(Date.now() / 1000);
    const bearer = (over: Record<string, unknown> = {}) => `Bearer ${makeToken(ks, over, {}, nowS())}`;
    const authBoot = (extra: Record<string, string> = {}) => bootCase(join(FIX, 'pending-auth', 'modules'), {
      LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile, ...extra,
    }, join(FIX, 'pending-auth'));
    const echo = (app: FastifyInstance, headers: Record<string, string>, payload: unknown = { name: 'x' }) =>
      app.inject({ method: 'POST', url: '/v1/identity/echo', headers, payload: payload as any });

    it('control: the non-pending bearerJwt operation of the same module works with a valid token', async () => {
      const { app } = await authBoot();
      expect((await app.inject({ method: 'GET', url: '/v1/identity/whoami', headers: { authorization: bearer() } })).statusCode).toBe(200);
    });

    it('no token -> 401 auth.*, never 501', async () => {
      const { app } = await authBoot();
      const r = await echo(app, {});
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toMatch(/^auth\./);
    });

    it.each([
      ['garbage token', () => 'Bearer not.a.jwt'],
      ['wrong audience', () => bearer({ aud: 'service_role' })],
      ['expired token', () => bearer({ exp: nowS() - 1 })],
    ])('%s -> 401 auth.*, never 501', async (_n, header) => {
      const { app } = await authBoot();
      const r = await echo(app, { authorization: header() });
      expect(r.statusCode).toBe(401);
      expect(r.json().code).toMatch(/^auth\./);
    });

    it('valid token -> 501 problem+json operation_pending naming postIdentityEcho; handler map untouched', async () => {
      const { app } = await authBoot();
      const r = await echo(app, { authorization: bearer() });
      expect(r.statusCode).toBe(501);
      expect(String(r.headers['content-type'])).toContain('application/problem+json');
      expect(r.json().code).toBe('operation_pending');
      expect(JSON.stringify(r.json())).toContain('postIdentityEcho');
      expect(authCalls()).toEqual([]);
    });

    it('valid token + invalid body -> 400 from the normal request validation, not 501', async () => {
      const { app } = await authBoot();
      const r = await echo(app, { authorization: bearer() }, { name: 'x', extra: 1 });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).not.toBe('operation_pending');
    });

    it('the 501 body does not echo the token or the request body', async () => {
      const { app } = await authBoot();
      const secret = 'S3CRET-BODY-VALUE';
      const header = bearer();
      const r = await echo(app, { authorization: header }, { name: secret });
      expect(r.statusCode).toBe(501);
      expect(r.body).not.toContain(secret);
      expect(r.body).not.toContain(header.slice(7));
    });
  });
});

describe('production gate: NODE_ENV=production refuses any pending operation unless LIMS_ALLOW_PENDING_OPS is 1', () => {
  it('production + pending operation + flag unset: boot fails naming the module and the id', async () => {
    const extra = prodEnv();
    unsetFlagIsEmpty();
    const msg = await bootFailure(pendingCase('ok-pending'), extra);
    expect(msg).toContain('catalog');
    expect(msg).toContain('deleteThing');
    expect(msg).toMatch(/pending/i);
  });

  it.each(['0', 'true', 'yes', ' 1', '1 ', '11', ''])('production + LIMS_ALLOW_PENDING_OPS=%j: boot still fails (only exactly "1" opens the gate)', async (flag) => {
    const msg = await bootFailure(pendingCase('ok-pending'), prodEnv(flag));
    expect(msg).toContain('deleteThing');
    expect(msg).toMatch(/pending/i); // the gate refused it, not the missing-handler check
  });

  it('production + stale entry (handler exists): boot still fails, stale entries must be removed before a release', async () => {
    const extra = prodEnv();
    unsetFlagIsEmpty();
    const msg = await bootFailure(pendingCase('stale'), extra);
    expect(msg).toContain('deleteThing');
    expect(msg).toContain('catalog');
  });

  it('production + LIMS_ALLOW_PENDING_OPS=1: boots and the pending operation answers 501', async () => {
    const { app } = await bootCase(pendingCase('ok-pending'), prodEnv('1'));
    expect((await app.inject({ method: 'DELETE', url: '/v1/catalog/things/t2' })).statusCode).toBe(501);
  });

  it('production + no pending operation anywhere boots without the flag', async () => {
    const extra = prodEnv();
    unsetFlagIsEmpty();
    const { app } = await bootCase(caseDir('ok'), extra);
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things' })).statusCode).toBe(200);
  });

  it('not production (NODE_ENV=test, LIMS_CORE_ENV=ci): a pending operation boots without the flag', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    delete process.env.LIMS_ALLOW_PENDING_OPS;
    const { app } = await bootCase(pendingCase('ok-pending'));
    expect((await app.inject({ method: 'DELETE', url: '/v1/catalog/things/t2' })).statusCode).toBe(501);
  });
});

// Real modules: one test per module directory, so a failure names the module.
const realModules = existsSync(DEFAULT_MODULES_DIR)
  ? readdirSync(DEFAULT_MODULES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(DEFAULT_MODULES_DIR, e.name, 'index.ts')))
      .map((e) => e.name)
      .sort()
  : [];

async function manifestOf(dir: string): Promise<any> {
  return (await import(pathToFileURL(join(DEFAULT_MODULES_DIR, dir, 'index.ts')).href)).manifest;
}

describe('every real module boots (handlers plus pendingOperations cover its spec operations)', () => {
  it('finds the real modules', () => {
    expect(realModules.length).toBeGreaterThan(0);
  });

  it.each(realModules)('module %s passes validateManifest', { timeout: 120000 }, async (dir) => {
    const m = await manifestOf(dir);
    expect(() => validateManifest(dir, m, REPO_ROOT)).not.toThrow();
  });

  it.each(realModules)('module %s: pending list is exactly the spec operations without a handler (found by running the check, not guessed)', async (dir) => {
    const m = await manifestOf(dir);
    const pending: string[] = [...(m.pendingOperations ?? [])];
    const ops = operationIds(loadSpec(join(REPO_ROOT, m.openapi)));
    const lacking = ops.filter((op) => typeof m.handlers?.[op] !== 'function').sort();
    // LD-325(a): pending may also list an id that has a handler (stale entry, warn only), so no equality.
    expect(lacking.filter((op) => !pending.includes(op))).toEqual([]);
    expect(pending.filter((id) => !ops.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length); // no duplicate entries
  });

  it('the whole real modules directory boots with the setup env', { timeout: 120000 }, async () => {
    const app = await bootstrap({ config: loadConfig(process.env) });
    open.push(app);
    expect((await app.inject({ method: 'GET', url: '/v1/core/health/live' })).statusCode).toBe(200);
  });
});

// Release gate. It is RED while any module still lists a pending operation, so it only runs where a release is decided:
// set LIMS_RELEASE_GATE=1 (release pipeline). On main it would fail every lane until the last T0B handler task merges,
// which is the problem this task removes; the production boot gate above is what enforces it at runtime.
describe('release gate no pending operations', () => {
  it.runIf(process.env.LIMS_RELEASE_GATE === '1')('release gate no pending operations', async () => {
    const offenders: string[] = [];
    for (const dir of realModules) {
      const m = await manifestOf(dir);
      for (const id of m.pendingOperations ?? []) offenders.push(`${dir}.${id}`);
    }
    expect(offenders, 'modules still listing pending operations').toEqual([]);
  });

  it('the gate counts a module as pending when its list is non empty (fixture control)', async () => {
    const m = (await import(pathToFileURL(join(pendingCase('ok-pending'), 'catalog', 'index.ts')).href)).manifest;
    expect(m.pendingOperations).toEqual(['deleteThing']);
  });
});
