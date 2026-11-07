// T0D-03 — whole-request retry on 40001 / 40P01 and ctx.noRetry() (02-TRD §6.4). AC-0D-2.7, AC-0D-3.2 (40001 row), R-8 sibling.
// Expected API: as in tx.test.ts. createDb({ retryMax?=3 (LIMS_CORE_TX_RETRY_MAX), sleep(ms), random() in [0,1) }) — jitter = 10 + random()*40 ms.
// fn(tx, ctl): ctl.noRetry() disables the retry for this request only (ctx.noRetry() is wired to it).
import { describe, expect, it } from 'vitest';
import { createDb } from '../tx.js';
import { createFakePgBouncer, pgError, rejection, retryKnobs, txInput } from './helpers.js';

const mk = (over: Record<string, unknown> = {}, randoms: number[] = [0]) => {
  const fake = createFakePgBouncer(1);
  const k = retryKnobs(randoms);
  const db = createDb({ pool: fake.pool, sleep: k.sleep, random: k.random, ...over } as any) as any;
  return { fake, k, db };
};
const begins = (fake: ReturnType<typeof createFakePgBouncer>) => fake.texts().filter((t) => /^BEGIN/i.test(t)).length;

describe.each(['40001', '40P01'])('retry on SQLSTATE %s', (code) => {
  it('two failures then success: handler runs 3 times in 3 fresh transactions, result returned', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE hot/, () => pgError(code), 2);
    let runs = 0;
    const out = await db.requestTx(txInput(), async (tx: any) => { runs += 1; await tx.query('UPDATE hot SET n = n + 1'); return 'done'; });
    expect(out).toBe('done');
    expect(runs).toBe(3);
    expect(begins(fake)).toBe(3);
    expect(fake.texts().filter((t) => t === 'ROLLBACK')).toHaveLength(2);
    expect(fake.texts().filter((t) => /^COMMIT/i.test(t))).toHaveLength(1);
    expect(fake.state.releasedInTx).toBe(0);
  });

  it('every attempt re-sets the full context (claims etc.) in its own transaction', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE hot/, () => pgError(code), 1);
    await db.requestTx(txInput(), (tx: any) => tx.query('UPDATE hot SET n = 1'));
    expect(fake.texts().filter((t) => /set_config\(\s*'request\.jwt\.claims'/i.test(t))).toHaveLength(2);
  });

  it('LIMS_CORE_TX_RETRY_MAX = 3 means 3 retries: 4 attempts in total, then 503 common.dependency_unavailable', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE hot/, () => pgError(code), 99);
    let runs = 0;
    const e = await rejection(db.requestTx(txInput(), async (tx: any) => { runs += 1; await tx.query('UPDATE hot SET n = 1'); }));
    expect(runs).toBe(4);
    expect(e).toMatchObject({ code: 'common.dependency_unavailable', statusCode: 503 });
    expect(fake.state.releasedInTx).toBe(0);
  });

  it('retryMax is configurable: 0 = no retry', async () => {
    const { fake, db } = mk({ retryMax: 0 });
    fake.inject(/UPDATE hot/, () => pgError(code), 99);
    let runs = 0;
    const e = await rejection(db.requestTx(txInput(), async (tx: any) => { runs += 1; await tx.query('UPDATE hot SET n = 1'); }));
    expect(runs).toBe(1);
    expect(e).toMatchObject({ code: 'common.dependency_unavailable', statusCode: 503 });
  });

  it('a serialization failure raised at COMMIT is retried too', async () => {
    const { fake, db } = mk();
    fake.inject(/^COMMIT/i, () => pgError(code), 1);
    let runs = 0;
    await db.requestTx(txInput(), async () => { runs += 1; });
    expect(runs).toBe(2);
  });

  it('a failure inside a savepoint that the handler does not catch is retried as a whole request', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE hot/, () => pgError(code), 1);
    let runs = 0;
    await db.requestTx(txInput(), async (tx: any) => { runs += 1; await tx.savepoint((s: any) => s.query('UPDATE hot SET n = 1')); });
    expect(runs).toBe(2);
  });
});

describe('backoff jitter 10-50 ms [CONV]', () => {
  it('sleeps between attempts with jitter in [10, 50] ms; none before the first attempt or after the last', async () => {
    const { fake, k, db } = mk({}, [0, 0.5, 0.999999]);
    fake.inject(/UPDATE hot/, () => pgError('40001'), 99);
    await rejection(db.requestTx(txInput(), (tx: any) => tx.query('UPDATE hot SET n = 1')));
    expect(k.sleeps).toHaveLength(3);
    for (const ms of k.sleeps) { expect(ms).toBeGreaterThanOrEqual(10); expect(ms).toBeLessThanOrEqual(50); }
    expect(k.sleeps[0]).toBe(10);
    expect(k.sleeps[1]).toBe(30);
  });
});

describe('errors that are NOT retried', () => {
  it.each([
    ['23505', 'common.internal', 500],
    ['23514', 'common.validation_failed', 400],
    ['42501', 'common.not_found', 404],
    ['23503', 'common.not_found', 404],
    ['55P03', 'common.dependency_unavailable', 503],
    ['57014', 'common.dependency_unavailable', 503],
  ])('%s runs the handler once', async (code, mapped, status) => {
    const { fake, db } = mk();
    fake.inject(/UPDATE once/, () => pgError(code, 'x', { constraint: 'c' }), 99);
    let runs = 0;
    const e = await rejection(db.requestTx(txInput(), async (tx: any) => { runs += 1; await tx.query('UPDATE once SET n = 1'); }));
    expect(runs).toBe(1);
    expect(e).toMatchObject({ code: mapped, statusCode: status });
  });

  it('a non-DB handler error is not retried', async () => {
    const { db } = mk();
    let runs = 0;
    await rejection(db.requestTx(txInput(), async () => { runs += 1; throw new Error('bug'); }));
    expect(runs).toBe(1);
  });
});

describe('AC-0D-2.7 ctx.noRetry()', () => {
  it.each(['40001', '40P01'])('handler called ctl.noRetry(), tx fails with %s: not retried, ends 503 common.dependency_unavailable', async (code) => {
    const { fake, k, db } = mk();
    fake.inject(/UPDATE gateway/, () => pgError(code), 99);
    let runs = 0;
    const e = await rejection(db.requestTx(txInput(), async (tx: any, ctl: any) => {
      runs += 1;
      ctl.noRetry();
      await tx.query('UPDATE gateway SET initiated = true');
    }));
    expect(runs).toBe(1);
    expect(begins(fake)).toBe(1);
    expect(k.sleeps).toEqual([]);
    expect(e).toMatchObject({ code: 'common.dependency_unavailable', statusCode: 503 });
    expect(fake.texts()).toContain('ROLLBACK');
    expect(fake.state.releasedInTx).toBe(0);
  });

  it('noRetry() called after the failing statement was caught-and-rethrown still blocks the retry (flag is request-level, order-independent)', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE gateway/, () => pgError('40001'), 99);
    let runs = 0;
    await rejection(db.requestTx(txInput(), async (tx: any, ctl: any) => {
      runs += 1;
      try { await tx.query('UPDATE gateway SET x = 1'); } catch (err) { ctl.noRetry(); throw err; }
    }));
    expect(runs).toBe(1);
  });

  it('noRetry also applies when 40001 surfaces at COMMIT', async () => {
    const { fake, db } = mk();
    fake.inject(/^COMMIT/i, () => pgError('40001'), 99);
    let runs = 0;
    const e = await rejection(db.requestTx(txInput(), async (_tx: any, ctl: any) => { runs += 1; ctl.noRetry(); }));
    expect(runs).toBe(1);
    expect(e).toMatchObject({ code: 'common.dependency_unavailable', statusCode: 503 });
  });

  it('noRetry is per request: the next request retries normally', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE gw/, () => pgError('40001'), 1);
    await rejection(db.requestTx(txInput(), async (tx: any, ctl: any) => { ctl.noRetry(); await tx.query('UPDATE gw SET x = 1'); }));
    fake.inject(/UPDATE hot/, () => pgError('40001'), 1);
    let runs = 0;
    await db.requestTx(txInput(), async (tx: any) => { runs += 1; await tx.query('UPDATE hot SET n = 1'); });
    expect(runs).toBe(2);
  });

  it('noRetry on a request that succeeds changes nothing', async () => {
    const { db } = mk();
    expect(await db.requestTx(txInput(), async (_tx: any, ctl: any) => { ctl.noRetry(); return 7; })).toBe(7);
  });

  it('two concurrent requests: noRetry on one does not disable the retry of the other', async () => {
    const fakeTwo = createFakePgBouncer(2);
    const db2 = createDb({ pool: fakeTwo.pool, sleep: async () => {}, random: () => 0 } as any) as any;
    fakeTwo.inject(/UPDATE a_hot/, () => pgError('40001'), 1);
    fakeTwo.inject(/UPDATE b_gateway/, () => pgError('40001'), 99);
    let aRuns = 0, bRuns = 0;
    await Promise.allSettled([
      db2.requestTx(txInput(), async (tx: any) => { aRuns += 1; await tx.query('UPDATE a_hot SET n = 1'); }),
      db2.requestTx(txInput(), async (tx: any, ctl: any) => { bRuns += 1; ctl.noRetry(); await tx.query('UPDATE b_gateway SET n = 1'); }),
    ]);
    expect([aRuns, bRuns]).toEqual([2, 1]);
  });
});
