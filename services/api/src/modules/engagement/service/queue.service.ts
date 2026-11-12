// Q1a/Q1b/Q1c queues, Q2a/Q2b/Q2c counters (02-TRD §4.10, §5; 05-SCHEMA queue_definitions / queue_counters; 07-SECURITY §6.4, REQ-SEC-017).
// Tenant and actor come from ctx only. Centre scope: the handler asserts IdentityPort.assertRole({permission, centreId}) and STAFF_C RLS hides other centres' rows,
// so an object outside the actor's scope is "not found" (404 before the version is compared: a foreign row's existence is never revealed).
// Error details are fixed text: no submitted value is echoed (REQ-SEC-080).
import { LimsError, type FieldError } from '../../../core/errors.js';
import * as defaultRepo from '../repository/queue.repo.js';
import type { QueueKind } from '../repository/queue.repo.js';

export interface QueueCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
}
export type QueueRepo = typeof defaultRepo;
export type { QueueKind };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9_]{1,32}$/;
const PREFIX = /^[A-Z]{1,2}$/;
const FIELDS: Readonly<Record<QueueKind, readonly string[]>> = {
  queue: ['centre_id', 'code', 'display_name', 'token_prefix', 'sort_order', 'is_active'],
  counter: ['centre_id', 'display_name', 'sort_order', 'is_active'],
};
const NAME_MAX: Readonly<Record<QueueKind, number>> = { queue: 60, counter: 40 };
const DUP_PATH: Readonly<Record<QueueKind, string>> = { queue: '/code', counter: '/display_name' }; // the unique key of each table

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
export const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]);
};

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

function scope(ctx: QueueCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}

/** Body -> column values. Strict: unknown fields (tenant_id, version, ...) are refused (mass assignment), every field required (PUT = full replacement). */
function parseInput(kind: QueueKind, body: unknown): Record<string, any> {
  if (!isObj(body)) return invalid('/');
  const allowed = FIELDS[kind];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
  for (const k of allowed) if (body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  if (!isUuid(body['centre_id'])) invalid('/centre_id');
  if (typeof body['display_name'] !== 'string' || body['display_name'].length < 1 || body['display_name'].length > NAME_MAX[kind]) invalid('/display_name');
  const so = body['sort_order'];
  if (typeof so !== 'number' || !Number.isSafeInteger(so) || so < 0 || so > 999) invalid('/sort_order');
  if (typeof body['is_active'] !== 'boolean') invalid('/is_active');
  if (kind === 'queue') {
    if (typeof body['code'] !== 'string' || !CODE.test(body['code'])) invalid('/code');
    if (typeof body['token_prefix'] !== 'string' || !PREFIX.test(body['token_prefix'])) invalid('/token_prefix');
  }
  return body;
}

/** If-Match arrives as the raw header '"<version>"' (02-CV §4.2): absent -> 428, malformed -> 400. */
export function parseIfMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const n = m ? Number(m[1]) : 0;
  if (n < 1 || n > 2147483647) return invalid('/If-Match'); // version is a Postgres integer
  return n;
}

/** is_active query: boolean, or the strings 'true'/'false' (query strings), else 400. */
function parseActive(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return invalid('/is_active');
}

/** Row -> Queue / QueueCounter: contract fields only (no tenant_id, board_version, audit columns). */
function toBody(kind: QueueKind, row: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row['id'], centre_id: row['centre_id'] };
  if (kind === 'queue') { out['code'] = row['code']; }
  out['display_name'] = row['display_name'];
  if (kind === 'queue') { out['token_prefix'] = row['token_prefix']; }
  out['sort_order'] = row['sort_order'];
  out['is_active'] = row['is_active'];
  out['version'] = row['version'];
  return out;
}

/** Unique-key violation (23505) -> 400 on the key field; anything else unexpected fails closed without SQL text. */
function mapDbError(kind: QueueKind, e: unknown, op: 'create' | 'update'): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23505') return invalid(DUP_PATH[kind], 'common.field_invalid', 'Already exists in this centre');
  if (code === '42501' || code === '23503') { // RLS WITH CHECK / FK: target not visible to this actor
    if (op === 'create') return invalid('/centre_id', 'common.field_invalid', 'Centre not found'); // create declares no 404
    throw new LimsError('common.not_found');
  }
  throw new LimsError('common.internal');
}

export function createQueueService(deps: { repo?: QueueRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  return {
    /** Console (Q1a/Q2a, centre required) and setup (Q1b/Q2b, centre optional) lists share one path. */
    async list(ctx: QueueCtx, kind: QueueKind, input: { centreId: string | undefined; isActive: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const isActive = parseActive(input.isActive);
      const rows = await repo.listRows(tx, kind, { tenantId, ...(input.centreId === undefined ? {} : { centreId: input.centreId }), ...(isActive === undefined ? {} : { isActive }) });
      return { data: rows.map((r) => toBody(kind, r)) };
    },

    /** The handler has already asserted the permission for the body's centre; here: body shape (400) -> centre exists in tenant (400 /centre_id) -> INSERT. */
    async create(ctx: QueueCtx, kind: QueueKind, input: { body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const values = parseInput(kind, input.body);
      try {
        // FK target must exist in this tenant and be visible to the actor (a foreign tenant's centre looks absent).
        if (!(await repo.centreExists(tx, { tenantId, centreId: values['centre_id'] }))) return invalid('/centre_id', 'common.field_invalid', 'Centre not found');
        const row = await repo.insertRow(tx, kind, { tenantId, userId, centreId: values['centre_id'], values });
        if (!row) throw new LimsError('common.internal');
        return toBody(kind, row);
      } catch (e) { return mapDbError(kind, e, 'create'); }
    },

    /** Order: If-Match shape (428/400) -> body shape (400) -> row lookup (404, scope-hidden rows included) -> `authorizeRow(centre)` -> version (409) -> UPDATE. */
    async update(ctx: QueueCtx, kind: QueueKind, input: { id: unknown; headers: unknown; body: unknown; authorizeRow: (centreId: string) => Promise<void> }) {
      const { tx, tenantId, userId } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/id');
      const values = parseInput(kind, input.body);
      try {
        const current = await repo.getRow(tx, kind, { tenantId, id: input.id });
        if (!current) throw new LimsError('common.not_found');
        await input.authorizeRow(current['centre_id']);
        if (values['centre_id'] !== current['centre_id']) return invalid('/centre_id', 'common.field_invalid', 'Centre cannot be changed'); // a row never moves between centres
        if (current['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
        const row = await repo.updateRow(tx, kind, { tenantId, userId, id: input.id, expectedVersion, values });
        if (!row) throw new LimsError('common.version_conflict'); // lost a race between the read and the write
        return toBody(kind, row);
      } catch (e) { return mapDbError(kind, e, 'update'); }
    },
  };
}
export type QueueService = ReturnType<typeof createQueueService>;
