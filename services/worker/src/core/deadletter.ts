// Final-failure capture -> core.dead_letters (02-TRD §7.4; AC-0D-5.6; 08 A23.2 job_key copy; 07 AB-22).
// Detection (SP-2, DECISIONS.md): the wrapper compares helpers.job.attempts with helpers.job.max_attempts before rethrowing.
import { LimsError } from '../../../../packages/shared-ts/src/errors/index.js';
import { createLogger } from '../../../../packages/shared-ts/src/logger/index.js';
import { uuidv7 } from '../../../../packages/shared-ts/src/uuidv7/index.js';
import type { RegistryEntry, WorkerDeps } from './tasklist.js';

export interface GraphileJob { readonly id: string | number; readonly key?: string | null; readonly attempts: number; readonly max_attempts: number; readonly created_at?: Date | string }
export interface GraphileHelpers { readonly job: GraphileJob; readonly [k: string]: unknown }
export type GraphileTask = (payload: unknown, helpers: GraphileHelpers) => Promise<void>;

const MAX_MSG = 2000;                                                   // CHECK dead_letters__msg__ck

// [CONV] shared-ts does not export its scrubber: run the message through a real shared-ts logger and read back the scrubbed msg.
let scrubbed = '';
const scrubLog = createLogger({ service: 'worker', env: 'scrub', version: '0', destination: { write: (l: string) => { scrubbed = l; } } });
export function redactMessage(msg: string): string {
  scrubbed = '';
  scrubLog.error(msg);
  let out: string;
  try { out = String(JSON.parse(scrubbed).msg ?? ''); } catch { out = '[REDACTED]'; }
  return out.slice(0, MAX_MSG);
}

export const errorCode = (e: unknown): string => (e instanceof LimsError ? e.code : 'common.internal');

/** Platform claims for an actor (no tenant). */
export const platformClaims = (sub: string) => ({ sub, actor_type: 'system' as const });
export const tenantClaims = (sub: string, tenantId: string) => ({ sub, tenant_id: tenantId, actor_type: 'system' as const });

const TENANT_INSERT = `INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted,
  attempts, first_failed_at, dead_at, state, job_key, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, 'open', $9, $10)`;
const PLATFORM_INSERT = 'SELECT app.dl_insert_platform($1, $2, $3, $4, $5, $6, $7, $8)';

async function capture(deps: WorkerDeps, entry: RegistryEntry, payload: unknown, job: GraphileJob, err: unknown): Promise<void> {
  const code = errorCode(err);
  const msg = redactMessage(err instanceof Error && err.message ? err.message : code) || code;
  const actor = entry.module === 'core' ? deps.coreActorId : deps.systemActorOf(entry.module);
  // [CONV] Graphile Worker keeps no first-failure time; job.created_at is its lower bound.
  const firstFailedAt = new Date(job.created_at ?? deps.now()).toISOString();
  const id = uuidv7();
  const body = JSON.stringify(payload ?? {});
  const jobKey = job.key ?? null;
  if (entry.scope === 'platform') {
    await deps.db.tx({ claims: platformClaims(actor), operation: 'core.dead_letter' }, (tx) =>
      tx.query(PLATFORM_INSERT, [id, entry.identifier, body, code, msg, job.attempts, firstFailedAt, jobKey]));
  } else {
    const tenantId = String((payload as { tenant_id?: unknown } | null)?.tenant_id ?? '');
    await deps.db.tx({ claims: tenantClaims(actor, tenantId), operation: 'core.dead_letter' }, (tx) =>
      tx.query(TENANT_INSERT, [id, tenantId, entry.identifier, body, code, msg, job.attempts, firstFailedAt, jobKey, actor]));
  }
  deps.metrics.inc('lims_core_dead_letters_total', { task: entry.identifier });
}

/** Wraps a task run: on failure logs (no payload), dead-letters on the final attempt, and always rethrows so Graphile records it. */
export function withDeadLetter(deps: WorkerDeps, entry: RegistryEntry, run: (payload: any, job: GraphileJob) => Promise<void>): GraphileTask {
  return async (payload, helpers) => {
    const job = helpers.job;
    try {
      await run(payload, job);
    } catch (err) {
      const final = job.attempts >= job.max_attempts;
      deps.log.warn('job_failed', { task: entry.identifier, job_id: String(job.id), attempt: job.attempts, max_attempts: job.max_attempts, error_code: errorCode(err), final });
      if (final) {
        try { await capture(deps, entry, payload, job, err); } catch (dlErr) {
          deps.log.error('dead_letter_write_failed', { task: entry.identifier, job_id: String(job.id), error_code: errorCode(dlErr) });
        }
      }
      throw err;
    }
  };
}
