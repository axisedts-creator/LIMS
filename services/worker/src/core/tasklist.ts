// Builds the Graphile taskList: core tasks + plain module tasks + generated evt.* consumer tasks (02-TRD §7.1-7.7).
// Every task is wrapped by withDeadLetter. Also returns the registry entries (registry-sync), taskOptions and the crontab.
import { consumerRun, taskRun } from './consumer.js';
import { CORE_CRONTAB, cronItems, isCronFire, makeCronTick, queueDepthRun, type CronItem, type ScheduledEntry } from './cron.js';
import { withDeadLetter, type GraphileJob, type GraphileTask } from './deadletter.js';
import { EVT_MAX_ATTEMPTS, consumerIdentifier, fanoutRun } from './fanout.js';
import { validateManifests, type TenantScope, type WorkerManifest } from './manifest.js';
import { RETENTION_TIMEOUT_MS, retentionRun } from './retention.js';

export interface Claims { readonly sub: string; readonly tenant_id?: string; readonly actor_type: 'system' }
export interface WorkerTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface WorkerDeps {
  readonly db: { tx<T>(input: { claims: Claims; statementTimeoutMs?: number; operation?: string }, fn: (tx: WorkerTx) => Promise<T>): Promise<T> };
  /** Core-internal 4-arg withTenantScope (08 A23.1/A23.2). */
  readonly withTenantScope: <T>(tx: WorkerTx, tenantId: string, systemActorId: string, fn: () => Promise<T>) => Promise<T>;
  readonly systemActorOf: (module: string) => string;
  readonly coreActorId: string;
  readonly metrics: {
    inc(name: string, labels?: Readonly<Record<string, string | number>>, by?: number): void;
    set(name: string, value: number, labels?: Readonly<Record<string, string | number>>): void;
    observe(name: string, value: number, labels?: Readonly<Record<string, string | number>>): void;
  };
  readonly log: { child(ctx: object): any; info(m: string, f?: object): void; warn(m: string, f?: object): void; error(m: string, f?: object): void };
  readonly now: () => Date;
  readonly events: unknown; readonly core: unknown; readonly storage: unknown; readonly files: unknown; readonly audit: unknown;
}

export type TaskKind = 'core' | 'task' | 'consumer';
export interface RegistryEntry { readonly identifier: string; readonly module: string; readonly kind: TaskKind; readonly scope: TenantScope; readonly maxAttempts: number }

export interface BuiltTaskList {
  readonly taskList: Readonly<Record<string, GraphileTask>>;
  readonly registry: readonly RegistryEntry[];
  readonly taskOptions: Readonly<Record<string, { statementTimeoutMs: number }>>;
  readonly cronItems: readonly CronItem[];
  cronTick(identifier: string, tick: Date): Promise<void>;
}

const DEFAULT_TASK_ATTEMPTS = 25;                                       // [CONV] Graphile Worker default when a manifest sets none

export function buildTaskList(deps: WorkerDeps, manifests: readonly WorkerManifest[]): BuiltTaskList {
  validateManifests(manifests);
  const taskList: Record<string, GraphileTask> = {};
  const registry: RegistryEntry[] = [];
  const taskOptions: Record<string, { statementTimeoutMs: number }> = { 'core.retention_purge': { statementTimeoutMs: RETENTION_TIMEOUT_MS } };
  const schedule: ScheduledEntry[] = [...CORE_CRONTAB];
  const subscribers = new Map<string, string[]>();
  const add = (entry: RegistryEntry, run: (payload: any, job: GraphileJob) => Promise<void>) => {
    if (taskList[entry.identifier]) throw new Error(`duplicate task identifier ${entry.identifier}`);
    registry.push(entry);
    taskList[entry.identifier] = withDeadLetter(deps, entry, run);
  };

  for (const mf of manifests) {
    const m = mf.module;
    const cron = new Map((mf.crontab ?? []).map((c) => [c.identifier, c]));
    for (const c of cron.values()) schedule.push({ ...c, module: m });
    for (const [id, handler] of Object.entries(mf.tasks ?? {})) {
      const c = cron.get(id);
      const scope: TenantScope = c?.tenantScope ?? 'per_tenant';         // [CONV] module tasks are tenant jobs unless a crontab says platform
      const ms = mf.taskOptions?.[id]?.statementTimeoutMs;
      if (ms !== undefined) taskOptions[id] = { statementTimeoutMs: ms };
      const entry: RegistryEntry = { identifier: id, module: m, kind: 'task', scope, maxAttempts: mf.maxAttempts?.[id] ?? c?.maxAttempts ?? DEFAULT_TASK_ATTEMPTS };
      const body = taskRun(deps, entry, handler, ms);
      add(entry, scope === 'per_tenant' && c
        ? (payload, job) => (isCronFire(payload) ? cronTick(id, new Date(payload._cron.ts)) : body(payload, job))
        : body);
    }
    for (const [type, handler] of Object.entries(mf.subscriptions ?? {})) {
      const entry: RegistryEntry = { identifier: consumerIdentifier(m, type), module: m, kind: 'consumer', scope: 'per_tenant', maxAttempts: EVT_MAX_ATTEMPTS };
      add(entry, consumerRun(deps, entry, type, handler));
      subscribers.set(type, [...(subscribers.get(type) ?? []), m]);
    }
  }

  const cronTick = makeCronTick(deps, schedule);
  add({ identifier: 'core.event_fanout', module: 'core', kind: 'core', scope: 'per_tenant', maxAttempts: 25 }, fanoutRun(deps, subscribers));
  add({ identifier: 'core.retention_purge', module: 'core', kind: 'core', scope: 'platform', maxAttempts: 5 }, retentionRun(deps));
  add({ identifier: 'core.queue_depth_probe', module: 'core', kind: 'core', scope: 'platform', maxAttempts: DEFAULT_TASK_ATTEMPTS }, queueDepthRun(deps));

  return { taskList, registry, taskOptions, cronItems: cronItems(schedule), cronTick };
}
