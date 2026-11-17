// engagement.queue_tokens / queue_day_counters (+ reads of queue_definitions, queue_counters, settings) for Q3-Q7 (02-TRD §4.10; 05-SCHEMA §2 queue; table matrix S I U: no DELETE).
// STAFF_C RLS scopes by centre; REQ-SEC-024: every statement still binds tenant_id. Static SQL only (the few optional fragments come from closed literals); values are parameters.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
export type TokenOp = 'recall' | 'serve' | 'complete' | 'skip' | 'cancel';

// business_date::text: the pg driver would turn a `date` into a local-midnight Date.
const COLS = 'id, queue_id, centre_id, business_date::text AS business_date, token_label, priority, status, booking_id, counter_id, issued_at, called_at, call_count, version';

export async function getQueue(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT id, centre_id, token_prefix, is_active FROM engagement.queue_definitions WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id]);
  return rows[0];
}
export async function getCounter(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT id, centre_id, is_active FROM engagement.queue_counters WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.id]);
  return rows[0];
}
/** No settings row = feature never switched on = off. */
export async function queueEnabled(tx: Q, tenantId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT queue_enabled FROM engagement.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0]?.queue_enabled === true;
}

/** Row-locked read: a concurrent writer of the same token waits here and then sees its result (never a stale version). */
export async function lockToken(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.queue_tokens WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [a.tenantId, a.id]);
  return rows[0];
}

/** TRD §4.10: row created if absent, then the increment takes the row lock, so issuers of one queue/day are serialised and every seq is distinct. */
export async function nextSeq(tx: Q, a: { tenantId: string; queueId: string; centreId: string; date: string; userId: string }): Promise<number> {
  await tx.query(
    `INSERT INTO engagement.queue_day_counters (tenant_id, queue_id, centre_id, business_date, last_seq, created_by)
     VALUES ($1, $2, $3, $4::date, 0, $5) ON CONFLICT DO NOTHING`, [a.tenantId, a.queueId, a.centreId, a.date, a.userId]);
  const { rows } = await tx.query(
    'UPDATE engagement.queue_day_counters SET last_seq = last_seq + 1, updated_at = now() WHERE tenant_id = $1 AND queue_id = $2 AND business_date = $3::date RETURNING last_seq',
    [a.tenantId, a.queueId, a.date]);
  return rows[0].last_seq;
}

export async function insertToken(tx: Q, a: { tenantId: string; centreId: string; queueId: string; date: string; seq: number; label: string; priority: string; bookingId: string | null; issuedAt: string; fromTokenId: string | null; userId: string }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.queue_tokens (id, tenant_id, centre_id, queue_id, business_date, seq, token_label, priority, status, booking_id, issued_at, call_count, transferred_from_token_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, 'waiting', $9, $10, 0, $11, $12, $12) RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, a.centreId, a.queueId, a.date, a.seq, a.label, a.priority, a.bookingId, a.issuedAt, a.fromTokenId, a.userId]);
  return rows[0];
}

/** Oldest waiting token of the queue/day, priority first; rows locked by another call-next are skipped (AB-15). */
export async function nextWaiting(tx: Q, a: { tenantId: string; queueId: string; date: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT id FROM engagement.queue_tokens WHERE tenant_id = $1 AND queue_id = $2 AND business_date = $3::date AND status = 'waiting'
     ORDER BY priority DESC, issued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [a.tenantId, a.queueId, a.date]);
  return rows[0];
}
export async function callToken(tx: Q, a: { tenantId: string; id: string; counterId: string; now: string; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.queue_tokens SET status = 'called', counter_id = $3, called_at = $4, call_count = 1, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND id = $2 AND status = 'waiting' RETURNING ${COLS}`, [a.tenantId, a.id, a.counterId, a.now, a.userId]);
  return rows[0];
}

// op -> SET list ($6, $7 = extras) + extra guard. $1 tenant, $2 id, $3 expected version, $4 current status, $5 actor.
const OPS: Readonly<Record<TokenOp, { set: string; guard: string; extras: 0 | 1 | 2 }>> = {
  recall: { set: "status = 'called', called_at = $6, call_count = call_count + 1", guard: ' AND call_count < 9', extras: 1 },
  serve: { set: "status = 'serving', serving_started_at = $6, counter_id = COALESCE($7, counter_id)", guard: '', extras: 2 },
  complete: { set: "status = 'completed', completed_at = $6", guard: '', extras: 1 },
  skip: { set: "status = 'skipped'", guard: '', extras: 0 },
  cancel: { set: "status = 'cancelled'", guard: '', extras: 0 },
};
/** Conditional on version AND the status that was read: undefined = lost a race. */
export async function transition(tx: Q, op: TokenOp, a: { tenantId: string; id: string; version: number; from: string; userId: string; now: string; counterId: string | null }): Promise<Row | undefined> {
  const o = OPS[op];
  const extra = [a.now, a.counterId].slice(0, o.extras);
  const { rows } = await tx.query(
    `UPDATE engagement.queue_tokens SET ${o.set}, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = $4${o.guard} RETURNING ${COLS}`, [a.tenantId, a.id, a.version, a.from, a.userId, ...extra]);
  return rows[0];
}
export async function markTransferred(tx: Q, a: { tenantId: string; id: string; version: number; toId: string; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.queue_tokens SET status = 'transferred', transferred_to_token_id = $4, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status IN ('waiting', 'called', 'serving') RETURNING ${COLS}`, [a.tenantId, a.id, a.version, a.toId, a.userId]);
  return rows[0];
}

/** The display board ETag (not the Q1c `version`). */
export async function bumpBoard(tx: Q, a: { tenantId: string; queueId: string }): Promise<void> {
  await tx.query('UPDATE engagement.queue_definitions SET board_version = board_version + 1 WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.queueId]);
}

/** Keyset on id (uuidv7 = issue order); `limit` is already bounded by the caller. */
export async function listTokens(tx: Q, a: { tenantId: string; centreId: string; date: string; queueId?: string; status?: string; afterId?: string; limit: number }): Promise<Row[]> {
  const v: unknown[] = [a.tenantId, a.centreId, a.date];
  let sql = `SELECT ${COLS} FROM engagement.queue_tokens WHERE tenant_id = $1 AND centre_id = $2 AND business_date = $3::date`;
  if (a.queueId) { v.push(a.queueId); sql += ` AND queue_id = $${v.length}`; }
  if (a.status) { v.push(a.status); sql += ` AND status = $${v.length}`; }
  if (a.afterId) { v.push(a.afterId); sql += ` AND id > $${v.length}`; }
  v.push(a.limit);
  const { rows } = await tx.query(`${sql} ORDER BY id LIMIT $${v.length}`, v);
  return rows;
}
