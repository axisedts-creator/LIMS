// evt.<m>.<event_type> consumer wrapper + plain module-task wrapper (02-TRD §7.2, §7.3; AC-0D-5.5; JobContext incl. T0D-17).
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { uuidv7 } from '../../../../packages/shared-ts/src/uuidv7/index.js';
import { platformClaims, tenantClaims, type GraphileJob } from './deadletter.js';
import type { ConsumerHandler, JobContext, TaskHandler } from './manifest.js';
import type { RegistryEntry, WorkerDeps } from './tasklist.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
// [CONV] the worker has no package.json yet (lockfile is C0-0A's, LD-05): load the ajv that @lims/shared-ts depends on.
const Ajv2020 = createRequire(join(REPO_ROOT, 'packages', 'shared-ts', 'package.json'))('ajv/dist/2020.js').default as new (o: object) => any;

/** CV §7.2 / TRD §7.3 step 3: consumers accept unknown values of `x-extensible` enums, so validate against a copy without them. */
function dropExtensibleEnums(node: any): any {
  if (Array.isArray(node)) return node.map(dropExtensibleEnums);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'enum' && node['x-extensible'] === true) continue;
    out[k] = dropExtensibleEnums(v);
  }
  return out;
}

let validators: Map<string, (v: unknown) => boolean> | undefined;
/** Known-fields-only validators (CV §7.2). [CONV] removeAdditional: true, not 'all': 'all' strips the envelope fields that the
 *  per-event allOf branch does not list; every contract object declares additionalProperties: false, so `true` drops unknowns. */
function envelopeValidator(type: string): (v: unknown) => boolean {
  if (!validators) {
    const dir = join(REPO_ROOT, 'contracts', 'events');
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, removeAdditional: true });
    ajv.addKeyword({ keyword: 'x-extensible', schemaType: 'boolean' });
    const ids: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.schema.json')) continue;
      ajv.addSchema(dropExtensibleEnums(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
      if (!f.startsWith('_')) ids.push(f.slice(0, -'.schema.json'.length));
    }
    validators = new Map(ids.map((t) => [t, ajv.getSchema(`urn:lims:event:${t}`)]));
  }
  const v = validators.get(type);
  if (!v) throw new Error(`no event schema for ${type}`);
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function tenantOf(payload: any, task: string): string {
  const t = payload?.tenant_id;
  if (typeof t !== 'string' || !UUID.test(t)) throw new Error(`${task}: job payload has no valid tenant_id`);
  return t;
}

function jobContext(deps: WorkerDeps, module: string, tenantId: string | undefined, tx: any, job: GraphileJob, task: string): JobContext {
  const actorId = deps.systemActorOf(module);
  const ctx: JobContext = {
    tenantId, actor: { type: 'system', id: actorId }, requestId: uuidv7(), tx,
    db: { tx: (fn) => fn(ctx) },                                         // [CONV] the job already runs in one transaction: reuse it
    events: deps.events, core: deps.core, storage: deps.storage, files: deps.files, audit: deps.audit,
    log: deps.log.child({ task, module, ...(tenantId ? { tenant_id: tenantId } : {}) }),
    attempt: job.attempts, maxAttempts: job.max_attempts, jobId: String(job.id),
    now: () => deps.now().toISOString(),
    isNewer: (last, seq) => last === undefined || seq > last,
  };
  return ctx;
}

const INBOX_SQL = (m: string) => `INSERT INTO ${m}.event_inbox (tenant_id, event_id, event_type, received_at, created_by)
  VALUES ($1, $2, $3, now(), $4) ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING event_id`;
const EVENT_SQL = 'SELECT event_type, envelope FROM core.event_log WHERE tenant_id = $1 AND event_id = $2';

/** Consumer task body (§7.3 steps 1-5). The caller wraps it in withDeadLetter. */
export function consumerRun(deps: WorkerDeps, entry: RegistryEntry, eventType: string, handler: ConsumerHandler) {
  const m = entry.module;
  if (!/^[a-z_]+$/.test(m)) throw new Error(`invalid module ${m}`);   // interpolated into SQL as a schema name
  return async (payload: any, job: GraphileJob): Promise<void> => {
    const tenantId = tenantOf(payload, entry.identifier);
    const eventId = payload?.event_id;
    if (typeof eventId !== 'string' || !UUID.test(eventId)) throw new Error(`${entry.identifier}: job payload has no valid event_id`);
    const actorId = deps.systemActorOf(m);
    await deps.db.tx({ claims: tenantClaims(actorId, tenantId), operation: entry.identifier }, async (tx) => {
      const ins = await tx.query(INBOX_SQL(m), [tenantId, eventId, eventType, actorId]);
      if (ins.rows.length === 0) return;                                   // already processed (AC-0D-5.5): commit
      const ev = await tx.query(EVENT_SQL, [tenantId, eventId]);
      const row = ev.rows[0];
      if (!row) throw new Error(`${entry.identifier}: event not found in core.event_log`);
      const envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope;
      if (envelope?.event_type !== eventType || envelope?.tenant_id !== tenantId || envelope?.event_id !== eventId) {
        throw new Error(`${entry.identifier}: event_log row does not match the job`);
      }
      if (!envelopeValidator(eventType)(envelope)) throw new Error(`${entry.identifier}: envelope violates its schema`);
      await handler(envelope, jobContext(deps, m, tenantId, tx, job, entry.identifier));
    });
  };
}

/** Plain module task body: one transaction with the module's system actor; tenant claims unless the task is platform scope. */
export function taskRun(deps: WorkerDeps, entry: RegistryEntry, handler: TaskHandler, statementTimeoutMs: number | undefined) {
  return async (payload: any, job: GraphileJob): Promise<void> => {
    const tenantId = entry.scope === 'per_tenant' ? tenantOf(payload, entry.identifier) : undefined;
    const actorId = deps.systemActorOf(entry.module);
    const claims = tenantId ? tenantClaims(actorId, tenantId) : platformClaims(actorId);
    await deps.db.tx({ claims, operation: entry.identifier, ...(statementTimeoutMs ? { statementTimeoutMs } : {}) }, (tx) =>
      handler(payload ?? {}, jobContext(deps, entry.module, tenantId, tx, job, entry.identifier)));
  };
}
