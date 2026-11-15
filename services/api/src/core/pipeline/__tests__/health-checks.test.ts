// WIRE-HEALTH / LD-193 (C1): real readiness checks behind GET /v1/core/health/ready. No network: a fake query function and a fake `pg`.
// C0 02-TRD s8 line 876 (getReadiness { status, checks: { db, ratelimit } }, ok/degraded/down, 503 when down, dependency names only).
//
// INTERFACE these tests expect (documented in .orchestra/notes/WIRE-HEALTH-tests.md, disputable in WIRE-HEALTH-dispute-*.md):
//   core/pipeline/healthChecks.ts  export function createHealthChecks(o: { query; limiterConfigured: boolean; log?: { warn(o, m?) } }): HealthChecks
//     query(text: string, values?: unknown[]): Promise<{ rows: any[] }>   (same shape as pg.Pool#query)
//     db():        runs `SELECT 1`; ok on resolve, down on reject or after 2000 ms
//     ratelimit(): ONE read-only catalog statement (pg_proc + has_function_privilege, app.ratelimit_hit) that returns zero rows when the
//                  function does not exist, else ONE row { can_execute: boolean }; ok only for { can_execute: true } and limiterConfigured
//   core/pipeline/boot.ts  bootPipeline(...) resolves with an optional `healthChecks` (present with a database, absent or all-down without)
//   core/bootstrap.ts      opts.healthChecks first, else the boot's real checks, else UNWIRED_CHECKS
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MODULES } from '../../observability/__tests__/helpers.js';

const READY = '/v1/core/health/ready';
const DB_TIMEOUT_MS = 2000;
const LEAKS = ['ECONNREFUSED', '10.20.30.40', 'hunter2', 'db.internal.example', '08006', 'postgres://', 'SQLSTATE'];

type Q = (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
const isSelect1 = (t: string) => /^\s*select\s+1\s*;?\s*$/i.test(t);
const isCatalog = (t: string) => /pg_proc/i.test(t) && /has_function_privilege/i.test(t);

/** A fake query that records every statement and answers `SELECT 1` and the catalog statement independently. */
function fakeQuery(over: { select1?: () => Promise<any>; catalog?: () => Promise<any> } = {}) {
  const stmts: string[] = [];
  const query: Q = vi.fn(async (text: string) => {
    stmts.push(String(text));
    if (isSelect1(text)) return over.select1 ? over.select1() : { rows: [{ '?column?': 1 }] };
    if (isCatalog(text)) return over.catalog ? over.catalog() : { rows: [{ can_execute: true }] };
    throw new Error(`unexpected statement: ${text}`);
  }) as unknown as Q;
  return { query, stmts };
}
const logSpy = () => {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const mk = (level: string) => (...args: unknown[]) => { calls.push({ level, args }); };
  const log: any = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => log };
  return { log, calls };
};
async function load() {
  vi.resetModules();
  return (await import('../healthChecks.js')) as { createHealthChecks: (o: any) => { db(): Promise<string>; ratelimit(): Promise<string> } };
}
/** Strip single-quoted SQL literals so a function NAME inside a literal is not mistaken for a call. */
const noLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''");

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => { process.off('unhandledRejection', onUnhandled); vi.useRealTimers(); });

describe('db check: SELECT 1 within 2000 ms', () => {
  it('ok when SELECT 1 resolves; the statement is exactly SELECT 1 (no table, no function)', async () => {
    const { createHealthChecks } = await load();
    const { query, stmts } = fakeQuery();
    expect(await createHealthChecks({ query, limiterConfigured: true }).db()).toBe('ok');
    expect(stmts).toHaveLength(1);
    expect(isSelect1(stmts[0]!)).toBe(true);
  });

  it('down when SELECT 1 rejects (error text never escapes the check)', async () => {
    const { createHealthChecks } = await load();
    const { query } = fakeQuery({ select1: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.20.30.40:5432 password=hunter2'), { code: 'ECONNREFUSED' }); } });
    expect(await createHealthChecks({ query, limiterConfigured: true }).db()).toBe('down');
  });

  it('down at 2000 ms when SELECT 1 never resolves (fake timers): still pending at 1999 ms', async () => {
    vi.useFakeTimers();
    const { createHealthChecks } = await load();
    const { query } = fakeQuery({ select1: () => new Promise(() => {}) });
    let out: string | undefined;
    const p = createHealthChecks({ query, limiterConfigured: true }).db().then((s) => { out = s; });
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS - 1);
    expect(out).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(out).toBe('down');
  });

  it('a late rejection of the timed-out query raises no unhandled rejection', async () => {
    vi.useFakeTimers();
    const { createHealthChecks } = await load();
    let reject!: (e: Error) => void;
    const { query } = fakeQuery({ select1: () => new Promise((_, rej) => { reject = rej; }) });
    const p = createHealthChecks({ query, limiterConfigured: true }).db();
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS);
    expect(await p).toBe('down');
    reject(new Error('late failure host=db.internal.example'));
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });

  it('clears its timer: no pending timer after a fast ok and after a fast failure', async () => {
    vi.useFakeTimers();
    const { createHealthChecks } = await load();
    const ok = createHealthChecks({ query: fakeQuery().query, limiterConfigured: true });
    expect(await ok.db()).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    const bad = createHealthChecks({ query: fakeQuery({ select1: async () => { throw new Error('x'); } }).query, limiterConfigured: true });
    expect(await bad.db()).toBe('down');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a query that resolves AFTER the deadline cannot flip the answer back to ok', async () => {
    vi.useFakeTimers();
    const { createHealthChecks } = await load();
    let resolve!: (v: any) => void;
    const { query } = fakeQuery({ select1: () => new Promise((r) => { resolve = r; }) });
    const p = createHealthChecks({ query, limiterConfigured: true }).db();
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS);
    expect(await p).toBe('down');
    resolve({ rows: [{ '?column?': 1 }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toBe('down');
  });
});

describe('ratelimit check: read-only catalog query, never consumes a hit', () => {
  it('ok for a catalog row that says the function exists and EXECUTE is held', async () => {
    const { createHealthChecks } = await load();
    const { query } = fakeQuery({ catalog: async () => ({ rows: [{ can_execute: true }] }) });
    expect(await createHealthChecks({ query, limiterConfigured: true }).ratelimit()).toBe('ok');
  });

  it.each([
    ['no row (function missing)', async () => ({ rows: [] })],
    ['EXECUTE false', async () => ({ rows: [{ can_execute: false }] })],
    ['null privilege', async () => ({ rows: [{ can_execute: null }] })],
    ['a rejected query', async () => { throw Object.assign(new Error('permission denied for schema app'), { code: '42501' }); }],
  ])('down for %s', async (_n, catalog) => {
    const { createHealthChecks } = await load();
    expect(await createHealthChecks({ query: fakeQuery({ catalog }).query, limiterConfigured: true }).ratelimit()).toBe('down');
  });

  it('down when no limiter is configured, even if the catalog says EXECUTE (and no SQL is needed)', async () => {
    const { createHealthChecks } = await load();
    const { query } = fakeQuery();
    expect(await createHealthChecks({ query, limiterConfigured: false }).ratelimit()).toBe('down');
  });

  it('never issues SQL that calls app.ratelimit_hit; the statement is a read-only catalog SELECT (pg_proc + has_function_privilege, schema app)', async () => {
    const { createHealthChecks } = await load();
    const { query, stmts } = fakeQuery();
    const c = createHealthChecks({ query, limiterConfigured: true });
    await c.ratelimit();
    await c.db();
    expect(stmts.length).toBeGreaterThan(0);
    for (const sql of stmts) {
      const bare = noLiterals(sql);
      expect(bare, 'a call to the limiter would consume a hit').not.toMatch(/ratelimit_hit\s*\(/i);
      expect(bare).not.toMatch(/\b(from|join)\s+app\.ratelimit_hit\b/i);
      expect(bare).not.toMatch(/\b(insert|update|delete|truncate|create|alter|drop|grant|revoke|call|perform|set|lock)\b/i);
      expect(bare).not.toMatch(/rate_limit_counters/i);
      expect(sql).toMatch(/^\s*(select|with)\b/i);
    }
    const cat = stmts.find(isCatalog)!;
    expect(cat).toMatch(/\bapp\b/);
    expect(cat).toMatch(/ratelimit_hit/);
  });

  it('down at 2000 ms when the catalog query never resolves, and a late rejection is not unhandled', async () => {
    vi.useFakeTimers();
    const { createHealthChecks } = await load();
    let reject!: (e: Error) => void;
    const { query } = fakeQuery({ catalog: () => new Promise((_, rej) => { reject = rej; }) });
    let out: string | undefined;
    const p = createHealthChecks({ query, limiterConfigured: true }).ratelimit().then((s) => { out = s; });
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS - 1);
    expect(out).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(out).toBe('down');
    reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });
});

describe('concurrent readiness calls share ONE in-flight check per dependency (no result caching)', () => {
  it('two concurrent db() calls run the underlying query once; both get the answer', async () => {
    const { createHealthChecks } = await load();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { query, stmts } = fakeQuery({ select1: async () => { await gate; return { rows: [{}] }; } });
    const c = createHealthChecks({ query, limiterConfigured: true });
    const [a, b, d] = [c.db(), c.db(), c.db()];
    release();
    expect(await Promise.all([a, b, d])).toEqual(['ok', 'ok', 'ok']);
    expect(stmts.filter(isSelect1)).toHaveLength(1);
  });

  it('two concurrent ratelimit() calls run the catalog query once', async () => {
    const { createHealthChecks } = await load();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { query, stmts } = fakeQuery({ catalog: async () => { await gate; return { rows: [{ can_execute: true }] }; } });
    const c = createHealthChecks({ query, limiterConfigured: true });
    const [a, b] = [c.ratelimit(), c.ratelimit()];
    release();
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    expect(stmts.filter(isCatalog)).toHaveLength(1);
  });

  it('db and ratelimit are independent: one in-flight statement each, never merged', async () => {
    const { createHealthChecks } = await load();
    const { query, stmts } = fakeQuery();
    const c = createHealthChecks({ query, limiterConfigured: true });
    await Promise.all([c.db(), c.ratelimit(), c.db(), c.ratelimit()]);
    expect(stmts.filter(isSelect1)).toHaveLength(1);
    expect(stmts.filter(isCatalog)).toHaveLength(1);
  });

  it('finished results are NOT cached: a sequential second call queries again and sees a recovered dependency', async () => {
    const { createHealthChecks } = await load();
    let fail = true;
    const { query, stmts } = fakeQuery({ select1: async () => { if (fail) throw new Error('x'); return { rows: [{}] }; } });
    const c = createHealthChecks({ query, limiterConfigured: true });
    expect(await c.db()).toBe('down');
    fail = false;
    expect(await c.db()).toBe('ok');
    expect(stmts.filter(isSelect1)).toHaveLength(2);
  });

  it('after a timeout the in-flight slot is freed: the next call issues a fresh query', async () => {
    vi.useFakeTimers();
    const { createHealthChecks } = await load();
    let n = 0;
    const { query } = fakeQuery({ select1: () => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ rows: [{}] })) });
    const c = createHealthChecks({ query, limiterConfigured: true });
    const first = c.db();
    await vi.advanceTimersByTimeAsync(DB_TIMEOUT_MS);
    expect(await first).toBe('down');
    expect(await c.db()).toBe('ok');
    expect(n).toBe(2);
  });
});

describe('no error text, host or SQLSTATE detail in the result or the logs', () => {
  it('values are only ok/down; at most one warn per failed check with event health_check_failed; nothing sensitive logged', async () => {
    const { createHealthChecks } = await load();
    const boom = Object.assign(new Error('connect ECONNREFUSED 10.20.30.40:5432 password=hunter2 host=db.internal.example postgres://u:p@h/d'), { code: '08006' });
    const { query } = fakeQuery({ select1: async () => { throw boom; }, catalog: async () => { throw boom; } });
    const { log, calls } = logSpy();
    const c = createHealthChecks({ query, limiterConfigured: true, log });
    const out = await Promise.all([c.db(), c.db(), c.ratelimit()]);
    expect(out).toEqual(['down', 'down', 'down']);
    const blob = JSON.stringify(calls);
    for (const leak of LEAKS) expect(blob, `logged: ${leak}`).not.toContain(leak);
    expect(blob).not.toMatch(/\bstack\b|at \S+ \(/);
    const warns = calls.filter((x) => x.level === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(warns.length, 'one warn per failed dependency check, not per caller').toBeLessThanOrEqual(2);
    expect(calls.filter((x) => x.level === 'error')).toEqual([]);
    for (const w of warns) expect(JSON.stringify(w.args)).toContain('health_check_failed');
    expect(JSON.stringify(warns)).toContain('db');
    expect(JSON.stringify(warns)).toContain('ratelimit');
  });

  it('an ok result logs nothing at warn or above', async () => {
    const { createHealthChecks } = await load();
    const { log, calls } = logSpy();
    const c = createHealthChecks({ query: fakeQuery().query, limiterConfigured: true, log });
    await Promise.all([c.db(), c.ratelimit()]);
    expect(calls.filter((x) => x.level === 'warn' || x.level === 'error')).toEqual([]);
  });
});

// ---------- boot and bootstrap wiring (fake `pg`, no network) ----------
const h = vi.hoisted(() => ({
  stmts: [] as string[],
  pools: 0,
  select1: (() => ({ rows: [{ '?column?': 1 }] })) as () => { rows: any[] } | Error,
  catalog: (() => ({ rows: [{ can_execute: true }] })) as () => { rows: any[] } | Error,
}));
vi.mock('pg', () => {
  const answer = (text: string) => {
    const t = String(text);
    h.stmts.push(t);
    if (/^\s*select\s+1\s*;?\s*$/i.test(t)) { const r = h.select1(); if (r instanceof Error) throw r; return r; }
    if (/pg_proc/i.test(t) && /has_function_privilege/i.test(t)) { const r = h.catalog(); if (r instanceof Error) throw r; return r; }
    return { rows: [] };
  };
  class Pool {
    constructor() { h.pools += 1; }
    on() { return this; }
    async end() {}
    async query(text: string) { return answer(text); }
    async connect() { return { async query(text: string) { return answer(text); }, release() {} }; }
  }
  return { default: { Pool }, Pool };
});

let scratch: string;
let keyFile: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-wire-health-'));
  keyFile = join(scratch, 'ratelimit.key');
  writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 }); // synthetic, not a secret
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => {
  h.stmts.length = 0;
  h.pools = 0;
  h.select1 = () => ({ rows: [{ '?column?': 1 }] });
  h.catalog = () => ({ rows: [{ can_execute: true }] });
});

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };
const DB_URL = 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims';
const cfg = async (withDb: boolean) => {
  const { loadConfig } = await import('../../config.js');
  return loadConfig({
    ...process.env, LIMS_CORE_ENV: 'ci',
    ...(withDb ? { LIMS_CORE_DATABASE_URL: DB_URL, LIMS_CORE_RATELIMIT_KEY_FILE: keyFile } : { LIMS_CORE_DATABASE_URL: '' }),
  } as Record<string, string>);
};
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });
async function bootApp(withDb: boolean, healthChecks?: { db(): Promise<any>; ratelimit(): Promise<any> }) {
  vi.resetModules();
  const { bootstrap } = await import('../../bootstrap.js');
  const app = await bootstrap({
    config: await cfg(withDb), modulesDir: EMPTY_MODULES, logStream: { write() {} },
    ...(healthChecks ? { healthChecks } : {}),
  } as any);
  apps.push(app);
  return app;
}

describe('bootPipeline returns the real health checks (only with a database)', () => {
  it('with a database: healthChecks present; db ok on SELECT 1; ratelimit ok on a catalog row; no ratelimit_hit call; nothing issued at boot', async () => {
    vi.resetModules();
    const { bootPipeline } = await import('../boot.js');
    const boot: any = await bootPipeline({ config: await cfg(true), modules: [], log: quiet as any, metrics: metrics as any });
    expect(boot.healthChecks).toBeTruthy();
    expect(h.stmts, 'boot must not probe the database eagerly').toEqual([]);
    expect(await boot.healthChecks.db()).toBe('ok');
    expect(await boot.healthChecks.ratelimit()).toBe('ok');
    for (const s of h.stmts) expect(noLiterals(s)).not.toMatch(/ratelimit_hit\s*\(/i);
    await boot.close();
  });

  it('with a database but a failing SELECT 1 / missing EXECUTE: db down, ratelimit down (fake pg answers)', async () => {
    vi.resetModules();
    h.select1 = () => new Error('connect ECONNREFUSED 10.20.30.40:5432');
    h.catalog = () => ({ rows: [{ can_execute: false }] });
    const { bootPipeline } = await import('../boot.js');
    const boot: any = await bootPipeline({ config: await cfg(true), modules: [], log: quiet as any, metrics: metrics as any });
    expect(await boot.healthChecks.db()).toBe('down');
    expect(await boot.healthChecks.ratelimit()).toBe('down');
    await boot.close();
  });

  it('without a database: no pool, no SQL, and both checks stay down (fail closed)', async () => {
    vi.resetModules();
    const { bootPipeline } = await import('../boot.js');
    const boot: any = await bootPipeline({ config: await cfg(false), modules: [], log: quiet as any, metrics: metrics as any });
    if (boot.healthChecks) {
      expect(await boot.healthChecks.db()).toBe('down');
      expect(await boot.healthChecks.ratelimit()).toBe('down');
    }
    expect(h.pools).toBe(0);
    expect(h.stmts).toEqual([]);
    await boot.close();
  });
});

describe('GET /v1/core/health/ready through bootstrap', () => {
  it('no database and no opts.healthChecks: 503 { status:"down", checks:{ db:"down", ratelimit:"down" } } (unchanged fail closed)', async () => {
    const app = await bootApp(false);
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'down', checks: { db: 'down', ratelimit: 'down' } });
  });

  it('with a database and no opts.healthChecks: 200 ok/ok from the real checks; body carries only status enums', async () => {
    const app = await bootApp(true);
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', checks: { db: 'ok', ratelimit: 'ok' } });
    expect(Object.keys(r.json()).sort()).toEqual(['checks', 'status']);
    for (const v of [r.json().status, ...Object.values(r.json().checks)]) expect(['ok', 'degraded', 'down']).toContain(v);
    for (const leak of [...LEAKS, 'lims-staging', 'lims_app', 'synthetic']) expect(r.body).not.toContain(leak);
  });

  it('with a database whose SELECT 1 fails: 503 with db down, the error text never reaches the body', async () => {
    h.select1 = () => Object.assign(new Error('connect ECONNREFUSED 10.20.30.40:5432 password=hunter2 host=db.internal.example'), { code: '08006' });
    const app = await bootApp(true);
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'down', checks: { db: 'down', ratelimit: 'ok' } });
    for (const leak of LEAKS) expect(r.body).not.toContain(leak);
  });

  it('with a database but no EXECUTE on app.ratelimit_hit: 503 with ratelimit down', async () => {
    h.catalog = () => ({ rows: [{ can_execute: false }] });
    const app = await bootApp(true);
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'down', checks: { db: 'ok', ratelimit: 'down' } });
  });

  it('opts.healthChecks still wins over the real checks (even with a database): the real SELECT 1 is never issued', async () => {
    const injected = { db: vi.fn(async () => 'degraded' as const), ratelimit: vi.fn(async () => 'ok' as const) };
    const app = await bootApp(true, injected);
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.json()).toEqual({ status: 'degraded', checks: { db: 'degraded', ratelimit: 'ok' } });
    expect(injected.db).toHaveBeenCalledTimes(1);
    expect(h.stmts.filter((s) => /^\s*select\s+1\s*;?\s*$/i.test(s))).toEqual([]);
    expect(h.stmts.filter((s) => /pg_proc/i.test(s))).toEqual([]);
  });
});
