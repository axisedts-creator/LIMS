// T0B-PERF-1 (LD-310) done_when 3: the per request database query counter.
// INTERFACE EXPECTED (the spec fixes behaviour, not names; the writer may dispute a name in .orchestra/notes/T0B-PERF-1-dispute-*.md):
//   core/observability/request-stats.ts
//     createRequestStats(): { recordQuery(ms: number): void; snapshot(): { count: number; ms: number } }
//     withRequestStats<T>(stats, fn: () => T): T       AsyncLocalStorage scope; every await inside fn sees the same stats
//     currentRequestStats(): RequestStats | undefined  undefined outside a request
//   core/db/tx.ts  tx.query records one query (its wall ms) into currentRequestStats() for each statement the HANDLER issues;
//                  BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE and the context set_config are plumbing and are NOT counted.
//   HTTP layer     opens one stats scope per request; Server-Timing `db;dur=` and the request log `db_count` / `db_ms` read it.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db/tx.js';
import { createFakePgBouncer, recorder, txInput } from '../db/__tests__/helpers.js';
import { createRequestStats, currentRequestStats, withRequestStats } from '../observability/request-stats.js';
import { FIXTURES, SHARED_ROOT } from './helpers.js';
import { analyzeStatements, expectListBudget } from './query-budget.helpers.js';

const mkDb = (fake = createFakePgBouncer(2)) => {
  const rec = recorder();
  return { fake, db: createDb({ pool: fake.pool, log: rec.log as any, metrics: rec.metrics as any, sleep: async () => undefined, random: () => 0 } as any) };
};

describe('request-stats (unit)', () => {
  it('counts and sums what is recorded', () => {
    const s = createRequestStats();
    s.recordQuery(3); s.recordQuery(4.5);
    expect(s.snapshot()).toEqual({ count: 2, ms: 7.5 });
  });
  it('is scoped: visible through awaits inside withRequestStats, undefined outside, isolated between concurrent requests', async () => {
    expect(currentRequestStats()).toBeUndefined();
    const run = (n: number) => withRequestStats(createRequestStats(), async () => {
      for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 1)); currentRequestStats()!.recordQuery(1); }
      return currentRequestStats()!.snapshot().count;
    });
    expect(await Promise.all([run(2), run(5), run(1)])).toEqual([2, 5, 1]);
    expect(currentRequestStats()).toBeUndefined();
  });
  it('rejects nonsense input without poisoning the totals (negative, NaN)', () => {
    const s = createRequestStats();
    s.recordQuery(-5); s.recordQuery(Number.NaN); s.recordQuery(2);
    const v = s.snapshot();
    expect(v.ms).toBe(2);
    expect(Number.isFinite(v.ms)).toBe(true);
  });
});

describe('tx.query feeds the request counter', () => {
  it('counts exactly the statements the handler issued, not BEGIN / set_config / COMMIT', async () => {
    const { db, fake } = mkDb();
    const stats = createRequestStats();
    await withRequestStats(stats, () => db.requestTx(txInput() as any, async (tx) => {
      await tx.query('SELECT 1 FROM catalog.tests WHERE tenant_id = $1', ['t']);
      await tx.query('SELECT 2 FROM catalog.units WHERE tenant_id = $1', ['t']);
    }));
    expect(stats.snapshot().count).toBe(2);
    expect(stats.snapshot().ms).toBeGreaterThanOrEqual(0);
    expect(fake.texts().length).toBeGreaterThan(2); // BEGIN, set_config, the two, COMMIT: the counter is not the raw statement log
  });

  it('a savepoint does not add counted statements; a failing statement still counts once', async () => {
    const { db, fake } = mkDb();
    fake.inject(/FROM catalog\.boom/, () => Object.assign(new Error('x'), { code: '23505' }));
    const stats = createRequestStats();
    await withRequestStats(stats, async () => {
      await db.requestTx(txInput() as any, async (tx) => {
        await tx.savepoint(async (t) => { await t.query('SELECT 1 FROM catalog.a'); });
        await tx.savepoint(async (t) => { await t.query('SELECT 1 FROM catalog.boom'); }).catch(() => undefined);
      }).catch(() => undefined);
    });
    expect(stats.snapshot().count).toBe(2);
  });

  it('no stats scope open (a worker, a test): queries run and nothing throws', async () => {
    const { db } = mkDb();
    await expect(db.requestTx(txInput() as any, async (tx) => (await tx.query('SELECT 1')).rows.length)).resolves.toBe(1);
  });

  it('the budget helper reads the same fake server log: an empty list of 3 queries passes, a per row loop fails', async () => {
    const { db, fake } = mkDb();
    await db.requestTx(txInput() as any, async (tx) => {
      for (const t of ['a', 'b', 'c']) await tx.query(`SELECT 1 FROM catalog.${t} WHERE tenant_id = $1`, ['t']);
    });
    expect(() => expectListBudget(fake.texts())).not.toThrow();
    const { db: db2, fake: fake2 } = mkDb();
    await db2.requestTx(txInput() as any, async (tx) => {
      for (let i = 0; i < 6; i++) await tx.query('SELECT * FROM catalog.analytes WHERE id = $1', [`id${i}`]);
    });
    expect(analyzeStatements(fake2.texts()).count).toBe(6);
    expect(() => expectListBudget(fake2.texts(), { label: 'listAnalytes' })).toThrow(/6 queries|N\+1/);
  });
});

describe('the counter reaches Server-Timing and the request log over HTTP', () => {
  const logs: string[] = [];
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await bootstrap({
      config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOG_LEVEL: 'info' }), repoRoot: SHARED_ROOT, modulesDir: join(FIXTURES, 'perf-db'),
      logStream: { write: (l: string) => { logs.push(l); } },
    } as any);
  });
  afterAll(async () => { await app?.close(); });

  it('a handler that ran 3 queries (12 + 8 + 5 ms) shows db;dur=25 and db_count 3 / db_ms 25', async () => {
    logs.length = 0;
    const r = await app.inject({ method: 'GET', url: '/v1/catalog/things' });
    expect(r.statusCode).toBe(200);
    expect(Number(/db;dur=([\d.]+)/.exec(String(r.headers['server-timing']))![1])).toBe(25);
    const l = logs.join('').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((o) => o.msg === 'request');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ db_count: 3, db_ms: 25 });
  });

  it('the next request starts from zero (no leak between requests, also under concurrency)', async () => {
    const rs = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/catalog/things' }),
      app.inject({ method: 'GET', url: '/v1/catalog/things/t1' }),
      app.inject({ method: 'GET', url: '/v1/catalog/things' }),
    ]);
    const db = rs.map((r) => Number(/db;dur=([\d.]+)/.exec(String(r.headers['server-timing']))![1]));
    expect(db).toEqual([25, 0, 25]);
  });
});
