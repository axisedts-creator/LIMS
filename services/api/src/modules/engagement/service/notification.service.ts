// E45 listMyNotifications, E46 markMyNotificationsRead (02-TRD §4.9, §5; 05-SCHEMA notifications; PRD US-EN-11.1/11.3; 07-SECURITY §6.5, §7.1/§7.4).
// "No text stored": the DTO carries kind / entity / route ids only and the only write is read_at. Account comes from the session (RLS), never from the request.
// Bulk mark: foreign, other-tenant and unknown ids all answer the same per-id `not_found` (no existence oracle); the call itself is always 200.
// create(): in-app notification rows created by the system actor (T-P1 consumers), no text stored (the app renders `patient_app.notification.<kind>`), expire after 180 days [CONV].
// One row per (account, kind, entity, entity_seq): INSERT .. ON CONFLICT DO NOTHING makes event redelivery a no-op. P1 data: nothing here logs a value.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import * as defaultRepo from '../repository/notification.repo.js';
import { isUuid } from './queue.service.js';

export interface NotificationIn {
  accountId: string; patientId: string | null; kind: 'report_ready' | 'sample_recollection'; entityType: 'order' | 'report'; entityId: string; entitySeq: number; routeId: 'patient_app.report' | 'patient_app.order';
}
const TTL_MS = 180 * 86_400_000; // [CONV]
const COLS = 11;

export interface NotificationCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
  now(): string;
}
export type NotificationRepo = typeof defaultRepo;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  const e: FieldError = { path, code, message };
  throw new LimsError('common.validation_failed', undefined, [e]);
};
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();

function scope(ctx: NotificationCtx): { tx: any; tenantId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId };
}

const encodeCursor = (r: Record<string, any>) => Buffer.from(JSON.stringify([iso(r['created_at']), r['id']])).toString('base64url');
// ponytail: keyset at ms precision (JS Date); upgrade to a text-cast created_at if pg timestamps ever carry µs ties.
function decodeCursor(c: unknown): { createdAt: string; id: string } | undefined {
  if (c === undefined) return undefined;
  try {
    if (typeof c !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(c)) throw new Error('shape');
    const [createdAt, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown[];
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)) || !isUuid(id)) throw new Error('shape');
    return { createdAt, id };
  } catch { return invalid('/cursor'); }
}

export function createNotificationService(deps: { repo?: NotificationRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  return {
    async list(ctx: NotificationCtx, q: unknown) {
      const { tx, tenantId } = scope(ctx);
      const query = isObj(q) ? q : {};
      const u = query['unread_only'];
      if (u !== undefined && u !== true && u !== false && u !== 'true' && u !== 'false') invalid('/unread_only');
      const rawLimit = query['limit'];
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === 'string' && rawLimit.trim() === '' ? NaN : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('/limit');
      const after = decodeCursor(query['cursor']);
      const rows = await repo.listNotifications(tx, { tenantId, unreadOnly: u === true || u === 'true', ...(after ? { after } : {}), limit: limit + 1 });
      const page = rows.slice(0, limit);
      const links = new Map((await repo.listLinkIds(tx, { tenantId })).map((l) => [l['patient_id'] as string, l['id'] as string]));
      const data = page.map((r) => {
        const profileId = r['patient_id'] == null ? undefined : links.get(r['patient_id']);
        return {
          id: r['id'], kind: r['kind'],
          ...(r['entity_type'] != null ? { entity_type: r['entity_type'] } : {}),
          ...(r['entity_id'] != null ? { entity_id: r['entity_id'] } : {}),
          ...(profileId !== undefined ? { profile_id: profileId } : {}),
          ...(r['route_id'] != null ? { route_id: r['route_id'] } : {}),
          created_at: iso(r['created_at']),
          ...(r['read_at'] != null ? { read_at: iso(r['read_at']) } : {}),
        };
      });
      return { data, page: { limit, ...(rows.length > limit ? { next_cursor: encodeCursor(page[page.length - 1]!) } : {}) } };
    },

    async markRead(ctx: NotificationCtx, input: { body: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const b = input.body;
      if (!isObj(b)) return invalid('/');
      for (const k of Object.keys(b)) if (k !== 'ids') invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field'); // mass assignment (account_id, read, ...)
      const ids = b['ids'];
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200) return invalid('/ids');
      if (!ids.every(isUuid)) return invalid('/ids');
      const wanted = [...new Set(ids as string[])];
      const own = new Set(await repo.visibleIds(tx, { tenantId, ids: wanted }));
      const readAt = ctx.now();
      for (const id of wanted) if (own.has(id)) await repo.markRead(tx, { tenantId, id, readAt });
      return { results: (ids as string[]).map((id) => ({ id, outcome: own.has(id) ? 'updated' : 'not_found' })) };
    },

    async create(ctx: { tx: any; tenantId: string; actor: { id: string }; now: () => string }, rows: readonly NotificationIn[]): Promise<void> {
      if (rows.length === 0) return;
      const expires = new Date(Date.parse(ctx.now()) + TTL_MS).toISOString();
      const values: unknown[] = [];
      for (const n of rows) values.push(uuidv7(), ctx.tenantId, n.accountId, n.patientId, n.kind, n.entityType, n.entityId, n.entitySeq, n.routeId, ctx.actor.id, expires);
      const tuples = rows.map((_, i) => `(${Array.from({ length: COLS }, (_, j) => `$${i * COLS + j + 1}`).join(', ')})`).join(', ');
      await ctx.tx.query(
        `INSERT INTO engagement.notifications (id, tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, route_id, created_by, expires_at)
         VALUES ${tuples} ON CONFLICT (tenant_id, account_id, kind, entity_id, entity_seq) DO NOTHING`, values);
    },
  };
}
export type NotificationService = ReturnType<typeof createNotificationService>;
