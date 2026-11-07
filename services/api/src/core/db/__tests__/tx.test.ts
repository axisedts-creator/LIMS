// T0D-03 — request transaction opening, savepoints, cleanup (02-TRD §6.4, REQ-SEC-013, SP-9 SQL shape).
// Expected API (core/db/tx.ts):
//   createDb({ pool, log?, metrics?, retryMax?=3, sleep?, random?, statementTimeoutMs?=5000, lockTimeoutMs?=3000,
//              identityAuthOps?, withTenantScopeOps?, identitySystemActorId? })
//     -> { requestTx(input, fn), identityAuthTx(input, fn), withTenantScope(tx, tenantId, fn) }
//   input = { claims: DbClaims, requestId, clientIp, userAgent, operation: { module, operationId, context }, statementTimeoutMs?, lockTimeoutMs? }
//   fn(tx, ctl) -> Promise<T>;  tx = { query(text, values?) -> { rows }, startedAt: Date, savepoint(fn), operation };  ctl = { noRetry() }
//   `pool` is the pg-Pool shape the module owns: connect() -> { query(text, values), release() }.
//   requestTx resolves with fn's value; DB errors reject mapped (core/db/sqlstate.ts: .code/.statusCode); other errors pass through.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb } from '../tx.js';
import { NOW, REQ_ID, SUB, TENANT_A, createFakePgBouncer, pgError, recorder, rejection, txInput } from './helpers.js';

const mk = (servers = 1) => {
  const fake = createFakePgBouncer(servers);
  return { fake, db: createDb({ pool: fake.pool, sleep: async () => {}, random: () => 0 } as any) as any };
};

describe('requestTx opening (02-TRD §6.4)', () => {
  it('BEGIN, then ONE set_config statement with the six context values as bind parameters, then the handler, then COMMIT', async () => {
    const { fake, db } = mk();
    const out = await db.requestTx(txInput(), async (tx: any) => (await tx.query('SELECT handler_work')).rows[0]);
    expect(out).toEqual({ ok: true });
    const t = fake.texts();
    expect(t[0]).toMatch(/^BEGIN/i);
    expect(t[1]).toMatch(/set_config\(\s*'request\.jwt\.claims'/i);
    for (const k of ['app.request_id', 'app.client_ip', 'app.user_agent', 'statement_timeout', 'lock_timeout']) expect(t[1]).toContain(`'${k}'`);
    expect(t[1]).toMatch(/tx_started_at/i);
    expect(t.filter((x) => /set_config/i.test(x))).toHaveLength(1);
    expect(t[2]).toBe('SELECT handler_work');
    expect(t[t.length - 1]).toMatch(/^COMMIT/i);
    const v = fake.log[1].values.map(String);
    expect(JSON.parse(v[0])).toEqual({ sub: SUB, tenant_id: TENANT_A, actor_type: 'user' });
    expect(v.slice(1)).toEqual([REQ_ID, '203.0.113.9', 'vitest', '5000', '3000']);
  });

  it('every set_config is transaction-local (is_local = true) and nothing uses SET / SET ROLE / session scope', async () => {
    const { fake, db } = mk();
    await db.requestTx(txInput(), async () => 1);
    const opening = fake.texts().find((x) => /set_config/i.test(x))!;
    const calls = opening.match(/set_config\([^)]*\)/gi)!;
    expect(calls).toHaveLength(6);
    for (const c of calls) expect(c, c).toMatch(/,\s*true\s*\)$/i);
    expect(fake.texts().filter((x) => /^\s*(SET|RESET)\b/i.test(x))).toEqual([]);
  });

  it('tx.startedAt is the database transaction time (tx_started_at), used as event occurred_at', async () => {
    const { db } = mk();
    const startedAt = await db.requestTx(txInput(), async (tx: any) => tx.startedAt);
    expect(new Date(startedAt).getTime()).toBe(NOW.getTime());
  });

  it('timeouts default to 5000/3000 ms and can be overridden per call (worker task options)', async () => {
    const { fake, db } = mk();
    await db.requestTx(txInput({ statementTimeoutMs: 300000, lockTimeoutMs: 1000 }), async () => 1);
    expect(fake.log[1].values.slice(4).map(String)).toEqual(['300000', '1000']);
  });

  it('user agent is truncated to 512 chars', async () => {
    const { fake, db } = mk();
    await db.requestTx(txInput({ userAgent: 'x'.repeat(5000) }), async () => 1);
    expect(String(fake.log[1].values[3])).toHaveLength(512);
  });

  it('claims are bound as a parameter, never interpolated into SQL (injection via a claim value)', async () => {
    const { fake, db } = mk();
    const evil = "x'); DROP TABLE core.tenants; --";
    await db.requestTx(txInput({ claims: { sub: SUB, actor_type: 'user', support_scope: evil }, userAgent: evil, requestId: evil }), async () => 1);
    for (const s of fake.log) expect(s.text).not.toContain('DROP TABLE');
    expect(String(fake.log[1].values[0])).toContain('DROP TABLE'); // value travels as data
  });

  it('commits on success, releases the connection exactly once, and leaves no transaction open', async () => {
    const { fake, db } = mk();
    await db.requestTx(txInput(), async () => 1);
    expect(fake.state.connects).toBe(1);
    expect(fake.state.releases).toBe(1);
    expect(fake.state.releasedInTx).toBe(0);
    expect(fake.servers[0].inTx).toBe(false);
  });

  it('a handler error rolls back, releases the connection, and rejects with the handler error', async () => {
    const { fake, db } = mk();
    const boom = new Error('handler bug');
    const e = await rejection(db.requestTx(txInput(), async () => { throw boom; }));
    expect(e).toBe(boom);
    expect(fake.texts()).toContain('ROLLBACK');
    expect(fake.texts().some((x) => /^COMMIT/i.test(x))).toBe(false);
    expect(fake.state.releases).toBe(1);
    expect(fake.state.releasedInTx).toBe(0);
  });

  it('a DB error rejects mapped (AC-0D-3.2): P0001 immutable_row -> 409 common.immutable_record', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE locked/, () => pgError('P0001', 'immutable_row'));
    const e = await rejection(db.requestTx(txInput(), (tx: any) => tx.query('UPDATE locked SET x = 1')));
    expect(e).toMatchObject({ code: 'common.immutable_record', statusCode: 409 });
    expect(fake.texts()).toContain('ROLLBACK');
  });

  it('42501 -> 404 and 23503 -> 404 through requestTx; lims_rls_denied_total counted once', async () => {
    const r = recorder();
    const fake = createFakePgBouncer();
    const db = createDb({ pool: fake.pool, log: r.log, metrics: r.metrics, sleep: async () => {}, random: () => 0 } as any) as any;
    fake.inject(/INSERT rls/, () => pgError('42501'));
    fake.inject(/INSERT fk/, () => pgError('23503'));
    expect(await rejection(db.requestTx(txInput(), (tx: any) => tx.query('INSERT rls')))).toMatchObject({ code: 'common.not_found', statusCode: 404 });
    expect(await rejection(db.requestTx(txInput(), (tx: any) => tx.query('INSERT fk')))).toMatchObject({ code: 'common.not_found', statusCode: 404 });
    expect(r.metrics.counts.get('lims_rls_denied_total')).toBe(1);
  });

  it('a module may catch the raw DB error inside the handler and re-map it first', async () => {
    const { fake, db } = mk();
    fake.inject(/INSERT counter/, () => pgError('55P03', 'lock timeout'));
    const e = await rejection(db.requestTx(txInput(), async (tx: any) => {
      try {
        await tx.savepoint((s: any) => s.query('INSERT counter'));
      } catch (err: any) {
        expect(err.code).toBe('55P03'); // handler sees the raw SQLSTATE
        throw Object.assign(new Error('billing.counter_busy'), { code: 'billing.counter_busy', statusCode: 409 });
      }
    }));
    expect(e).toMatchObject({ code: 'billing.counter_busy', statusCode: 409 });
  });

  it('pool.connect() failure rejects 503 common.dependency_unavailable and opens nothing', async () => {
    const { fake, db } = mk();
    fake.state.failConnect = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const e = await rejection(db.requestTx(txInput(), async () => 1));
    expect(e).toMatchObject({ code: 'common.dependency_unavailable', statusCode: 503 });
    expect(fake.log).toHaveLength(0);
  });

  it('ctx.db.tx(fn): SAVEPOINT s<n> / RELEASE; a failing inner fn does ROLLBACK TO and the outer tx still commits when the caller catches', async () => {
    const { fake, db } = mk();
    fake.inject(/INSERT inner_bad/, () => pgError('23505', 'dup', { constraint: 'c' }));
    await db.requestTx(txInput(), async (tx: any) => {
      await tx.savepoint((s: any) => s.query('SELECT inner_ok'));
      await tx.savepoint((s: any) => s.query('INSERT inner_bad')).catch(() => undefined);
      await tx.query('SELECT after');
    });
    const t = fake.texts();
    expect(t.filter((x) => /^SAVEPOINT s\d+$/i.test(x))).toHaveLength(2);
    const names = t.filter((x) => /^SAVEPOINT/i.test(x)).map((x) => x.split(/\s+/)[1]);
    expect(new Set(names).size).toBe(2); // distinct savepoint names
    expect(t).toContain(`RELEASE SAVEPOINT ${names[0]}`);
    expect(t).toContain(`ROLLBACK TO SAVEPOINT ${names[1]}`);
    expect(t).toContain('SELECT after');
    expect(t[t.length - 1]).toMatch(/^COMMIT/i);
  });

  it('nested savepoints use distinct names', async () => {
    const { fake, db } = mk();
    await db.requestTx(txInput(), (tx: any) => tx.savepoint((a: any) => a.savepoint((b: any) => b.query('SELECT deep'))));
    const names = fake.texts().filter((x) => /^SAVEPOINT/i.test(x)).map((x) => x.split(/\s+/)[1]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe('source rules for core/db (REQ-SEC bare-SET ban, pool is module-private)', () => {
  const dbDir = join(import.meta.dirname, '..');
  const srcDir = join(dbDir, '..', '..');
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (n === '__tests__' || n === 'node_modules') return [];
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('core/db has tx.ts, sqlstate.ts and no bare SET [LOCAL] ROLE / SET SESSION / set_config(..., false)', () => {
    const files = walk(dbDir);
    expect(files.map((f) => f.slice(dbDir.length + 1))).toEqual(expect.arrayContaining(['tx.ts', 'sqlstate.ts']));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\bSET\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i);
      expect(src, f).not.toMatch(/\bSET\s+SESSION\b/i);
      expect(src, f).not.toMatch(/set_config\([^)]*,\s*false\s*\)/i);
    }
  });

  it("no file outside core/db imports 'pg' (the pool never reaches modules, CV §5.10)", () => {
    for (const f of walk(srcDir).filter((x) => !x.startsWith(dbDir))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from\s+['"]pg['"]|require\(['"]pg['"]\)/);
    }
  });
});
