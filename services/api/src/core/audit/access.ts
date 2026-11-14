// ctx.audit.access (02-TRD §6.9): one audit.access_log row on ctx.tx, so it commits or rolls back with the action.
// For outcome 'denied' the handler calls ctx.commitOnError() so the row survives the error response.
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../errors.js';

export interface AccessLogEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly centreId?: string;
  readonly purpose?: string;
  readonly outcome: 'allowed' | 'denied';
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}
interface Ctx {
  readonly tenantId: string; readonly requestId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string; readonly supportSessionId?: string };
  readonly tx: unknown;
}

const ACTION = /^[a-z_]+\.[a-z_]+$/;                       // audit.g_cs_access_actions code CHECK
const CODE = /^[A-Za-z0-9_.:^+\-]{1,64}$/;                 // IC Code
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v);
const str = (re: RegExp) => (x: unknown) => typeof x === 'string' && re.test(x);

function valid(e: Partial<AccessLogEntry>): boolean {
  if (!str(ACTION)(e.action) || e.action!.length > 64) return false;
  if (typeof e.entityType !== 'string' || e.entityType.length < 1 || e.entityType.length > 40) return false;
  if (e.outcome !== 'allowed' && e.outcome !== 'denied') return false;
  if (!optional(e.entityId, str(UUIDV7)) || !optional(e.centreId, str(UUIDV7)) || !optional(e.purpose, str(CODE))) return false;
  if (e.detail === undefined) return true;
  if (typeof e.detail !== 'object' || e.detail === null || Array.isArray(e.detail)) return false;
  if (!Object.values(e.detail).every((v) => ['string', 'number', 'boolean'].includes(typeof v))) return false;
  return Buffer.byteLength(JSON.stringify(e.detail), 'utf8') <= 4096;     // access_log__text__ck octet_length(detail::text)
}

const INSERT_SQL = `INSERT INTO audit.access_log
  (id, tenant_id, centre_id, actor_id, actor_type, membership_id, support_session_id,
   action, entity_type, entity_id, purpose_code, outcome, detail, request_id, created_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $4)`;

export async function access(ctx: Ctx, entry: AccessLogEntry): Promise<void> {
  const e = (entry ?? {}) as Partial<AccessLogEntry>;
  if (!valid(e)) throw new LimsError('common.internal');   // programming error in the calling handler, never user input
  const a = ctx.actor;
  await (ctx.tx as { query(t: string, v: unknown[]): Promise<unknown> }).query(INSERT_SQL, [
    uuidv7(), ctx.tenantId, e.centreId ?? null, a.id, a.type, a.membershipId ?? null, a.supportSessionId ?? null,
    e.action, e.entityType, e.entityId ?? null, e.purpose ?? null, e.outcome, e.detail ?? {}, ctx.requestId,
  ]);
}
