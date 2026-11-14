// Worker bootstrap (02-TRD §7.1 bootstrap.ts; DECISIONS.md SP-2; LD-65). graphile-worker is replaced by a recording double, so the tests
// prove the WIRING: what bootstrap hands to run(), not Graphile itself. Assumed export of ../bootstrap.js (spec names run() and parseCronItems,
// not the function):
//   startWorker({ deps: WorkerDeps, manifests: WorkerManifest[], pgPool, concurrency?: number, pollInterval?: number })
//     -> Promise<{ runner, stop(): Promise<void> }>
// It builds the task list with buildTaskList(deps, manifests), calls graphile-worker run({ pgPool, taskList, parsedCronItems, ... }) once and
// returns after run() resolves. SP-2: the crontab is passed as parsedCronItems = parseCronItems(built.cronItems), never as crontab text.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLog, makeMetrics, makeWorld, rejects, systemActorOf, CORE_ACTOR, ORDER_CREATED } from './helpers.js';

const gw = vi.hoisted(() => ({
  runner: { stop: vi.fn(async () => undefined), promise: Promise.resolve() },
  run: vi.fn(),
  parseCronItems: vi.fn(),
}));
vi.mock('graphile-worker', () => ({ run: gw.run, parseCronItems: gw.parseCronItems }));

const noop = async () => undefined;
const manifests = [
  { module: 'lab', subscriptions: { [ORDER_CREATED]: noop } },
  { module: 'reporting', tasks: { 'reporting.nightly_digest': noop }, crontab: [{ identifier: 'reporting.nightly_digest', schedule: '0 2 * * *', tenantScope: 'per_tenant' }] },
];

let world: ReturnType<typeof makeWorld>; let metrics: ReturnType<typeof makeMetrics>; let deps: any; let pgPool: any;
const PARSED = [{ parsed: 'items' }];

beforeEach(() => {
  gw.run.mockReset(); gw.parseCronItems.mockReset(); gw.runner.stop.mockClear();
  gw.run.mockResolvedValue(gw.runner);
  gw.parseCronItems.mockReturnValue(PARSED);
  world = makeWorld(); metrics = makeMetrics();
  deps = {
    db: world.db, withTenantScope: world.withTenantScope, systemActorOf, coreActorId: CORE_ACTOR, metrics, log: makeLog().log, now: () => new Date('2026-11-07T12:00:30.000Z'),
    events: {}, core: {}, storage: {}, files: {}, audit: {},
  };
  pgPool = { query: vi.fn(async () => ({ rows: [] })), connect: vi.fn(), end: vi.fn(async () => undefined), on: vi.fn() };
});

const builtFor = async () => (await import('../tasklist.js')).buildTaskList(deps, manifests as any);

describe('startWorker', () => {
  it('calls graphile-worker run() exactly once with the pool and the built task list', async () => {
    const { startWorker } = await import('../bootstrap.js');
    await startWorker({ deps, manifests: manifests as any, pgPool });
    expect(gw.run).toHaveBeenCalledTimes(1);
    const opts = gw.run.mock.calls[0]![0];
    const built = await builtFor();
    expect(opts.pgPool).toBe(pgPool);
    expect(Object.keys(opts.taskList).sort()).toEqual(Object.keys(built.taskList).sort());
    for (const id of ['core.event_fanout', 'core.retention_purge', 'core.queue_depth_probe', `evt.lab.${ORDER_CREATED}`, 'reporting.nightly_digest']) {
      expect(typeof opts.taskList[id], id).toBe('function');
    }
  });

  it('SP-2: passes the crontab as parsedCronItems = parseCronItems(built.cronItems), never as crontab text', async () => {
    const { startWorker } = await import('../bootstrap.js');
    await startWorker({ deps, manifests: manifests as any, pgPool });
    const built = await builtFor();
    expect(gw.parseCronItems).toHaveBeenCalledTimes(1);
    expect(gw.parseCronItems.mock.calls[0]![0]).toEqual(built.cronItems);
    const opts = gw.run.mock.calls[0]![0];
    expect(opts.parsedCronItems).toBe(PARSED);
    expect(opts.crontab).toBeUndefined();
    expect(opts.crontabFile).toBeUndefined();
    const tasks = built.cronItems.map((c) => c.task);
    expect(tasks).toEqual(expect.arrayContaining(['core.retention_purge', 'core.queue_depth_probe', 'reporting.nightly_digest']));
  });

  it('the task list handed to Graphile is the wired one: core.queue_depth_probe runs against deps and sets lims_queue_depth', async () => {
    const { startWorker } = await import('../bootstrap.js');
    await startWorker({ deps, manifests: manifests as any, pgPool });
    world.setQueueDepth([{ task_identifier: 'lab.x', ready: 7, locked: 1, failed: 0 }]);
    const task = gw.run.mock.calls[0]![0].taskList['core.queue_depth_probe'];
    await task({}, { job: { id: '1', key: null, attempts: 1, max_attempts: 25 } });
    expect(metrics.last('set', 'lims_queue_depth', { task: 'lab.x' })?.value).toBe(7);
  });

  it('returns the Graphile runner and a stop() that stops it', async () => {
    const { startWorker } = await import('../bootstrap.js');
    const w = await startWorker({ deps, manifests: manifests as any, pgPool });
    expect(w.runner).toBe(gw.runner);
    await w.stop();
    expect(gw.runner.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() twice stops the runner once', async () => {
    const { startWorker } = await import('../bootstrap.js');
    const w = await startWorker({ deps, manifests: manifests as any, pgPool });
    await w.stop(); await w.stop();
    expect(gw.runner.stop).toHaveBeenCalledTimes(1);
  });

  it('an invalid manifest fails the boot before run() is called', async () => {
    const { startWorker } = await import('../bootstrap.js');
    const bad = [{ module: 'instruments', subscriptions: { [ORDER_CREATED]: noop } }];   // instruments does not consume this event
    await rejects(startWorker({ deps, manifests: bad as any, pgPool }));
    expect(gw.run).not.toHaveBeenCalled();
  });

  it('a run() failure (e.g. database unreachable) rejects startWorker, it is not swallowed', async () => {
    const { startWorker } = await import('../bootstrap.js');
    gw.run.mockRejectedValue(new Error('ECONNREFUSED'));
    const err = await rejects(startWorker({ deps, manifests: manifests as any, pgPool }));
    expect(String(err.message)).toContain('ECONNREFUSED');
  });

  it('a parseCronItems failure rejects startWorker and run() is not called', async () => {
    const { startWorker } = await import('../bootstrap.js');
    gw.parseCronItems.mockImplementation(() => { throw new Error('bad cron item'); });
    await rejects(startWorker({ deps, manifests: manifests as any, pgPool }));
    expect(gw.run).not.toHaveBeenCalled();
  });

  it('bootstrap itself issues no DDL (schema install is a migration step, SP-2)', async () => {
    const { startWorker } = await import('../bootstrap.js');
    await startWorker({ deps, manifests: manifests as any, pgPool });
    const sql = pgPool.query.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(sql).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT)\b/i);
    expect(world.writes).toHaveLength(0);
  });

  it('does not write core.g_task_registry at runtime (registry-sync is a deploy step)', async () => {
    const { startWorker } = await import('../bootstrap.js');
    await startWorker({ deps, manifests: manifests as any, pgPool });
    expect(world.stmtsMatching(/g_task_registry/i)).toHaveLength(0);
    expect(pgPool.query.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toMatch(/g_task_registry/i);
  });
});
