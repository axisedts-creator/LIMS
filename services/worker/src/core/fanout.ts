// core.event_fanout (02-TRD §7.3; AC-0D-5.4). Payload {event_id, tenant_id}; job payloads hold ids only (P1).
import { tenantClaims, type GraphileJob } from './deadletter.js';
import type { WorkerDeps } from './tasklist.js';

export const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';   // (identifier, payload, job_key, run_at, max_attempts)
const EVENT_SQL = 'SELECT event_type, occurred_at FROM core.event_log WHERE tenant_id = $1 AND event_id = $2';
export const EVT_MAX_ATTEMPTS = 10;                                                   // CV §7.5

export const consumerIdentifier = (module: string, eventType: string) => `evt.${module}.${eventType}`;

/** subscribers: event_type -> modules subscribed in the loaded manifests. */
export function fanoutRun(deps: WorkerDeps, subscribers: ReadonlyMap<string, readonly string[]>) {
  return async (payload: any, _job: GraphileJob): Promise<void> => {
    const tenantId = payload?.tenant_id; const eventId = payload?.event_id;
    if (typeof tenantId !== 'string' || typeof eventId !== 'string') throw new Error('core.event_fanout: payload needs event_id and tenant_id');
    const occurredAt = await deps.db.tx({ claims: tenantClaims(deps.coreActorId, tenantId), operation: 'core.event_fanout' }, async (tx) => {
      const row = (await tx.query(EVENT_SQL, [tenantId, eventId])).rows[0];
      if (!row) {                                                                     // only after retention purge
        deps.log.warn('fanout_event_missing', { task: 'core.event_fanout', tenant_id: tenantId, event_id: eventId });
        return undefined;
      }
      const type = String(row.event_type);
      for (const m of subscribers.get(type) ?? []) {
        await tx.query(ENQUEUE_SQL, [consumerIdentifier(m, type), JSON.stringify({ event_id: eventId, tenant_id: tenantId, event_type: type }),
          `${eventId}:${m}`, null, EVT_MAX_ATTEMPTS]);
      }
      return row.occurred_at as string | Date;
    });
    if (occurredAt !== undefined) deps.metrics.observe('lims_core_event_fanout_lag_seconds', (deps.now().getTime() - new Date(occurredAt).getTime()) / 1000);
  };
}
