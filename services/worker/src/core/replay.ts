// CLI: pnpm worker:replay --event-type <type> --since <ISO> --module <m> (02-TRD §7.1 line 791; 03-APP-FLOW E-10; LD-65).
// Re-enqueues evt.<module>.<event_type> consumer jobs for stored events. Stays inside the event_log retention (<= 90 days) and
// enqueues only through app.enqueue_job, with the fan-out's job shape (02-TRD §7.3): payload ids only, job_key '<event_id>:<module>'
// (a pending original dedupes; the consumer inbox makes a re-delivery a no-op). event_log is tenant-RLS, so tenants come from
// app.cron_tenant_ids() and each tenant page tx opens directly with tenant claims for the module system actor, as consumer.ts
// does (withTenantScope is reserved for the 08 R10 item 4 / A25 D-214 core-internal uses; replay is not one of them).
import { pathToFileURL } from 'node:url';
import { EVENT_CONSUMERS } from '../../../../contracts/ports/generated/events.js';
import { platformClaims, tenantClaims } from './deadletter.js';
import { ENQUEUE_SQL, EVT_MAX_ATTEMPTS, consumerIdentifier } from './fanout.js';
import type { WorkerDeps } from './tasklist.js';

export const RETENTION_DAYS = 90;                                       // core.event_log retention (E-10)
const DAY_MS = 86_400_000;
const PAGE = 500;                                                       // [CONV] keyset page size, one tx per page
const TENANTS_SQL = 'SELECT tenant_id FROM app.cron_tenant_ids() AS t(tenant_id)';
const PAGE_SQL = `SELECT event_id FROM core.event_log
  WHERE tenant_id = $1 AND event_type = $2 AND occurred_at >= $3 AND ($4::uuid IS NULL OR event_id > $4::uuid)
  ORDER BY event_id LIMIT ${PAGE}`;

export interface ReplayInput { readonly eventType: string; readonly since: Date; readonly module: string }

const FLAGS = { '--event-type': 'eventType', '--since': 'since', '--module': 'module' } as const;

export function parseReplayArgs(argv: readonly string[]): ReplayInput {
  const out: Partial<Record<'eventType' | 'since' | 'module', string>> = {};
  const a = argv.filter((x) => x !== '--');                             // pnpm may pass a separator through
  for (let i = 0; i < a.length; i += 2) {
    const key = FLAGS[a[i] as keyof typeof FLAGS];
    const v = a[i + 1];
    if (!key) throw new Error(`worker:replay: unknown argument '${a[i]}'`);
    if (out[key] !== undefined) throw new Error(`worker:replay: ${a[i]} given twice`);
    if (v === undefined || v.startsWith('--')) throw new Error(`worker:replay: ${a[i]} needs a value`);
    out[key] = v;
  }
  for (const [flag, key] of Object.entries(FLAGS)) if (!out[key]) throw new Error(`worker:replay: ${flag} is required`);
  const since = new Date(out.since!);
  if (!/^\d{4}-\d{2}-\d{2}(T|$)/.test(out.since!) || Number.isNaN(since.getTime())) throw new Error('worker:replay: --since must be an ISO-8601 date-time');
  return { eventType: out.eventType!, since, module: out.module! };
}

export async function replayEvents(deps: WorkerDeps, input: ReplayInput): Promise<{ enqueued: number }> {
  const { eventType, since, module } = input;
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw new Error('worker:replay: invalid since');
  if (since.getTime() < deps.now().getTime() - RETENTION_DAYS * DAY_MS) throw new Error(`worker:replay: --since is older than the ${RETENTION_DAYS}-day event_log retention`);
  if (!((EVENT_CONSUMERS as Record<string, readonly string[]>)[module] ?? []).includes(eventType)) {
    throw new Error(`worker:replay: module '${module}' does not consume '${eventType}'`);
  }
  const identifier = consumerIdentifier(module, eventType);
  const actor = deps.systemActorOf(module);
  const core = platformClaims(deps.coreActorId);
  const tenants = await deps.db.tx({ claims: core, operation: 'core.replay' }, async (tx) => (await tx.query(TENANTS_SQL)).rows);
  let enqueued = 0;
  for (const r of tenants) {
    const tenantId = String(r.tenant_id ?? r.cron_tenant_ids);
    let cursor: string | null = null;
    for (;;) {
      const page: number = await deps.db.tx({ claims: tenantClaims(actor, tenantId), operation: 'core.replay' }, async (tx) => {
        const rows = (await tx.query(PAGE_SQL, [tenantId, eventType, since.toISOString(), cursor])).rows;
        for (const e of rows) {
          const eventId = String(e.event_id);
          await tx.query(ENQUEUE_SQL, [identifier, JSON.stringify({ event_id: eventId, tenant_id: tenantId, event_type: eventType }), `${eventId}:${module}`, null, EVT_MAX_ATTEMPTS]);
          cursor = eventId;
        }
        return rows.length;
      });
      enqueued += page;                                                 // includes jobs app.enqueue_job deduped on job_key
      if (page < PAGE) break;
    }
  }
  deps.log.info('replay_done', { task: identifier, enqueued, tenants: tenants.length });
  return { enqueued };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createWorkerRuntime } = await import('./bootstrap.js');
  const input = parseReplayArgs(process.argv.slice(2));
  const rt = await createWorkerRuntime();
  try {
    const { enqueued } = await replayEvents(rt.deps, input);
    process.stdout.write(`worker:replay enqueued ${enqueued}\n`);
  } catch (e) {
    process.exitCode = 1;
    process.stderr.write(`${(e as Error).message}\n`);
  } finally {
    await rt.close();
  }
}
