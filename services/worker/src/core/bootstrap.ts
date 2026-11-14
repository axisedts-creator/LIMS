// Worker bootstrap (02-TRD §7.1: config, pools, Graphile Worker run(); DECISIONS.md SP-2; LD-65).
// SP-2 "T0D-09 uses parsedCronItems": the crontab goes to run() as parseCronItems(built.cronItems), never as crontab text
// (the text syntax rejects '.' in task identifiers). No DDL here: the graphile_worker schema is a migration step, and
// core.g_task_registry is written by registry-sync at deploy, not at worker runtime.
import { makeWorkerUtils, parseCronItems, run, type CronItem, type Runner, type TaskList, type WithPgClient } from 'graphile-worker';
import { createLogger } from '../../../../packages/shared-ts/src/logger/index.js';
import { createMetrics, startMetricsServer, type CoreMetrics } from '../../../api/src/core/observability/metrics.js';
import { buildTaskList, type Claims, type WorkerDeps, type WorkerTx } from './tasklist.js';
import type { WorkerManifest } from './manifest.js';
import { withTenantScope } from './tenant-scope.js';

export interface StartWorkerOptions {
  readonly deps: WorkerDeps;
  readonly manifests: readonly WorkerManifest[];
  readonly pgPool?: unknown;                  // tests / callers holding a pg Pool
  readonly connectionString?: string;         // main.ts: LIMS_CORE_WORKER_DATABASE_URL (direct, 04 S8)
  readonly concurrency?: number;
  readonly pollInterval?: number;
}

export async function startWorker(o: StartWorkerOptions): Promise<{ runner: Runner; stop(): Promise<void> }> {
  const built = buildTaskList(o.deps, o.manifests);                       // throws on an invalid manifest, before run()
  const parsedCronItems = parseCronItems(built.cronItems as unknown as CronItem[]);
  const runner = await run({
    ...(o.pgPool !== undefined ? { pgPool: o.pgPool as never } : {}),
    ...(o.connectionString !== undefined ? { connectionString: o.connectionString } : {}),
    taskList: built.taskList as unknown as TaskList,
    parsedCronItems,
    concurrency: o.concurrency ?? 10,                                     // LIMS_CORE_WORKER_CONCURRENCY default
    ...(o.pollInterval !== undefined ? { pollInterval: o.pollInterval } : {}),
    noHandleSignals: true,                                                // main.ts owns SIGTERM (LIMS_CORE_SHUTDOWN_GRACE_S)
  });
  let stopping: Promise<void> | undefined;
  return { runner, stop: () => (stopping ??= runner.stop()) };
}

// One transaction per call, everything transaction-local (same contract as the API's request tx, 02-TRD §6.4).
const OPEN_SQL = `SELECT set_config('request.jwt.claims', $1::text, true),
       set_config('statement_timeout', $2::text, true),
       set_config('lock_timeout', '3000', true)`;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;                                // [CONV] same default as the API (02-TRD §6.4)

export function createWorkerDb(withPgClient: WithPgClient): WorkerDeps['db'] {
  return {
    tx: <T>(input: { claims: Claims; statementTimeoutMs?: number }, fn: (tx: WorkerTx) => Promise<T>) => withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(OPEN_SQL, [JSON.stringify(input.claims), String(input.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS)]);
        const out = await fn({ query: (text, values) => client.query(text, values as unknown[]) });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    }),
  };
}

const notWired = (port: string) => new Proxy({}, { get: (_t, k) => { if (k === 'then') return undefined; throw new Error(`worker: ${port} port is not wired yet`); } });

/** Process-level deps from env (main.ts, replay CLI). Caller must call close(). */
export async function createWorkerRuntime(env: NodeJS.ProcessEnv = process.env) {
  const connectionString = env.LIMS_CORE_WORKER_DATABASE_URL;
  if (!connectionString) throw new Error('LIMS_CORE_WORKER_DATABASE_URL is required');
  const utils = await makeWorkerUtils({ connectionString });
  try {
    const rows = await utils.withPgClient(async (c) => (await c.query('SELECT module, actor_id FROM core.g_system_actors WHERE is_active')).rows);
    const actors = new Map<string, string>(rows.map((r: { module: string; actor_id: string }) => [String(r.module), String(r.actor_id)]));
    const systemActorOf = (m: string) => { const id = actors.get(m); if (!id) throw new Error(`no active system actor for module '${m}'`); return id; };
    const metrics: CoreMetrics = createMetrics();
    const log = createLogger({ service: 'worker', env: env.LIMS_CORE_ENV ?? 'dev', version: env.LIMS_CORE_VERSION ?? '0.0.0', level: (env.LIMS_CORE_LOG_LEVEL as never) ?? 'info' });
    // ponytail: events/core/storage/files/audit ports are not wired yet; a job touching one fails loudly (dead-letters), wire with the port registry (IC X7).
    const deps: WorkerDeps = {
      db: createWorkerDb(utils.withPgClient), withTenantScope, systemActorOf, coreActorId: systemActorOf('core'),
      metrics: metrics as unknown as WorkerDeps['metrics'], log: log as unknown as WorkerDeps['log'], now: () => new Date(),
      events: notWired('events'), core: notWired('core'), storage: notWired('storage'), files: notWired('files'), audit: notWired('audit'),
    };
    return { deps, metrics, connectionString, startMetricsServer: (port: number) => startMetricsServer(metrics, { port, host: '0.0.0.0' }), close: () => utils.release() };
  } catch (e) {
    await utils.release();
    throw e;
  }
}
