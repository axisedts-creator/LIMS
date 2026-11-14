// C14 T14 — task smartreport.prebuild_summary (06-PLAN row T14; 02-TRD §9.1, §7.1 mode 'prebuild'; PRD AC-15.5; 08 A19 P-44 savepoint rule).
// Runs the task through the real C0 task wrapper on the core fake DB; buildOrGet is replaced by a recording fake. Seams: see t14.fakes.ts header.
// Fails now: the task is the SR-T01 fail-closed stub ("smartreport.prebuild_summary not implemented").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, type Setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { LimsError, MARKER_SQL, ORDER, ORDER_2, SYS, TA, TB, makePorts, reset, results, store, withPorts } from './t14.fakes.js';

vi.mock('../../../../../api/src/modules/smartreport/repository/summaries.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).summariesRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/reviews.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).reviewsRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/library.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).libraryRepo }));
vi.mock('../../../../../api/src/modules/smartreport/summary.service.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t14.fakes.js')).summaryService }));

const TASK = 'smartreport.prebuild_summary';
let s: Setup;
let ports: ReturnType<typeof makePorts>;
beforeEach(async () => { reset(); ports = makePorts(); s = await setup([withPorts(manifest as any, ports)]); });
const run = (payload: unknown = { tenant_id: TA, order_id: ORDER }) => s.run(TASK, payload);
const settle = (p: Promise<unknown>) => p.then(() => undefined, (e) => e as Error);
const labCalls = () => store.portCalls.filter((c) => c.port === 'lab');

describe('C14-T14 prebuild_summary — registration', () => {
  it('is a per-tenant task with the consumer retry class (10 attempts, TRD §9.1)', () => {
    expect(s.entry(TASK)).toMatchObject({ module: 'smartreport', kind: 'task', scope: 'per_tenant', maxAttempts: 10 });
  });
});

describe('prebuild_summary — gating (TRD §9.1: flag off / no approved library -> done)', () => {
  it('feature flag smart_report off -> done: nothing read from LabPort, nothing built', async () => {
    store.flag = false; results(ORDER, ['approved']);
    await run();
    expect(store.buildCalls).toEqual([]);
    expect(labCalls()).toEqual([]);
  });

  it('no approved library -> done: nothing built', async () => {
    store.library = null; results(ORDER, ['approved']);
    await run();
    expect(store.buildCalls).toEqual([]);
  });

  it('approved library of another tenant only -> done for this tenant', async () => {
    store.library = { id: 'lib-b', tenant_id: TB, status: 'approved' }; results(ORDER, ['approved']);
    await run();
    expect(store.buildCalls).toEqual([]);
  });
});

describe('prebuild_summary — completeness (AC-15.5; "prebuild skips incomplete orders")', () => {
  it('reads LabPort.getOrderResults with scope all_visible (system actor holds lab.result.read), not the approved scope', async () => {
    results(ORDER, ['approved']);
    await run();
    expect(labCalls().map((c) => c.fn)).toContain('getOrderResults:all_visible');
  });

  it.each([['pending'], ['resulted'], ['verified']])('any non-cancelled result still %s -> order not complete: done, nothing built (a later approval re-enqueues)', async (status) => {
    results(ORDER, ['approved', status]);
    await run();
    expect(store.buildCalls).toEqual([]);
  });

  it('cancelled results are ignored: approved + cancelled = complete -> built', async () => {
    results(ORDER, ['approved', 'cancelled', 'approved']);
    await run();
    expect(store.buildCalls).toHaveLength(1);
  });

  it('all approved -> exactly one buildOrGet(mode prebuild) for the payload order, no reportVersionNo (no binding row)', async () => {
    results(ORDER, ['approved', 'approved']);
    await run();
    expect(store.buildCalls).toHaveLength(1);
    expect(store.buildCalls[0]!.input).toEqual({ orderId: ORDER, mode: 'prebuild' });
    expect(store.buildCalls[0]).toMatchObject({ tenantId: TA, actorId: SYS });
  });

  it('buildOrGet gets a BuildCtx: tx with .savepoint (the worker tx has none of its own) and ports FrontdeskPort + LabPort + CatalogPort', async () => {
    results(ORDER, ['approved']);
    await run();
    expect(store.buildCalls[0]!.hasSavepoint).toBe(true);
    expect(store.buildCalls[0]!.ports).toEqual(expect.arrayContaining(['CatalogPort', 'FrontdeskPort', 'LabPort']));
  });

  it('idempotent: a re-run for the same order (job_key replacement or retry) just calls buildOrGet again (returns the live summary)', async () => {
    results(ORDER, ['approved']);
    await run(); await run();
    expect(store.buildCalls).toHaveLength(2);
    expect(store.buildCalls.every((c) => c.input['orderId'] === ORDER)).toBe(true);
  });

  it('the build is for the payload order only: another order\'s results never decide completeness', async () => {
    results(ORDER, ['approved']); results(ORDER_2, ['pending']);
    await run({ tenant_id: TA, order_id: ORDER });
    expect(store.buildCalls).toHaveLength(1);
  });
});

describe('prebuild_summary — P-44 savepoint (08 A19)', () => {
  const refusal = (code: string) => async (ctx: any) => {
    await ctx.tx.query(MARKER_SQL, ['written-by-build']);       // what a port/service wrote before refusing
    throw new LimsError(code);
  };

  it.each(['smartreport.no_eligible_results', 'smartreport.template_not_approved'])('%s -> the savepoint is rolled back (marker absent), the task resolves, earlier writes of the transaction stay', async (code) => {
    results(ORDER, ['approved']);
    store.markers.push('written-before');                       // e.g. the consumer's supersede in an earlier tx step; must survive
    store.buildImpl = refusal(code);
    await expect(run()).resolves.toBeUndefined();
    expect(store.buildCalls).toHaveLength(1);
    expect(store.markers).toEqual(['written-before']);
    expect(s.world.deadLetters).toHaveLength(0);
    expect(s.world.txLog.at(-1)!.outcome).toBe('commit');        // done, not retried
  });

  it('success keeps what buildOrGet wrote (savepoint released, not rolled back)', async () => {
    results(ORDER, ['approved']);
    store.buildImpl = async (ctx: any) => { await ctx.tx.query(MARKER_SQL, ['draft-row']); return { summary: { id: 'x' }, created: true }; };
    await run();
    expect(store.markers).toEqual(['draft-row']);
  });

  it.each([['common.not_found'], ['common.internal'], ['catalog.test_inactive']])('any other error (%s) propagates unchanged so the queue retries (P-23: original LimsError, not re-wrapped)', async (code) => {
    results(ORDER, ['approved']);
    store.buildImpl = async () => { throw new LimsError(code); };
    const err = await settle(run());
    expect(err).toBeInstanceOf(LimsError);
    expect((err as LimsError).code).toBe(code);
  });

  it('a non-Lims error (db down) propagates too (never swallowed as "done")', async () => {
    results(ORDER, ['approved']);
    store.buildImpl = async () => { throw new Error('connection terminated'); };
    expect((await settle(run()))?.message).toBe('connection terminated');
  });
});

describe('prebuild_summary — dependency failures and bad input', () => {
  it('LabPort failure (all_visible read) rejects the job (retry), nothing built', async () => {
    ports.lab.getOrderResults = async () => { throw new LimsError('common.internal'); };
    expect(await settle(run())).toBeInstanceOf(LimsError);
    expect(store.buildCalls).toEqual([]);
  });

  it('identity settings failure rejects the job (retry) instead of silently skipping', async () => {
    store.settingsThrows = true; results(ORDER, ['approved']);
    expect((await settle(run()))?.message).toBe('identity down');
    expect(store.buildCalls).toEqual([]);
  });

  it.each([[undefined], [''], ['not-a-uuid'], ['../../etc/passwd'], [42]])('invalid order_id %j -> never builds and never reads results', async (bad) => {
    expect((await settle(run({ tenant_id: TA, order_id: bad })))?.message ?? '').not.toMatch(/not implemented/);   // rejected as invalid or skipped, but the task is implemented
    expect(store.buildCalls).toEqual([]);
    expect(labCalls()).toEqual([]);
  });

  it('payload without a valid tenant_id is rejected by the C0 wrapper (nothing built)', async () => {
    results(ORDER, ['approved']);
    expect((await settle(run({ order_id: ORDER })))?.message).toMatch(/tenant_id/);
    expect(store.buildCalls).toEqual([]);
  });

  it('runs under the payload tenant claims and the smartreport system actor only', async () => {
    results(ORDER, ['approved']);
    await run();
    expect(s.world.txLog.every((t) => t.claims0.tenant_id === TA && t.claims0.sub === SYS && t.claims0.actor_type === 'system')).toBe(true);
  });
});
