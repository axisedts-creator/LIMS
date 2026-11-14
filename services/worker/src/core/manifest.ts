// WorkerManifest type + build-time checks (02-TRD §7.2). Every check throws an Error that names the module and the offender.
// ponytail: no src/jobs/*/index.ts autoloader yet (no module ships worker jobs in C0); add it with bootstrap/main.
import { EVENT_CONSUMERS } from '../../../../contracts/ports/generated/events.js';
import { MODULE_NAMES, type ModuleName } from '../../../api/src/core/module.js';

export type TenantScope = 'per_tenant' | 'platform';
export interface CronEntry { readonly identifier: string; readonly schedule: string; readonly tenantScope: TenantScope; readonly maxAttempts?: number }
export type TaskHandler = (payload: { tenant_id?: string } & Record<string, unknown>, ctx: JobContext) => Promise<void>;
export type ConsumerHandler = (event: any, ctx: JobContext) => Promise<void>;

export interface WorkerManifest {
  readonly module: ModuleName;
  readonly tasks?: Readonly<Record<string, TaskHandler>>;
  readonly subscriptions?: Readonly<Record<string, ConsumerHandler>>;
  readonly crontab?: readonly CronEntry[];
  readonly maxAttempts?: Readonly<Record<string, number>>;
  readonly taskOptions?: Readonly<Record<string, { statementTimeoutMs?: number }>>;
}

export interface JobContext {
  readonly tenantId: string | undefined;
  readonly actor: { readonly type: 'system'; readonly id: string };
  readonly requestId: string;
  readonly tx: any;
  readonly db: { tx<T>(fn: (ctx: JobContext) => Promise<T>): Promise<T> };
  readonly events: unknown; readonly core: unknown; readonly log: any;
  readonly storage: unknown; readonly files: unknown; readonly audit: unknown;
  readonly attempt: number; readonly maxAttempts: number; readonly jobId: string;
  now(): string;
  isNewer(lastAppliedSeq: number | undefined, seq: number): boolean;
}

export const MAX_STATEMENT_TIMEOUT_MS = 300_000;                       // CR-C8-012
const TASK_ID = /^[a-z_]+\.[a-z0-9_]+$/;                                // '<m>.<snake_task>'
const CRON_FIELD = /^[0-9*,/-]+$/;

const isAttempts = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 100;   // g_task_registry__attempts__ck
const fail = (m: string, what: string): never => { throw new Error(`worker manifest ${m}: ${what}`); };

/** Throws on the first invalid manifest. Returns them unchanged. */
export function validateManifests(manifests: readonly WorkerManifest[]): readonly WorkerManifest[] {
  const seen = new Set<string>();
  for (const mf of manifests) {
    const m = String(mf?.module);
    if (!(MODULE_NAMES as readonly string[]).includes(m) || m === 'core') fail(m, 'unknown module');
    if (seen.has(m)) fail(m, 'duplicate manifest');
    seen.add(m);
    const tasks = mf.tasks ?? {};
    for (const [id, h] of Object.entries(tasks)) {
      if (!id.startsWith(`${m}.`) || !TASK_ID.test(id)) fail(m, `task '${id}' is outside the module namespace or not '<module>.<snake_task>'`);
      if (typeof h !== 'function') fail(m, `task '${id}' has no handler`);
    }
    const allowed = EVENT_CONSUMERS[m] ?? [];
    for (const [type, h] of Object.entries(mf.subscriptions ?? {})) {
      if (!(allowed as readonly string[]).includes(type)) fail(m, `subscription '${type}' is not in EVENT_CONSUMERS`);
      if (typeof h !== 'function') fail(m, `subscription '${type}' has no handler`);
    }
    for (const [id, n] of Object.entries(mf.maxAttempts ?? {})) {
      if (!(id in tasks)) fail(m, `maxAttempts for undeclared task '${id}'`);
      if (!isAttempts(n)) fail(m, `maxAttempts for '${id}' must be 1..100`);
    }
    for (const [id, o] of Object.entries(mf.taskOptions ?? {})) {
      if (!(id in tasks)) fail(m, `taskOptions for undeclared task '${id}'`);
      const ms = o?.statementTimeoutMs;
      if (ms !== undefined && !(Number.isInteger(ms) && ms >= 1 && ms <= MAX_STATEMENT_TIMEOUT_MS)) fail(m, `taskOptions '${id}'.statementTimeoutMs must be 1..${MAX_STATEMENT_TIMEOUT_MS}`);
    }
    const cronIds = new Set<string>();
    for (const c of mf.crontab ?? []) {
      if (!(c?.identifier in tasks)) fail(m, `crontab entry '${c?.identifier}' is not a declared task`);
      if (cronIds.has(c.identifier)) fail(m, `crontab entry '${c.identifier}' is declared twice`);
      cronIds.add(c.identifier);
      const f = typeof c.schedule === 'string' ? c.schedule.trim().split(/\s+/) : [];
      if (f.length !== 5 || !f.every((x) => CRON_FIELD.test(x))) fail(m, `crontab entry '${c.identifier}' schedule must be 5 UTC fields`);
      if (c.tenantScope !== 'per_tenant' && c.tenantScope !== 'platform') fail(m, `crontab entry '${c.identifier}' has an invalid tenantScope`);
      if (c.maxAttempts !== undefined && !isAttempts(c.maxAttempts)) fail(m, `crontab entry '${c.identifier}' maxAttempts must be 1..100`);
    }
  }
  return manifests;
}
