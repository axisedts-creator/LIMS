// Q8 listQueueDisplays / pairQueueDisplay / revokeQueueDisplay and Q9 getQueueBoard (02-TRD §4.10, §5; 01-PRD US-EN-22.1-5; 07-SECURITY REQ-SEC-017 device, AB-8, §6.3/§6.4).
// Tenant and actor come from ctx only. The plaintext display token exists only in the 201 body of Q8 pair; the DB gets its SHA-256 (08 R24).
import { randomToken, sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';
import { LimsError } from '../../../core/errors.js';
import * as defaultRepo from '../repository/display.repo.js';
import { invalid, isUuid, parseIfMatch, type QueueCtx } from './queue.service.js';

export type DisplayRepo = typeof defaultRepo;
type Row = Record<string, any>;
type Out = { status: number; body?: unknown; headers?: Record<string, string> };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (v: unknown) => new Date(v as string).toISOString();
const WINDOW_MS = 30 * 60_000; // TRD §4.10: now_calling = called/serving within the last 30 minutes
const DEFAULT_HISTORY = 5;

function scope(ctx: QueueCtx): { tx: Tx; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as Tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}
/** Row -> QueueDisplay: contract fields only (no token hash, tenant, audit columns); null times are omitted. */
function toBody(r: Row): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r['id'], centre_id: r['centre_id'], display_name: r['display_name'], queue_ids: r['queue_ids'], status: r['status'], paired_at: iso(r['paired_at']) };
  if (r['last_seen_at']) o['last_seen_at'] = iso(r['last_seen_at']);
  if (r['revoked_at']) o['revoked_at'] = iso(r['revoked_at']);
  o['version'] = r['version'];
  return o;
}
function pairBody(body: unknown): { centreId: string; name: string; queueIds: string[] } {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!['centre_id', 'display_name', 'queue_ids'].includes(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
  for (const k of ['centre_id', 'display_name', 'queue_ids']) if (body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  const { centre_id: c, display_name: n, queue_ids: q } = body;
  if (!isUuid(c)) invalid('/centre_id');
  if (typeof n !== 'string' || n.length < 1 || n.length > 40) invalid('/display_name');
  if (!Array.isArray(q) || q.length < 1 || q.length > 10 || !q.every(isUuid) || new Set(q.map((x) => x.toLowerCase())).size !== q.length) invalid('/queue_ids');
  return { centreId: c as string, name: n as string, queueIds: q as string[] };
}
/** FK / RLS failures mean the target is not visible to this actor; anything else unexpected fails closed without SQL text. */
function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23503' || code === '42501') throw new LimsError('common.not_found');
  throw new LimsError('common.internal');
}

export function createDisplayService(deps: { repo?: DisplayRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  return {
    /** Q8 list: the handler asserted manage (+ the named centre); RLS limits the rest. */
    async list(ctx: QueueCtx, input: { centreId: string | undefined }): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      const rows = await repo.listDisplays(tx, { tenantId, ...(input.centreId ? { centreId: input.centreId } : {}) });
      return { status: 200, body: { data: rows.map(toBody) } };
    },

    /** Q8 pair: body (400) -> centre and queues belong to this tenant/centre (404, identical for foreign and unknown) -> INSERT hash -> 201 with the one-time token. */
    async pair(ctx: QueueCtx, input: { body: unknown; now: string }): Promise<Out> {
      const { tx, tenantId, userId } = scope(ctx);
      const b = pairBody(input.body);
      try {
        const queues = await repo.centreQueues(tx, { tenantId, centreId: b.centreId, ids: b.queueIds });
        if (queues.length !== b.queueIds.length) throw new LimsError('common.not_found'); // also covers a centre that is not ours: it has no queues here
        const token = randomToken(32);
        const row = await repo.insertDisplay(tx, { id: uuidv7(), tenantId, centreId: b.centreId, name: b.name, queueIds: b.queueIds, tokenSha256: sha256Bytes(token), now: input.now, userId });
        return { status: 201, body: { display: toBody(row), display_token: token } };
      } catch (e) { return mapDbError(e); }
    },

    /** Q8 revoke: If-Match shape (428/400) -> id (400) -> row (404, scope-hidden rows included) -> authorizeRow -> version (409) -> UPDATE. Already revoked = 200 unchanged. */
    async revoke(ctx: QueueCtx, input: { id: unknown; headers: unknown; now: string; authorizeRow: (centreId: string) => Promise<void> }): Promise<Out> {
      const { tx, tenantId, userId } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/id');
      try {
        const cur = await repo.getDisplay(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        await input.authorizeRow(cur['centre_id']);
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        if (cur['status'] === 'revoked') return { status: 200, body: toBody(cur) };
        const row = await repo.revokeDisplay(tx, { tenantId, id: input.id, version: expected, now: input.now, userId });
        if (!row) throw new LimsError('common.version_conflict');
        return { status: 200, body: toBody(row) };
      } catch (e) { return mapDbError(e); }
    },

    /**
     * Q9: display row of the caller (revoked/unknown -> 401) -> ETag from the queues' board_version -> 304 when If-None-Match matches (nothing else read)
     * -> 200 board of labels/names/counts only. Read-only: the board never writes.
     */
    async board(ctx: QueueCtx, input: { headers: unknown; now: string }): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      const d = await repo.getDisplay(tx, { tenantId, id: ctx.actor.id });
      if (!d || d['status'] !== 'active') throw new LimsError('auth.unauthenticated'); // revoked after the resolver ran (US-EN-22.4)
      const centreId: string = d['centre_id'];
      const queues = await repo.centreQueues(tx, { tenantId, centreId, ids: d['queue_ids'] }); // never another centre's queue, even if named
      const version = queues.reduce((m, q) => Math.max(m, Number(q['board_version'])), 0);
      const etag = `"${version}"`;
      const inm = isObj(input.headers) ? input.headers['if-none-match'] : undefined;
      if (typeof inm === 'string' && inm.split(',').some((p) => p.trim().replace(/^W\//, '') === etag)) return { status: 304, headers: { etag } };

      const ids = queues.map((q) => q['id'] as string);
      const hc = await repo.historyCount(tx, tenantId);
      const limit = Number.isInteger(hc) && hc! >= 1 && hc! <= 50 ? hc! : DEFAULT_HISTORY;
      const since = new Date(Date.parse(input.now) - WINDOW_MS).toISOString();
      const calls = ids.length ? await repo.recentCalls(tx, { tenantId, centreId, queueIds: ids, since, limit }) : [];
      const qName = new Map(queues.map((q) => [q['id'], q['display_name'] as string]));
      const kName = new Map((await repo.counterNames(tx, { tenantId, centreId })).map((k) => [k['id'], k['display_name'] as string]));
      // ponytail: one count per queue (<= 10); tokens left waiting from a past day are expired by the close_queue_day task, so no date filter here.
      const waiting = [];
      for (const q of queues) waiting.push({ queue_display_name: q['display_name'], waiting_count: await repo.waitingCount(tx, { tenantId, centreId, queueId: q['id'] }) });
      const body = {
        centre_display_name: (await repo.centreName(tx, { tenantId, centreId })) ?? '',
        board_version: version,
        generated_at: input.now,
        now_calling: calls.map((t) => ({ token_label: t['token_label'], counter_display_name: kName.get(t['counter_id']) ?? '', queue_display_name: qName.get(t['queue_id']) ?? '', called_at: iso(t['called_at']) })),
        waiting,
      };
      return { status: 200, body, headers: { etag } };
    },
  };
}
export type DisplayService = ReturnType<typeof createDisplayService>;
