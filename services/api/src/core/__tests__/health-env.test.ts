// T0B-OPSDOC-1 (audit RS-16, LD-277) done_when (3), (4): GET /v1/core/health/ready says `degraded` and names the
// REQUIRED variables that are unset (names only, never values). Interface these tests expect (see
// .orchestra/notes/T0B-OPSDOC-1-tests.md):
//   - bootstrap({ ..., env }): env replaces process.env for this check (default process.env), so a test controls presence.
//   - "required" = the rows marked `required` in docs/runbooks/environment.md (single source of truth).
//   - unset = missing or empty string.
//   - body: { status, checks:{db,ratelimit}, missing_env?: string[] }; missing_env is sorted, present only when non-empty;
//     any unset required name makes status `degraded` (HTTP 200) unless a dependency is down (503, missing_env not sent).
//   - contracts/openapi/core.yaml Readiness gains optional `missing_env` (array of strings); the schema is closed
//     (additionalProperties:false), so without that change response validation (on in ci) turns the answer into a 500.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { EMPTY_MODULES } from '../observability/__tests__/helpers.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const READY = '/v1/core/health/ready';
const SENTINEL = 'SENTINEL-VALUE-must-never-appear';

const docRows = (): { name: string; required: boolean }[] => {
  const md = readFileSync(join(ROOT, 'docs', 'runbooks', 'environment.md'), 'utf8'); // fails now: file missing
  const out: { name: string; required: boolean }[] = [];
  for (const line of md.split(/\r?\n/)) {
    const c = line.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.replace(/[`*]/g, '').trim());
    if (c.length >= 4 && /^LIMS_[A-Z0-9_]*[A-Z0-9]$/.test(c[0]!) && /^(required|optional)$/i.test(c[2]!)) out.push({ name: c[0]!, required: /^required$/i.test(c[2]!) });
  }
  return out;
};
const requiredNames = (): string[] => docRows().filter((r) => r.required).map((r) => r.name).sort();
const optionalNames = (): string[] => docRows().filter((r) => !r.required).map((r) => r.name).sort();
const envWith = (set: string[]): Record<string, string> => Object.fromEntries(set.map((n) => [n, `${SENTINEL}-${n}`]));

const open: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });
async function boot(env: Record<string, string>, db: 'ok' | 'down' = 'ok'): Promise<FastifyInstance> {
  const app = await bootstrap({
    config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOG_LEVEL: 'silent' }), // response validation is on in ci
    modulesDir: EMPTY_MODULES,
    healthChecks: { db: async () => db, ratelimit: async () => 'ok' },
    env,
  } as any);
  open.push(app);
  return app;
}
const ready = async (env: Record<string, string>, db: 'ok' | 'down' = 'ok') =>
  (await boot(env, db)).inject({ method: 'GET', url: READY });

describe('T0B-OPSDOC-1 readiness reports unset required variables', () => {
  it('all required names set: status ok, no missing_env key', async () => {
    const r = await ready(envWith(requiredNames()));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', checks: { db: 'ok', ratelimit: 'ok' } });
  });

  it('each required name unset on its own: degraded, 200, and exactly that name is listed', async () => {
    const req = requiredNames();
    expect(req.length).toBeGreaterThan(0); // the document must mark at least one name required
    for (const name of req) {
      const r = await ready(envWith(req.filter((n) => n !== name)));
      expect(r.statusCode, name).toBe(200);
      expect(r.json(), name).toEqual({ status: 'degraded', checks: { db: 'ok', ratelimit: 'ok' }, missing_env: [name] });
    }
  }, 600000);

  it('all required names unset: every one is listed, sorted', async () => {
    const r = await ready({});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'degraded', checks: { db: 'ok', ratelimit: 'ok' }, missing_env: requiredNames() });
  });

  it('an empty string counts as unset', async () => {
    const req = requiredNames();
    const env = { ...envWith(req), [req[0]!]: '' };
    expect((await ready(env)).json().missing_env).toEqual([req[0]]);
  });

  it('an optional name that is unset never degrades the answer', async () => {
    const r = await ready(envWith(requiredNames())); // no optional name is set
    expect(optionalNames().length).toBeGreaterThan(0);
    expect(r.json().status).toBe('ok');
    expect(r.json().missing_env).toBeUndefined();
  });

  it('names only: no value of any variable reaches the body, set or unset', async () => {
    const req = requiredNames();
    const env = { ...envWith(req.slice(1)), ...envWith(optionalNames()), LIMS_CORE_DATABASE_URL: `postgres://u:${SENTINEL}@h/db` };
    const r = await ready(env);
    expect(r.body).not.toContain(SENTINEL);
    expect(r.body).not.toContain('postgres://');
    expect(r.json().missing_env).toEqual([req[0]]);
    expect(Object.keys(r.json()).sort()).toEqual(['checks', 'missing_env', 'status']);
    for (const n of r.json().missing_env as string[]) expect(n).toMatch(/^LIMS_[A-Z0-9_]*[A-Z0-9]$/);
  });

  it('a down dependency still wins: 503 status down, and missing_env is NOT sent (names only when degraded)', async () => {
    const r = await ready({}, 'down');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'down', checks: { db: 'down', ratelimit: 'ok' } });
  });

  it('x-public: anonymous and bogus-credential callers get the same body (no tenant data)', async () => {
    const app = await boot({});
    const a = await app.inject({ method: 'GET', url: READY });
    const b = await app.inject({ method: 'GET', url: READY, headers: { authorization: 'Bearer eyJ.fake.jwt', 'x-tenant-id': 'tenant-b' } });
    expect(b.statusCode).toBe(a.statusCode);
    expect(b.body).toBe(a.body);
  });

  it('liveness is untouched: still {status:"ok"} when every required name is unset', async () => {
    const r = await (await boot({})).inject({ method: 'GET', url: '/v1/core/health/live' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });

  it('contract: Readiness allows an optional missing_env array of strings and keeps checks closed', () => {
    const y = readFileSync(join(ROOT, 'contracts', 'openapi', 'core.yaml'), 'utf8');
    const readiness = y.slice(y.indexOf('    Readiness:'));
    expect(readiness).toMatch(/missing_env:\s*\{?[^\n]*(array|\n\s+type:\s*array)/);
    expect(readiness).not.toMatch(/required:\s*\[[^\]]*missing_env/); // optional, so the ok body stays unchanged
  });
});
