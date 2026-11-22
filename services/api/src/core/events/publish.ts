// ctx.events.publish (02-TRD §6.10; AC-0D-5.1..5.3). Runs inside the caller's transaction: validate, INSERT … ON CONFLICT DO NOTHING,
// enqueue core.event_fanout. A throw rolls the caller's transaction back, so the event row and its fan-out job commit together.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../errors.js';
import { REPO_ROOT } from '../module.js';

// [CONV] ajv is not a direct services/api dependency (lockfile is C0-0A's, LD-05): load the ajv that @fastify/ajv-compiler ships.
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;

type Validate = (v: unknown) => boolean;
let validators: ReadonlyMap<string, Validate> | undefined;

/** Compiles every contracts/events/<type>.schema.json once (first call; bootstrap may call it eagerly). */
export function eventValidators(): ReadonlyMap<string, Validate> {
  if (validators) return validators;
  const dir = join(REPO_ROOT, 'contracts', 'events');
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false });
  ajv.addKeyword({ keyword: 'x-extensible', schemaType: 'boolean' });
  const ids: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.schema.json')) continue;
    ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!f.startsWith('_')) ids.push(f.slice(0, -'.schema.json'.length));
  }
  validators = new Map(ids.map((t) => [t, ajv.getSchema(`urn:lims:event:${t}`) as Validate]));
  return validators;
}

interface Log { warn(o: object, m?: string): void; error(o: object, m?: string): void }
interface Metrics { inc(name: string, labels?: Readonly<Record<string, string | number>>, by?: number): void }
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }>; readonly startedAt: Date }
interface Ctx {
  readonly tenantId: string; readonly requestId: string; readonly tx: unknown;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string; readonly supportSessionId?: string };
}
export interface PublishInput {
  readonly aggregate: { readonly type: string; readonly id: string; readonly seq: number };
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly causationEventId?: string;
}
export interface EventsDeps { readonly producer: string; readonly metrics?: Metrics; readonly log?: Log }

const INSERT_SQL = `INSERT INTO core.event_log
  (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;
const LOOKUP_DEF_SQL = `SELECT app.core_lookup_event_id($1, $2) AS event_id`;
const EXISTING_SQL = `SELECT event_id FROM core.event_log WHERE tenant_id = $1 AND event_type = $2 AND idempotency_key = $3`;
const FANOUT_SQL = `SELECT app.enqueue_job('core.event_fanout', jsonb_build_object('event_id', $1::uuid, 'tenant_id', $2::uuid), $1::text, NULL, NULL)`;

function isIdemDuplicate(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return false;
  if (e.constraint && e.constraint !== 'event_log__tenant_id_event_type_idempotency_key__uq') return false;
  return true;
}

export function createEvents(deps: EventsDeps) {
  const { producer } = deps;
  return {
    async publish(ctx: Ctx, type: string, input: PublishInput): Promise<{ eventId: string; duplicate: boolean }> {
      const tx = ctx.tx as Tx;
      const a = ctx.actor;
      const i = (input ?? {}) as Partial<PublishInput>;
      const envelope: Record<string, unknown> = {
        event_id: uuidv7(), event_type: type, tenant_id: ctx.tenantId, occurred_at: tx.startedAt.toISOString(),
        actor: {
          type: a.type, id: a.id,
          ...(a.membershipId === undefined ? {} : { membership_id: a.membershipId }),
          ...(a.supportSessionId === undefined ? {} : { support_session_id: a.supportSessionId }),
        },
        idempotency_key: i.idempotencyKey, producer,
        aggregate: i.aggregate === undefined ? undefined : { type: i.aggregate.type, id: i.aggregate.id, seq: i.aggregate.seq },
        request_id: ctx.requestId,
        ...(i.causationEventId === undefined ? {} : { causation_event_id: i.causationEventId }),
        payload: i.payload,
      };
      const validate = eventValidators().get(type);
      // Never log the payload or ajv's error list (instance values may be PHI): the event type is enough to find the bug.
      if (!validate || !validate(envelope)) {
        deps.log?.error({ event: 'event_schema_violation', event_type: type }, 'event_schema_violation');
        throw new LimsError('common.internal');
      }
      const ag = i.aggregate!;
      const eventId = envelope.event_id as string;
      try {
        await tx.query(INSERT_SQL, [
          ctx.tenantId, eventId, type, producer, i.idempotencyKey, ag.type, ag.id, ag.seq, tx.startedAt, envelope, a.id,
        ]);
      } catch (err: unknown) {
        if (isIdemDuplicate(err)) {
          let existingId: string | undefined;
          try {
            const hit = await tx.query(LOOKUP_DEF_SQL, [type, i.idempotencyKey]);
            existingId = hit.rows[0]?.event_id;
          } catch {
            // Definer function may be unmigrated in unit test environments; fallback to direct SELECT
          }
          if (!existingId) {
            try {
              const hit = await tx.query(EXISTING_SQL, [ctx.tenantId, type, i.idempotencyKey]);
              existingId = hit.rows[0]?.event_id;
            } catch {
              // RLS hides event_log from non-staff caller
            }
          }
          if (typeof existingId === 'string' && existingId.length > 0) {
            return { eventId: existingId, duplicate: true };
          }
          // If the persisted event cannot be determined (cross-actor probe), do not mint a fake persisted event ID
          throw new LimsError('common.conflict');
        }
        throw err;
      }
      await tx.query(FANOUT_SQL, [eventId, ctx.tenantId]);
      deps.metrics?.inc('lims_core_events_published_total', { event_type: type, tenant_id: ctx.tenantId });
      return { eventId, duplicate: false };
    },
  };
}
