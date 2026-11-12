// engagement.queue_displays (Q8, Q9 display lookup) + the board reads of queue_definitions / queue_tokens / queue_counters / booking_centres / settings (02-TRD §4.10, §5 Q8/Q9).
// Table matrix: queue_displays S I U (no DELETE). REQ-SEC-024: every statement binds tenant_id. Static SQL only; values are parameters. token_sha256 is never selected.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;

const COLS = 'id, centre_id, display_name, queue_ids, status, paired_at, last_seen_at, revoked_at, version';

export async function getDisplay(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.queue_displays WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}
export async function listDisplays(tx: Q, a: { tenantId: string; centreId?: string }): Promise<Row[]> {
  const { rows } = a.centreId
    ? await tx.query(`SELECT ${COLS} FROM engagement.queue_displays WHERE tenant_id = $1 AND centre_id = $2 ORDER BY paired_at DESC, id LIMIT 200`, [a.tenantId, a.centreId])
    : await tx.query(`SELECT ${COLS} FROM engagement.queue_displays WHERE tenant_id = $1 ORDER BY paired_at DESC, id LIMIT 200`, [a.tenantId]);
  return rows;
}
export async function insertDisplay(tx: Q, a: { id: string; tenantId: string; centreId: string; name: string; queueIds: string[]; tokenSha256: Uint8Array; now: string; userId: string }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.queue_displays (id, tenant_id, centre_id, display_name, queue_ids, token_sha256, status, paired_at, paired_by, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6, 'active', $7, $8, 1, $8, $8) RETURNING ${COLS}`,
    [a.id, a.tenantId, a.centreId, a.name, a.queueIds, Buffer.from(a.tokenSha256), a.now, a.userId]);
  return rows[0];
}
/** Conditional on the version that was read: undefined = lost a race. */
export async function revokeDisplay(tx: Q, a: { tenantId: string; id: string; version: number; now: string; userId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.queue_displays SET status = 'revoked', revoked_at = $4, revoked_by = $5, version = version + 1, updated_at = now(), updated_by = $5
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'active' RETURNING ${COLS}`, [a.tenantId, a.id, a.version, a.now, a.userId]);
  return rows[0];
}

/** The queues of `ids` that belong to this centre (others, incl. other tenants', are simply absent). */
export async function centreQueues(tx: Q, a: { tenantId: string; centreId: string; ids: string[] }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT id, display_name, board_version FROM engagement.queue_definitions WHERE tenant_id = $1 AND centre_id = $2 AND id = ANY($3) ORDER BY sort_order, id', [a.tenantId, a.centreId, a.ids]);
  return rows;
}
export async function recentCalls(tx: Q, a: { tenantId: string; centreId: string; queueIds: string[]; since: string; limit: number }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT queue_id, counter_id, token_label, called_at FROM engagement.queue_tokens
     WHERE tenant_id = $1 AND centre_id = $2 AND queue_id = ANY($3) AND status IN ('called', 'serving') AND called_at > $4 ORDER BY called_at DESC LIMIT $5`,
    [a.tenantId, a.centreId, a.queueIds, a.since, a.limit]);
  return rows;
}
export async function waitingCount(tx: Q, a: { tenantId: string; centreId: string; queueId: string }): Promise<number> {
  const { rows } = await tx.query(
    "SELECT count(*) FROM engagement.queue_tokens WHERE tenant_id = $1 AND centre_id = $2 AND queue_id = $3 AND status = 'waiting'", [a.tenantId, a.centreId, a.queueId]);
  return Number(rows[0]?.count ?? 0);
}
export async function counterNames(tx: Q, a: { tenantId: string; centreId: string }): Promise<Row[]> {
  const { rows } = await tx.query('SELECT id, display_name FROM engagement.queue_counters WHERE tenant_id = $1 AND centre_id = $2', [a.tenantId, a.centreId]);
  return rows;
}
export async function centreName(tx: Q, a: { tenantId: string; centreId: string }): Promise<string | undefined> {
  const { rows } = await tx.query('SELECT display_name FROM engagement.booking_centres WHERE tenant_id = $1 AND centre_id = $2', [a.tenantId, a.centreId]);
  return rows[0]?.display_name;
}
export async function historyCount(tx: Q, tenantId: string): Promise<number | undefined> {
  const { rows } = await tx.query('SELECT queue_display_history_count FROM engagement.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0]?.queue_display_history_count;
}
