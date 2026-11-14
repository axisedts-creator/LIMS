// WIRE-DB / LD-189 (C1, AUTH-SENSITIVE): boot hands the identity claims resolver ONLY identityAuthTx, bound after the pool exists,
// with the identity system actor read lazily from core.g_system_actors. Behaviour-only: boots bootPipeline over a fake `pg` module
// with the REAL identity manifest (no names of the writer's wiring are assumed). No network, synthetic ids only.
// AC-0D-2.6, C0 02-TRD s6.4 (claims { sub: <identity system actor>, actor_type: 'system' }), 08 A25 D-212 / R10, CR-C2-020.
//
// ASSUMED (documented, disputable in .orchestra/notes/WIRE-DB-dispute-*.md):
//  - the lookup is ONE statement over core.g_system_actors that names module 'identity' (literal or bind value) and is_active, and
//    the id comes back as column `actor_id` (precedent: services/worker/src/core/bootstrap.ts: SELECT module, actor_id ...);
//  - it runs through the pool (pool.query or a pooled client), never at boot and never from env / JWT / request;
//  - the resolver object in the manifest is the SAME object before and after bootPipeline (core/bootstrap.ts reads it first);
//  - errors are LimsError common.internal, compared by `.code` here because vi.resetModules() gives every test a fresh LimsError class.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ID, jwt, req, tenantRow } from '../../../modules/identity/claims/__tests__/helpers.js';

const ACTOR = '0190a000-0000-7000-8000-00000000a5a5';
const OTHER = '0190a000-0000-7000-8000-00000000a6a6';

type Stmt = { via: 'pool' | 'client'; text: string; values: unknown[] };
const h = vi.hoisted(() => ({
  stmts: [] as Array<{ via: 'pool' | 'client'; text: string; values: unknown[] }>,
  pools: 0,
  unreachable: false,
  /** answer for the g_system_actors lookup: rows, or an Error to throw */
  actors: (() => ({ rows: [] })) as () => { rows: any[] } | Error,
  session: undefined as Record<string, unknown> | undefined,
}));

vi.mock('pg', () => {
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432 secret-host-detail'), { code: 'ECONNREFUSED' });
  const handle = (via: 'pool' | 'client', text: string, values: unknown[] = []) => {
    h.stmts.push({ via, text: String(text), values });
    const t = String(text).trim();
    if (/g_system_actors/i.test(t)) { const r = h.actors(); if (r instanceof Error) throw r; return r; }
    if (/set_config\(\s*'request\.jwt\.claims'/i.test(t) && /tx_started_at/i.test(t)) return { rows: [{ tx_started_at: new Date() }] };
    if (/identity_resolve_session/i.test(t)) return { rows: h.session ? [h.session] : [] };
    return { rows: [] };
  };
  class Pool {
    constructor() { h.pools += 1; }
    on() { return this; }
    async end() {}
    async query(text: string, values?: unknown[]) { if (h.unreachable) throw refused(); return handle('pool', text, values); }
    async connect() {
      if (h.unreachable) throw refused();
      return { async query(text: string, values?: unknown[]) { return handle('client', text, values); }, release() {} };
    }
  }
  return { default: { Pool }, Pool };
});

let scratch: string;
let keyFile: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-identity-db-handoff-'));
  keyFile = join(scratch, 'ratelimit.key');
  writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 }); // synthetic, not a secret
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const future = (m: number) => new Date(Date.now() + m * 60_000);
beforeEach(() => {
  h.stmts.length = 0;
  h.pools = 0;
  h.unreachable = false;
  h.actors = () => ({ rows: [{ module: 'identity', actor_id: ACTOR }] });
  h.session = tenantRow({ idle_expires_at: future(15), absolute_expires_at: future(600) });
});

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };

interface Boot { manifest: any; deps: Array<{ name: string; deps: any }>; boot: any; before: unknown }
/** Fresh module registry per call: identity's late binding is process-level state, every test starts unbound. */
async function load(envOver: Record<string, string | undefined> = {}, withDb = true): Promise<{ fresh: () => Promise<Boot>; manifest: any; before: unknown }> {
  vi.resetModules();
  const { loadConfig } = await import('../../config.js');
  const { bootPipeline } = await import('../boot.js');
  const { manifest } = await import('../../../modules/identity/index.js');
  const config = loadConfig({
    ...process.env,
    ...(withDb ? { LIMS_CORE_DATABASE_URL: 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims', LIMS_CORE_RATELIMIT_KEY_FILE: keyFile } : { LIMS_CORE_DATABASE_URL: '' }),
    ...envOver,
  } as Record<string, string>);
  const before = manifest.claimsResolver;
  const deps: Boot['deps'] = [];
  const other = (name: string) => ({
    manifest: { name, openapi: `contracts/openapi/${name}.yaml`, handlers: {}, produces: [], createServices(d: unknown) { deps.push({ name, deps: d }); return Object.freeze({}); } },
    spec: {},
  });
  return {
    manifest, before,
    fresh: async () => {
      const boot = await bootPipeline({ config, modules: [{ manifest, spec: {} }, other('catalog'), other('frontdesk')] as any, log: quiet as any, metrics: metrics as any });
      return { manifest, deps, boot, before };
    },
  };
}

const resolve = (manifest: any, over: Record<string, unknown> = {}) => manifest.claimsResolver.resolve(jwt(over), req());
async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected a rejection, but it resolved');
}
const expectInternal = (e: any, ...secrets: string[]) => {
  expect(e?.code).toBe('common.internal');
  const blob = `${e.message} ${e.detail ?? ''} ${JSON.stringify(e)}`;
  for (const s of secrets) expect(blob, 'error must not leak this value').not.toContain(s);
};
const lookups = (): Stmt[] => h.stmts.filter((s) => /g_system_actors/i.test(s.text));
const txSql = (): Stmt[] => h.stmts.filter((s) => /^(BEGIN|COMMIT|ROLLBACK)\b|set_config|identity_resolve_session/i.test(s.text.trim()));
const openingClaims = (): Array<Record<string, unknown>> =>
  h.stmts.filter((s) => /set_config\(\s*'request\.jwt\.claims'/i.test(s.text)).map((s) => JSON.parse(String(s.values[0])));

describe('before the pool exists / without a database (boot must stay as it is today)', () => {
  it('an unbound resolver rejects common.internal, opens no pool, issues no SQL', async () => {
    const { manifest } = await load();
    expectInternal(await rejection(resolve(manifest)));
    expect(h.pools).toBe(0);
    expect(h.stmts).toEqual([]);
  });

  it('boot WITHOUT LIMS_CORE_DATABASE_URL still succeeds; the resolver still rejects common.internal; no pool', async () => {
    const l = await load({}, false);
    const b = await l.fresh();
    expect(b.boot.pipelineFor('identity')).toBeDefined();
    expectInternal(await rejection(resolve(l.manifest)));
    expect(h.pools).toBe(0);
    expect(h.stmts).toEqual([]);
    await b.boot.close();
  });

  it('boot with an UNREACHABLE database still succeeds and reads nothing; the first login then fails closed without leaking driver text', async () => {
    h.unreachable = true;
    const l = await load();
    const b = await l.fresh();
    expect(h.stmts, 'the actor must not be read at boot').toEqual([]);
    const e = await rejection(resolve(l.manifest));
    expectInternal(e, 'ECONNREFUSED', '10.0.0.9', 'secret-host-detail');
    expect(txSql()).toEqual([]);
    h.unreachable = false; // database comes back: the next login works (failure was not cached)
    const out = await resolve(l.manifest);
    expect(out.kind).toBe('tenant');
    await b.boot.close();
  });
});

describe('after boot with a reachable database: lazy, memoised identity system actor', () => {
  it('boot reads nothing from the database (no g_system_actors read, no transaction) and keeps the same resolver object', async () => {
    const l = await load();
    const b = await l.fresh();
    expect(h.pools).toBe(1);
    expect(lookups()).toEqual([]);
    expect(txSql()).toEqual([]);
    expect(l.manifest.claimsResolver, 'core/bootstrap.ts takes the resolver before bootPipeline: it must be late-bound, not replaced').toBe(b.before);
    await b.boot.close();
  });

  it('first login: ONE SELECT on core.g_system_actors (identity, is_active), then a transaction whose claims are exactly { sub, actor_type: "system" }', async () => {
    const l = await load();
    const b = await l.fresh();
    const out = await resolve(l.manifest);
    expect(out.kind).toBe('tenant');

    const q = lookups();
    expect(q).toHaveLength(1);
    expect(q[0]!.text).toMatch(/\bFROM\s+core\.g_system_actors\b/i);
    expect(q[0]!.text).toMatch(/\bis_active\b/i);
    expect(`${q[0]!.text} ${JSON.stringify(q[0]!.values)}`, "module 'identity' must be named (literal or bind value)").toMatch(/identity/);
    expect(q[0]!.text, 'the actor id is read, never written or taken from the request').not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);

    const [claims, ...rest] = openingClaims();
    expect(rest).toEqual([]);
    expect(claims).toEqual({ sub: ACTOR, actor_type: 'system' });
    expect(claims).not.toHaveProperty('tenant_id');
    expect(claims!.sub, 'never the caller jwt.sub').not.toBe(jwt().sub);
    expect(h.stmts.findIndex((s) => /g_system_actors/i.test(s.text)), 'the actor is known before the transaction opens').toBeLessThan(h.stmts.findIndex((s) => /^BEGIN/i.test(s.text.trim())));
    await b.boot.close();
  });

  it('a second and third login do not query g_system_actors again and open with the same claims', async () => {
    const l = await load();
    const b = await l.fresh();
    await resolve(l.manifest);
    await resolve(l.manifest, { sub: ID.tenant });
    await resolve(l.manifest);
    expect(lookups()).toHaveLength(1);
    expect(openingClaims()).toEqual(Array(3).fill({ sub: ACTOR, actor_type: 'system' }));
    await b.boot.close();
  });

  it('concurrent first logins all authenticate with the same actor (no half-bound state)', async () => {
    const l = await load();
    const b = await l.fresh();
    const outs = await Promise.all([1, 2, 3, 4].map(() => resolve(l.manifest)));
    expect(outs.every((o: any) => o.kind === 'tenant')).toBe(true);
    expect(new Set(openingClaims().map((c) => c.sub))).toEqual(new Set([ACTOR]));
    expect(lookups().length).toBeGreaterThanOrEqual(1);
    await b.boot.close();
  });

  it('the actor id comes from the table only: the DB value wins over any env or request value (changing the row before first use changes the claims)', async () => {
    h.actors = () => ({ rows: [{ module: 'identity', actor_id: OTHER }] });
    const l = await load({ LIMS_CORE_IDENTITY_SYSTEM_ACTOR_ID: ACTOR, LIMS_IDENTITY_SYSTEM_ACTOR_ID: ACTOR });
    const b = await l.fresh();
    await resolve(l.manifest);
    expect(openingClaims()).toEqual([{ sub: OTHER, actor_type: 'system' }]);
    await b.boot.close();
  });
});

describe('fail closed (common.internal, no id in the message, failures are not cached, the next call retries)', () => {
  it('a query error: login rejected, no transaction opened, no driver text, the next login retries and succeeds', async () => {
    let n = 0;
    h.actors = () => (n++ === 0 ? Object.assign(new Error(`permission denied for table g_system_actors ${ACTOR}`), { code: '42501' }) : { rows: [{ module: 'identity', actor_id: ACTOR }] });
    const l = await load();
    const b = await l.fresh();
    const e = await rejection(resolve(l.manifest));
    expectInternal(e, ACTOR, 'permission denied', '42501', 'g_system_actors');
    expect(txSql(), 'no transaction without an actor').toEqual([]);
    expect((await resolve(l.manifest)).kind).toBe('tenant');
    expect(lookups()).toHaveLength(2);
    expect(openingClaims()).toEqual([{ sub: ACTOR, actor_type: 'system' }]);
    await b.boot.close();
  });

  it('a missing / inactive identity row (no rows): rejected, nothing opened, retried next time', async () => {
    let n = 0;
    h.actors = () => (n++ === 0 ? { rows: [] } : { rows: [{ module: 'identity', actor_id: ACTOR }] });
    const l = await load();
    const b = await l.fresh();
    expectInternal(await rejection(resolve(l.manifest)));
    expect(txSql()).toEqual([]);
    expect((await resolve(l.manifest)).kind).toBe('tenant');
    expect(lookups()).toHaveLength(2);
    await b.boot.close();
  });

  it('a row with a NULL actor_id: rejected', async () => {
    h.actors = () => ({ rows: [{ module: 'identity', actor_id: null }] });
    const l = await load();
    const b = await l.fresh();
    expectInternal(await rejection(resolve(l.manifest)));
    expect(txSql()).toEqual([]);
    await b.boot.close();
  });

  it.each([
    ['plain text', 'not-a-uuid-secret-value'],
    ['a uuid with a SQL tail', `${ACTOR}'; DROP TABLE core.g_system_actors; --`],
    ['a uuid with a suffix', `${ACTOR}00`],
    ['a number', 42],
  ])('a non-UUID value (%s): rejected, the value is not in the message, nothing opened, retried next time', async (_n, bad) => {
    let n = 0;
    h.actors = () => (n++ === 0 ? { rows: [{ module: 'identity', actor_id: bad }] } : { rows: [{ module: 'identity', actor_id: ACTOR }] });
    const l = await load();
    const b = await l.fresh();
    expectInternal(await rejection(resolve(l.manifest)), String(bad), 'DROP TABLE');
    expect(txSql()).toEqual([]);
    expect((await resolve(l.manifest)).kind).toBe('tenant');
    expect(openingClaims()).toEqual([{ sub: ACTOR, actor_type: 'system' }]);
    await b.boot.close();
  });
});

describe('least privilege: no other module receives the pool or any db method', () => {
  const FORBIDDEN = ['db', 'pool', 'pg', 'requestTx', 'withTenantScope', 'anonymousTx', 'identityAuthTx', 'connect', 'query'];
  const walk = (o: unknown, depth = 0, path = 'deps'): string[] => {
    if (!o || typeof o !== 'object' || depth > 3) return [];
    return Object.keys(o).flatMap((k) => [...(FORBIDDEN.includes(k) ? [`${path}.${k}`] : []), ...walk((o as any)[k], depth + 1, `${path}.${k}`)]);
  };

  it('createServices deps of every other module carry only env, log and metrics (no db, pool, requestTx, withTenantScope, anonymousTx, identityAuthTx)', async () => {
    const l = await load();
    const b = await l.fresh();
    const others = b.deps.filter((d) => d.name !== 'identity');
    expect(others.map((d) => d.name).sort()).toEqual(['catalog', 'frontdesk']);
    for (const d of others) {
      expect(Object.keys(d.deps).sort(), `${d.name} deps`).toEqual(['env', 'log', 'metrics']);
      expect(walk(d.deps), `${d.name} deps expose a db member`).toEqual([]);
    }
    await b.boot.close();
  });

  it('boot never hands a db to modules before or after the first login, and the first login opens no pooled access for them', async () => {
    const l = await load();
    const b = await l.fresh();
    await resolve(l.manifest);
    for (const d of b.deps.filter((x) => x.name !== 'identity')) expect(walk(d.deps)).toEqual([]);
    await b.boot.close();
  });
});

describe('allowlists and authorization outcomes are unchanged', () => {
  it('with resolveSession removed from LIMS_CORE_IDENTITY_AUTH_OPS the login is refused common.internal and no transaction SQL runs', async () => {
    const l = await load({ LIMS_CORE_IDENTITY_AUTH_OPS: 'loginStaff' });
    const b = await l.fresh();
    expectInternal(await rejection(resolve(l.manifest)));
    expect(txSql(), 'refused before any BEGIN / set_config / DEFINER call').toEqual([]);
    expect(openingClaims()).toEqual([]);
    await b.boot.close();
  });

  it('the resolver outcome is still decided by the DEFINER row: no row -> auth.unauthenticated; expired session -> auth.session_expired', async () => {
    const l = await load();
    const b = await l.fresh();
    h.session = undefined;
    expect(await resolve(l.manifest)).toEqual({ kind: 'rejected', code: 'auth.unauthenticated' });
    h.session = tenantRow({ idle_expires_at: future(-1), absolute_expires_at: future(600) });
    expect(await resolve(l.manifest)).toEqual({ kind: 'rejected', code: 'auth.session_expired' });
    await b.boot.close();
  });

  it('a malformed jwt is rejected before any database access (no lookup, no pool query)', async () => {
    const l = await load();
    const b = await l.fresh();
    expect(await resolve(l.manifest, { sub: 'not-a-uuid' })).toEqual({ kind: 'rejected', code: 'auth.unauthenticated' });
    expect(h.stmts).toEqual([]);
    await b.boot.close();
  });
});
