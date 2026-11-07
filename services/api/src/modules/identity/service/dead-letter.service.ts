// Dead letters, platform console (06 T24; 02-TRD §5.10, §6.8; 03-APP-FLOW §9.3; 07-SECURITY D-T9..D-T18; 08 A6.4, A8.4-A8.6, A9.1-A9.3, A10.2).
// No repository, no SQL (08 A8.6): every row comes from ctx.core.deadLetters. Authz (PlatformAuthz) runs before any core call.
// Responses whitelist the DeadLetterRow contract keys, so nothing else a core row may carry ever reaches a body. The note is never logged.
import type { AccessLogEntry } from '../../../core/audit/access.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { PlatformAuthz } from '../platform/authz.js';

const PERMISSION = 'platform.dead_letter.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;   // same strict UTC form as core (02-CV §4.4)
const STATES = ['open', 'replayed', 'discarded'];
const LIST_DEFAULT = 50, LIST_MAX = 200, PG_INT_MAX = 2147483647;

export interface DeadLetterRow {
  id: string; tenantId: string | null; taskIdentifier: string; lastErrorCode: string; lastErrorMessageRedacted: string; attempts: number;
  firstFailedAt: string; deadAt: string; state: 'open' | 'replayed' | 'discarded'; resolvedBy: string | null; resolvedAt: string | null;
  resolutionNote: string | null; version: number;
}
export interface ListInput {
  state?: string; platformRows?: boolean; tenantId?: string; taskIdentifier?: string; deadAtFrom?: string; deadAtTo?: string; cursor?: string; limit?: number;
}
export interface CoreDeadLetters {
  list(ctx: unknown, input: ListInput): Promise<{ items: DeadLetterRow[]; nextCursor?: string }>;
  get(ctx: unknown, input: { deadLetterId: string }): Promise<DeadLetterRow>;
  replay(ctx: unknown, input: { deadLetterId: string; expectedVersion: number; reasonText?: string }): Promise<void>;
  discard(ctx: unknown, input: { deadLetterId: string; expectedVersion: number; reasonText: string }): Promise<void>;
}
export interface DeadLetterCtx {
  readonly actor: { readonly type: string; readonly id: string };
  readonly platformRole: string;
  readonly platformStaffId: string;
  readonly aal?: string;
  readonly requestId?: string;
  readonly clientIp?: string;
  readonly tx: unknown;
  readonly db: { withTenantScope<T>(tx: unknown, tenantId: string, fn: () => Promise<T>): Promise<T> };
  readonly audit: { access(e: AccessLogEntry): Promise<void> };
  readonly core: { deadLetters: CoreDeadLetters };
}
export interface DeadLetterViewedEvent {
  eventType: 'dead_letter_viewed'; targetType: 'dead_letter'; targetId: string; targetTenantId: null; detail: Record<string, never>;
  actorPlatformStaffId: string; actorId: string; requestId?: string; clientIp?: string;
}
export interface PlatformEventsWriter { insert(tx: unknown, e: DeadLetterViewedEvent): Promise<void> }
export interface Result { status: number; body: any; version?: number }

const failAt = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
const str = (v: unknown, lo: number, hi: number) => typeof v === 'string' && v.length >= lo && v.length <= hi;
/** 1..500 characters (code points, as dead_letters__resolution_note__ck), not blank. */
const note = (v: unknown, path: string): string =>
  typeof v === 'string' && v.trim() !== '' && [...v].length <= 500 ? v : failAt(path);
function expectedVersion(v: unknown): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  return Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= PG_INT_MAX ? (v as number) : failAt('/If-Match');
}
const idOrNotFound = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new LimsError('common.not_found');
  return v;
};

/** DeadLetterRow (contracts/openapi/identity.yaml): snake_case, null optionals omitted. Built key by key (whitelist). */
function toBody(r: DeadLetterRow) {
  const opt = { tenant_id: r.tenantId, resolved_by: r.resolvedBy, resolved_at: r.resolvedAt, resolution_note: r.resolutionNote };
  return {
    id: r.id, ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== null && v !== undefined)),
    task_identifier: r.taskIdentifier, last_error_code: r.lastErrorCode, last_error_message_redacted: r.lastErrorMessageRedacted,
    attempts: r.attempts, first_failed_at: r.firstFailedAt, dead_at: r.deadAt, state: r.state, version: r.version,
  };
}

function listFilter(i: Record<string, unknown>): ListInput {
  if (i.state !== undefined && !STATES.includes(i.state as string)) failAt('/state');
  if (i.platformRows !== undefined && typeof i.platformRows !== 'boolean') failAt('/platform_rows');
  if (i.tenantId !== undefined && !(typeof i.tenantId === 'string' && UUID.test(i.tenantId))) failAt('/tenant_id');
  if (i.platformRows === true && i.tenantId !== undefined) failAt('/tenant_id');   // 08 A10.2
  if (i.taskIdentifier !== undefined && !str(i.taskIdentifier, 1, 200)) failAt('/task_identifier');
  for (const [k, p] of [['deadAtFrom', '/dead_at_from'], ['deadAtTo', '/dead_at_to']] as const) {
    if (i[k] !== undefined && !(typeof i[k] === 'string' && ISO.test(i[k] as string))) failAt(p);
  }
  if (i.cursor !== undefined && !str(i.cursor, 1, 512)) failAt('/cursor');
  if (i.limit !== undefined && !(Number.isInteger(i.limit) && (i.limit as number) >= 1 && (i.limit as number) <= LIST_MAX)) failAt('/limit');
  const keys = ['state', 'tenantId', 'taskIdentifier', 'deadAtFrom', 'deadAtTo', 'cursor', 'limit'] as const;
  return { ...Object.fromEntries(keys.filter((k) => i[k] !== undefined).map((k) => [k, i[k]])), platformRows: i.platformRows === true };
}

export function createDeadLetterService(deps: { platformEvents?: PlatformEventsWriter } = {}) {
  const guard = (ctx: DeadLetterCtx) => PlatformAuthz.assertPlatform(ctx, PERMISSION);

  async function resolved(ctx: DeadLetterCtx, deadLetterId: string): Promise<Result> {
    const row = await ctx.core.deadLetters.get(ctx, { deadLetterId });
    return { status: 200, body: toBody(row), version: row.version };
  }

  return {
    async listDeadLetters(ctx: DeadLetterCtx, input: unknown): Promise<Result> {
      guard(ctx);
      const f = listFilter((input ?? {}) as Record<string, unknown>);
      const out = await ctx.core.deadLetters.list(ctx, f);
      return {
        status: 200,
        body: { data: out.items.map(toBody), page: { limit: f.limit ?? LIST_DEFAULT, ...(out.nextCursor !== undefined ? { next_cursor: out.nextCursor } : {}) } },
      };
    },

    /** 03-APP-FLOW §9.3: tenant row -> dead_letter.view in that tenant's access log; platform row -> platform_events dead_letter_viewed. */
    async getDeadLetter(ctx: DeadLetterCtx, input: { deadLetterId?: unknown }): Promise<Result> {
      guard(ctx);
      const deadLetterId = idOrNotFound(input?.deadLetterId);
      const row = await ctx.core.deadLetters.get(ctx, { deadLetterId });
      if (row.tenantId !== null) {
        const tenantId = row.tenantId;
        await ctx.db.withTenantScope(ctx.tx, tenantId, () =>
          ctx.audit.access({ action: 'dead_letter.view', entityType: 'dead_letter', entityId: row.id, outcome: 'allowed' }));
      } else {
        if (!deps.platformEvents) throw new LimsError('common.internal');   // fail closed: no unlogged read
        await deps.platformEvents.insert(ctx.tx, {
          eventType: 'dead_letter_viewed', targetType: 'dead_letter', targetId: row.id, targetTenantId: null, detail: {},
          actorPlatformStaffId: ctx.platformStaffId, actorId: ctx.actor.id,
          ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}), ...(ctx.clientIp !== undefined ? { clientIp: ctx.clientIp } : {}),
        });
      }
      return { status: 200, body: toBody(row), version: row.version };
    },

    async replayDeadLetter(ctx: DeadLetterCtx, input: { deadLetterId?: unknown; expectedVersion?: unknown; reasonText?: unknown }): Promise<Result> {
      guard(ctx);
      const v = expectedVersion(input?.expectedVersion);
      const reasonText = input?.reasonText === undefined ? undefined : note(input.reasonText, '/reason_text');
      const deadLetterId = idOrNotFound(input?.deadLetterId);
      await ctx.core.deadLetters.replay(ctx, { deadLetterId, expectedVersion: v, ...(reasonText !== undefined ? { reasonText } : {}) });
      return resolved(ctx, deadLetterId);
    },

    async discardDeadLetter(ctx: DeadLetterCtx, input: { deadLetterId?: unknown; expectedVersion?: unknown; reasonText?: unknown }): Promise<Result> {
      guard(ctx);
      const v = expectedVersion(input?.expectedVersion);
      const reasonText = note(input?.reasonText, '/reason_text');
      const deadLetterId = idOrNotFound(input?.deadLetterId);
      await ctx.core.deadLetters.discard(ctx, { deadLetterId, expectedVersion: v, reasonText });
      return resolved(ctx, deadLetterId);
    },
  };
}
