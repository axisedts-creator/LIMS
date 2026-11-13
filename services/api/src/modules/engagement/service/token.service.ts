// Q3 issueQueueToken, Q4 listQueueTokens, Q5 callNextQueueToken, Q6 recall/serve/complete/skip/cancel, Q7 transferQueueToken
// (02-TRD §4.10, §5; 03-APP-FLOW §4.3 T-1..T-9; 05-SCHEMA queue_tokens; 07-SECURITY AB-15, §6.3/§6.4). Tenant and actor come from ctx only.
// Centre scope: the handler's `authorizeRow(centreId)` asserts IdentityPort for the row's own centre, and STAFF_C RLS hides other centres' rows,
// so an object outside the actor's scope is "not found" (404 before the version is compared). Error details are fixed text: no submitted value is echoed (REQ-SEC-080).
import { LimsError } from '../../../core/errors.js';
import { businessDate, canRecall, canTransition, formatTokenLabel, type QueueTokenStatus } from '../domain/queueToken.state.js';
import * as defaultRepo from '../repository/token.repo.js';
import type { TokenOp } from '../repository/token.repo.js';
import { invalid, isUuid, parseIfMatch, type QueueCtx } from './queue.service.js';

export type TokenRepo = typeof defaultRepo;
export type { TokenOp };
export type Authorize = (centreId: string) => Promise<void>;
type Row = Record<string, any>;
type Out = { status: number; body?: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATUS = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'transferred', 'expired'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
// op -> allowed current statuses + target (a subset of 03-APP-FLOW §4.3 as encoded in domain/queueToken.state.ts)
const OPS: Readonly<Record<TokenOp, { from: readonly QueueTokenStatus[]; to: QueueTokenStatus }>> = {
  recall: { from: ['called', 'skipped'], to: 'called' }, serve: { from: ['called'], to: 'serving' }, complete: { from: ['called', 'serving'], to: 'completed' },
  skip: { from: ['called'], to: 'skipped' }, cancel: { from: ['waiting', 'called', 'skipped'], to: 'cancelled' },
};

function scope(ctx: QueueCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}
/** Strict body: only `allowed` keys; `required` keys must be uuids, the optional ones too when present. */
function uuidBody(body: unknown, allowed: readonly string[], required: readonly string[], notUuid: readonly string[] = []): Record<string, string> {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
  for (const k of required) if (body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  for (const k of allowed) if (!notUuid.includes(k) && body[k] !== undefined && !isUuid(body[k])) invalid(`/${k}`);
  return body as Record<string, string>;
}
const iso = (v: unknown) => new Date(v as string).toISOString();
/** Row -> QueueToken: contract fields only (no tenant/centre/date/seq/audit/transfer columns); null columns are omitted. */
function toBody(r: Row): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r['id'], queue_id: r['queue_id'], token_label: r['token_label'], status: r['status'], priority: r['priority'] };
  if (r['counter_id']) o['counter_id'] = r['counter_id'];
  o['issued_at'] = iso(r['issued_at']);
  if (r['called_at']) o['called_at'] = iso(r['called_at']);
  o['call_count'] = r['call_count'];
  if (r['booking_id']) o['booking_id'] = r['booking_id'];
  o['version'] = r['version'];
  return o;
}
/** FK / RLS failures mean the target is not visible to this actor; anything else unexpected fails closed without SQL text. */
function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23503' || code === '42501') throw new LimsError('common.not_found');
  throw new LimsError('common.internal');
}

export function createTokenService(deps: { repo?: TokenRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  /** Active counter of the given centre in this tenant, else 400 /counter_id. */
  async function checkCounter(tx: any, tenantId: string, id: string, centreId: string) {
    const c = await repo.getCounter(tx, { tenantId, id });
    if (!c || !c['is_active'] || c['centre_id'] !== centreId) invalid('/counter_id', 'common.field_invalid', 'Counter not found');
  }
  /** queue + feature gate for taking a new token (issue, transfer target). */
  async function assertOpen(tx: any, tenantId: string, queue: Row) {
    if (!queue['is_active'] || !(await repo.queueEnabled(tx, tenantId))) throw new LimsError('engagement.queue_closed');
  }
  /** Number the next token of `queue` for the business day of `now`, and insert it (same unit of work as the caller). */
  async function take(tx: any, tenantId: string, userId: string, queue: Row, a: { now: string; tz: string; priority: string; bookingId: string | null; fromTokenId: string | null }) {
    const date = businessDate(new Date(a.now), a.tz);
    const seq = await repo.nextSeq(tx, { tenantId, queueId: queue['id'], centreId: queue['centre_id'], date, userId });
    return repo.insertToken(tx, { tenantId, centreId: queue['centre_id'], queueId: queue['id'], date, seq, label: formatTokenLabel(queue['token_prefix'], seq), priority: a.priority, bookingId: a.bookingId, issuedAt: a.now, fromTokenId: a.fromTokenId, userId });
  }

  return {
    /** Q3: body (400) -> queue (404) -> authorizeRow -> open? (409 engagement.queue_closed) -> number + insert. */
    async issue(ctx: QueueCtx, input: { body: unknown; now: string; tz: string; authorizeRow: Authorize }): Promise<Out> {
      const { tx, tenantId, userId } = scope(ctx);
      const b = isObj(input.body) ? input.body : {};
      const v = uuidBody(input.body, ['queue_id', 'priority', 'booking_id'], ['queue_id'], ['priority']);
      if (b['priority'] !== undefined && b['priority'] !== 'normal' && b['priority'] !== 'priority') invalid('/priority');
      try {
        const queue = await repo.getQueue(tx, { tenantId, id: v['queue_id']! });
        if (!queue) throw new LimsError('common.not_found');
        await input.authorizeRow(queue['centre_id']);
        await assertOpen(tx, tenantId, queue);
        const row = await take(tx, tenantId, userId, queue, { now: input.now, tz: input.tz, priority: (b['priority'] as string | undefined) ?? 'normal', bookingId: v['booking_id'] ?? null, fromTokenId: null });
        return { status: 201, body: toBody(row) };
      } catch (e) { return mapDbError(e); }
    },

    /** Q4: tokens of one centre for one business day (default: today in the tenant timezone), oldest first, keyset-paged. */
    async list(ctx: QueueCtx, input: { query: unknown; now: string; tz: string }): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      const q = isObj(input.query) ? input.query : {};
      if (!isUuid(q['centre_id'])) invalid('/centre_id', q['centre_id'] === undefined ? 'common.field_required' : 'common.field_invalid', q['centre_id'] === undefined ? 'Field required' : 'Field invalid');
      if (q['queue_id'] !== undefined && !isUuid(q['queue_id'])) invalid('/queue_id');
      if (q['status'] !== undefined && !STATUS.includes(q['status'] as string)) invalid('/status');
      if (q['sort'] !== undefined && q['sort'] !== 'issued_at') invalid('/sort');
      const d = q['business_date'];
      if (d !== undefined && !(typeof d === 'string' && ISO_DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d))) invalid('/business_date');
      const lim = q['limit'] === undefined ? 50 : /^[0-9]{1,3}$/.test(String(q['limit'])) ? Number(q['limit']) : 0;
      if (lim < 1 || lim > 200) invalid('/limit');
      let afterId: string | undefined;
      if (q['cursor'] !== undefined) {
        afterId = typeof q['cursor'] === 'string' && CURSOR.test(q['cursor']) ? Buffer.from(q['cursor'], 'base64url').toString('utf8') : '';
        if (!isUuid(afterId)) invalid('/cursor');
      }
      const rows = await repo.listTokens(tx, { tenantId, centreId: q['centre_id'] as string, date: (d as string | undefined) ?? businessDate(new Date(input.now), input.tz),
        ...(q['queue_id'] ? { queueId: q['queue_id'] as string } : {}), ...(q['status'] ? { status: q['status'] as string } : {}), ...(afterId ? { afterId } : {}), limit: lim + 1 });
      const more = rows.length > lim, page = rows.slice(0, lim);
      return { status: 200, body: { data: page.map(toBody), page: { limit: lim, ...(more ? { next_cursor: Buffer.from(page[lim - 1]!['id']).toString('base64url') } : {}) } } };
    },

    /** Q5: next waiting token of today (priority first, oldest first; SKIP LOCKED) -> called at the counter; 204 when nothing waits. */
    async callNext(ctx: QueueCtx, input: { queueId: unknown; body: unknown; now: string; tz: string; authorizeRow: Authorize }): Promise<Out> {
      const { tx, tenantId, userId } = scope(ctx);
      if (!isUuid(input.queueId)) return invalid('/queue_id');
      const counterId = uuidBody(input.body, ['counter_id'], ['counter_id'])['counter_id']!;
      try {
        const queue = await repo.getQueue(tx, { tenantId, id: input.queueId });
        if (!queue) throw new LimsError('common.not_found');
        await input.authorizeRow(queue['centre_id']);
        await checkCounter(tx, tenantId, counterId, queue['centre_id']);
        const next = await repo.nextWaiting(tx, { tenantId, queueId: input.queueId, date: businessDate(new Date(input.now), input.tz) });
        if (!next) return { status: 204 };
        const row = await repo.callToken(tx, { tenantId, id: next['id'], counterId, now: input.now, userId });
        if (!row) throw new LimsError('common.version_conflict'); // cannot happen under the row lock
        await repo.bumpBoard(tx, { tenantId, queueId: input.queueId });
        return { status: 200, body: toBody(row) };
      } catch (e) { return mapDbError(e); }
    },

    /** Q6. If-Match shape (428/400) -> body -> row lock + lookup (404) -> authorizeRow -> version (409) -> transition (409) -> conditional UPDATE. */
    async transition(ctx: QueueCtx, op: TokenOp, input: { id: unknown; headers: unknown; body: unknown; now: string; tz: string; authorizeRow: Authorize }): Promise<Out> {
      const { tx, tenantId, userId } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/id');
      const counterId = op === 'serve' && input.body !== undefined && input.body !== null ? (uuidBody(input.body, ['counter_id'], [])['counter_id'] ?? null) : null;
      try {
        const cur = await repo.lockToken(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        await input.authorizeRow(cur['centre_id']);
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        const o = OPS[op], from = cur['status'] as QueueTokenStatus;
        const today = businessDate(new Date(input.now), input.tz);
        const ok = o.from.includes(from) && canTransition(from, o.to)
          && (op !== 'recall' || (canRecall(cur['call_count']) && (from !== 'skipped' || cur['business_date'] === today))); // T-6: a skipped token is recalled the same day only
        if (!ok) throw new LimsError('engagement.queue_token_invalid_transition');
        if (counterId) await checkCounter(tx, tenantId, counterId, cur['centre_id']);
        const row = await repo.transition(tx, op, { tenantId, id: input.id, version: expected, from, userId, now: input.now, counterId });
        if (!row) throw new LimsError('common.version_conflict');
        await repo.bumpBoard(tx, { tenantId, queueId: cur['queue_id'] });
        return { status: 200, body: toBody(row) };
      } catch (e) { return mapDbError(e); }
    },

    /** Q7 (T-9): the new token is numbered in the target queue first (the old row's transferred_to FK needs it), then the old one is closed; both in this transaction. */
    async transfer(ctx: QueueCtx, input: { id: unknown; headers: unknown; body: unknown; now: string; tz: string; authorizeRow: Authorize }): Promise<Out> {
      const { tx, tenantId, userId } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/id');
      const toQueueId = uuidBody(input.body, ['to_queue_id'], ['to_queue_id'])['to_queue_id']!;
      try {
        const cur = await repo.lockToken(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        await input.authorizeRow(cur['centre_id']);
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        if (!['waiting', 'called', 'serving'].includes(cur['status'])) throw new LimsError('engagement.queue_token_invalid_transition');
        const target = await repo.getQueue(tx, { tenantId, id: toQueueId });
        if (!target) throw new LimsError('common.not_found');
        if (target['id'] === cur['queue_id'] || target['centre_id'] !== cur['centre_id']) invalid('/to_queue_id', 'common.field_invalid', 'Target queue not allowed');
        await assertOpen(tx, tenantId, target);
        const fresh = await take(tx, tenantId, userId, target, { now: input.now, tz: input.tz, priority: cur['priority'], bookingId: cur['booking_id'] ?? null, fromTokenId: cur['id'] });
        const from = await repo.markTransferred(tx, { tenantId, id: cur['id'], version: expected, toId: fresh['id'], userId });
        if (!from) throw new LimsError('common.version_conflict'); // cannot happen under the row lock
        await repo.bumpBoard(tx, { tenantId, queueId: cur['queue_id'] });
        await repo.bumpBoard(tx, { tenantId, queueId: target['id'] });
        return { status: 200, body: { from: toBody(from), to: toBody(fresh) } };
      } catch (e) { return mapDbError(e); }
    },
  };
}
export type TokenService = ReturnType<typeof createTokenService>;
