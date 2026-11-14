// C9 T-19 repository for the TAT clocks (02-TRD §9.1-§9.3, §10.3 purge predicate, §5.7 #48-#50; 05-SCHEMA tat_items / tat_alert_events / tat_alert_acks, §5 RLS, §7 retention; 08 A17 D-59, P-18(c), P-21).
// Every method is ONE statement (batched with jsonb_to_recordset / unnest / ANY) except `ack` (one CTE statement), so a sweep costs a bounded number of statements. Every statement is parameterised and
// names tenant_id = $n on top of RLS (REQ-SEC-024). Timestamps leave as ISO text with milliseconds. Other modules are read ONLY through their published views (02-CV §5.13): lab.v_pub_pending_items,
// lab.v_pub_specimen_timeline, reporting.v_pub_order_report_tat. Postgres errors pass through unchanged (the service maps them).
// [CONV] listMembershipLabels reads core.memberships + core.users (core tables are read by every module, 03-IC §6 global note; no core.v_pub_* view exists) — see .orchestra/cr/C9.T-19.nonblocking.md.
import { LimsError } from '../../../core/errors.js';

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export interface PendingRow { order_item_id: string; test_id: string; specimen_id: string; order_id: string; centre_id: string; department_id: string | null; priority: 'routine' | 'urgent'; item_status: string; received_at: string | null; tat_target_seconds: number | null }
export interface TatItemRow {
  id: string; version: number; centre_id: string; order_id: string; order_item_id: string; test_id: string; specimen_id: string; department_id: string | null; priority: 'routine' | 'urgent'; segment: 'within_lab' | 'total'; target_seconds: number;
  start_basis: string; state: string; started_at: string | null; stopped_at: string | null; stop_source: string | null; restart_count: number; first_verified_at: string | null; in_pending_view: boolean; left_pending_view_at: string | null;
  last_seen_sweep_at: string; alert_level: string; alert_level_at: string | null; acknowledged_level: string | null; acknowledged_at: string | null; acknowledged_by: string | null; expires_at: string | null;
}
export interface EventRow { tat_item_id: string; centre_id: string; level: string; raised_at: string; elapsed_seconds: number; restart_no: number }
export interface AckRow { tat_item_id: string; centre_id: string; level: string; note: string | null; acknowledged_by_membership_id: string; created_at: string; created_by: string }
export interface AlertFilter { levels?: string[]; acknowledged?: boolean; segment?: string; departmentId?: string; centreId?: string; priority?: string; sort: '-alert_level_rank' | '-pct_of_target' | 'started_at'; now: string }
type Row = Record<string, any>;

export interface TatRepo {
  /** lab.v_pub_pending_items WHERE tenant AND tat_target_seconds IS NOT NULL (+ order_id when given). */
  listPending(tx: Tx, t: string, o: { orderId?: string }): Promise<PendingRow[]>;
  /** reporting.v_pub_order_report_tat: registered_at per order (orders the view does not know are absent). */
  listTotalStarts(tx: Tx, t: string, orderIds: string[]): Promise<Array<{ order_id: string; registered_at: string }>>;
  /** lab.v_pub_specimen_timeline: min(ordered_at) per order. */
  listEarliestOrdered(tx: Tx, t: string, orderIds: string[]): Promise<Array<{ order_id: string; ordered_at: string }>>;
  findItems(tx: Tx, t: string, keys: Array<{ order_item_id: string; test_id: string }>): Promise<TatItemRow[]>;
  /** state in (not_started, running); order filter optional. */
  listOpenItems(tx: Tx, t: string, o: { orderId?: string }): Promise<TatItemRow[]>;
  listItemsByOrder(tx: Tx, t: string, orderId: string): Promise<TatItemRow[]>;
  /** INSERT ... ON CONFLICT (tenant_id, order_item_id, test_id) DO NOTHING RETURNING *: only rows really inserted come back (a concurrent creator wins). */
  insertItems(tx: Tx, t: string, actorId: string, rows: Array<Omit<TatItemRow, 'id' | 'version'>>): Promise<TatItemRow[]>;
  /** Applies `set` (DB column names, allow-listed) and bumps version by 1 for every patch; returns rows updated. */
  updateItems(tx: Tx, t: string, actorId: string, patches: Array<{ id: string; set: Row }>): Promise<number>;
  /** last_seen_sweep_at only; MUST NOT bump version (a minute tick must not invalidate a user's If-Match). */
  touchSeen(tx: Tx, t: string, ids: string[], at: string): Promise<number>;
  /** ON CONFLICT (tenant_id, tat_item_id, restart_no, level) DO NOTHING. */
  insertAlertEvents(tx: Tx, t: string, actorId: string, rows: EventRow[]): Promise<number>;
  deleteExpired(tx: Tx, t: string, nowIso: string): Promise<number>;
  listAlerts(tx: Tx, t: string, f: AlertFilter, page: { cursor?: string; limit: number }): Promise<{ rows: TatItemRow[]; nextCursor?: string }>;
  getItem(tx: Tx, t: string, id: string): Promise<TatItemRow | undefined>;
  listLevelEvents(tx: Tx, t: string, id: string): Promise<EventRow[]>;
  listAcks(tx: Tx, t: string, id: string): Promise<AckRow[]>;
  ack(tx: Tx, t: string, a: { id: string; expectedVersion: number; level: string; note: string | null; at: string; membershipId: string; actorId: string }): Promise<TatItemRow | undefined>;
  listMembershipLabels(tx: Tx, t: string, ids: string[]): Promise<Array<{ membership_id: string; display: string }>>;
}

const MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;   // microseconds: exact keyset position
const tsMs = (expr: string, as: string) => `to_char(${expr} AT TIME ZONE 'UTC', ${MS}) AS ${as}`;
const count = (r: { rows: any[]; rowCount?: number | null }): number => r.rowCount ?? r.rows.length;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;
const rank = (c: string) => `(CASE ${c} WHEN 'warning' THEN 1 WHEN 'breached' THEN 2 WHEN 'escalated' THEN 3 ELSE 0 END)`;

/** Column -> SQL type of tat_items (05-SCHEMA). Order = the column order of the inserts. */
const TYPES: Record<string, string> = {
  centre_id: 'uuid', order_id: 'uuid', order_item_id: 'uuid', test_id: 'uuid', specimen_id: 'uuid', department_id: 'uuid', priority: 'text', segment: 'text', target_seconds: 'integer', start_basis: 'text', state: 'text',
  started_at: 'timestamptz', stopped_at: 'timestamptz', stop_source: 'text', restart_count: 'integer', first_verified_at: 'timestamptz', in_pending_view: 'boolean', left_pending_view_at: 'timestamptz',
  last_seen_sweep_at: 'timestamptz', alert_level: 'text', alert_level_at: 'timestamptz', acknowledged_level: 'text', acknowledged_at: 'timestamptz', acknowledged_by: 'uuid', expires_at: 'timestamptz',
};
const INSERT_COLS = Object.keys(TYPES);
/** Columns an UPDATE may set: the mutable clock state. Never tenant_id, id, created_*, version (the statement owns it) or the identity columns of the row. */
const SETTABLE = ['state', 'started_at', 'stopped_at', 'stop_source', 'restart_count', 'first_verified_at', 'in_pending_view', 'left_pending_view_at', 'last_seen_sweep_at', 'alert_level', 'alert_level_at',
  'acknowledged_level', 'acknowledged_at', 'acknowledged_by', 'expires_at', 'specimen_id', 'start_basis'] as const;
const TS_COLS = new Set(Object.keys(TYPES).filter((c) => TYPES[c] === 'timestamptz'));
const PLAIN = ['id', 'version', ...INSERT_COLS.filter((c) => !TS_COLS.has(c))];
const itemCols = (p = '') => [...PLAIN.map((c) => `${p}${c}`), ...[...TS_COLS].map((c) => tsMs(`${p}${c}`, c))].join(', ');
const NAMES = [...PLAIN, ...TS_COLS].join(', ');
const EVENT_COLS = `tat_item_id, centre_id, level, ${tsMs('raised_at', 'raised_at')}, elapsed_seconds, restart_no`;
const ACK_COLS = `tat_item_id, centre_id, level, note, acknowledged_by_membership_id, ${tsMs('created_at', 'created_at')}, created_by`;

const SORTS = { '-alert_level_rank': 'lvl_rank DESC, pct_key DESC, id ASC', '-pct_of_target': 'pct_key DESC, id ASC', started_at: 'started_at ASC, id ASC' } as const;

interface Cursor { now: string; k1: number | string; k2: number | null; id: string }
const encodeCursor = (sort: string, c: Cursor): string => Buffer.from(JSON.stringify(['c', sort, c.now, c.k1, c.k2, c.id]), 'utf8').toString('base64url');
function decodeCursor(raw: string, sort: string): Cursor {
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(v) || v.length !== 6 || v[0] !== 'c' || v[1] !== sort || typeof v[2] !== 'string' || !ISO.test(v[2]) || typeof v[5] !== 'string' || !UUID.test(v[5])) throw bad();
  const byStart = sort === 'started_at';
  if (byStart ? typeof v[3] !== 'string' || !ISO.test(v[3]) : !Number.isSafeInteger(v[3])) throw bad();
  if (sort === '-alert_level_rank' ? !Number.isSafeInteger(v[4]) : v[4] !== null) throw bad();
  return { now: v[2], k1: v[3], k2: v[4], id: v[5] };
}

/** Unqualified column names on purpose: every statement is on a single table (or a CTE of it). */
export function createTatRepo(): TatRepo {
  return {
    async listPending(tx, t, o) {
      const values: unknown[] = [t];
      const order = o.orderId !== undefined ? (values.push(o.orderId), ` AND p.order_id = $${values.length}::uuid`) : '';
      return (await tx.query(
        `SELECT p.order_item_id, p.test_id, p.specimen_id, p.order_id, p.centre_id, p.department_id, p.priority, p.item_status, ${tsMs('p.received_at', 'received_at')}, p.tat_target_seconds
           FROM lab.v_pub_pending_items p WHERE p.tenant_id = $1 AND p.tat_target_seconds IS NOT NULL${order}`, values)).rows;
    },

    async listTotalStarts(tx, t, orderIds) {
      return (await tx.query(
        `SELECT order_id, ${tsMs('registered_at', 'registered_at')} FROM reporting.v_pub_order_report_tat WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) AND registered_at IS NOT NULL`, [t, orderIds])).rows;
    },

    async listEarliestOrdered(tx, t, orderIds) {
      return (await tx.query(
        `SELECT order_id, ${tsMs('min(ordered_at)', 'ordered_at')} FROM lab.v_pub_specimen_timeline WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) AND ordered_at IS NOT NULL GROUP BY order_id`, [t, orderIds])).rows;
    },

    async findItems(tx, t, keys) {
      if (keys.length === 0) return [];
      return (await tx.query(
        `SELECT ${itemCols()} FROM quality.tat_items WHERE tenant_id = $1 AND (order_item_id, test_id) IN (SELECT k.a, k.b FROM unnest($2::uuid[], $3::uuid[]) AS k(a, b))`,
        [t, keys.map((k) => k.order_item_id), keys.map((k) => k.test_id)])).rows;
    },

    async listOpenItems(tx, t, o) {
      const values: unknown[] = [t];
      const order = o.orderId !== undefined ? (values.push(o.orderId), ` AND order_id = $${values.length}::uuid`) : '';
      return (await tx.query(`SELECT ${itemCols()} FROM quality.tat_items WHERE tenant_id = $1 AND state IN ('not_started', 'running')${order}`, values)).rows;
    },

    async listItemsByOrder(tx, t, orderId) {
      return (await tx.query(`SELECT ${itemCols()} FROM quality.tat_items WHERE tenant_id = $1 AND order_id = $2::uuid`, [t, orderId])).rows;
    },

    /** The id is generated in SQL; the recordset carries the tenant so the explicit predicate `r.tenant_id = $1` filters the batch (a row of another tenant can never be inserted). */
    async insertItems(tx, t, actorId, rows) {
      if (rows.length === 0) return [];
      const json = JSON.stringify(rows.map((r) => ({ tenant_id: t, ...Object.fromEntries(INSERT_COLS.map((c) => [c, (r as Row)[c] ?? null])) })));
      return (await tx.query(
        `INSERT INTO quality.tat_items (id, tenant_id, ${INSERT_COLS.join(', ')}, created_by, updated_by)
         SELECT app.uuidv7(), r.tenant_id, ${INSERT_COLS.map((c) => `r.${c}`).join(', ')}, $3::uuid, $3::uuid
           FROM jsonb_to_recordset($2::jsonb) AS r(tenant_id uuid, ${INSERT_COLS.map((c) => `${c} ${TYPES[c]}`).join(', ')}) WHERE r.tenant_id = $1::uuid
         ON CONFLICT (tenant_id, order_item_id, test_id) DO NOTHING RETURNING ${itemCols()}`, [t, json, actorId])).rows;
    },

    /** One UPDATE for all patches: each allow-listed column keeps its value unless the patch names it (a named null clears it). */
    async updateItems(tx, t, actorId, patches) {
      if (patches.length === 0) return 0;
      for (const p of patches) {
        if (typeof p.id !== 'string' || !UUID.test(p.id) || Object.keys(p.set).some((k) => !(SETTABLE as readonly string[]).includes(k))) throw new LimsError('common.internal');
      }
      const sets = SETTABLE.map((c) => `${c} = CASE WHEN jsonb_exists(p.s, '${c}') THEN (p.s->>'${c}')::${TYPES[c]} ELSE t.${c} END`);
      return count(await tx.query(
        `UPDATE quality.tat_items t SET ${sets.join(', ')}, version = t.version + 1, updated_by = $3::uuid, updated_at = now()
           FROM (SELECT (e->>'id')::uuid AS id, e->'set' AS s FROM jsonb_array_elements($2::jsonb) AS e) p
          WHERE t.tenant_id = $1 AND t.id = p.id`, [t, JSON.stringify(patches.map((p) => ({ id: p.id, set: p.set }))), actorId]));
    },

    async touchSeen(tx, t, ids, at) {
      if (ids.length === 0) return 0;
      return count(await tx.query(`UPDATE quality.tat_items SET last_seen_sweep_at = $3::timestamptz WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [t, ids, at]));
    },

    /** Joined to the parent item: the tenant predicate sits on the item, and an invisible (RLS) or unknown item yields no event. */
    async insertAlertEvents(tx, t, actorId, rows) {
      if (rows.length === 0) return 0;
      const res = await tx.query(
        `INSERT INTO quality.tat_alert_events (id, tenant_id, centre_id, tat_item_id, level, raised_at, elapsed_seconds, restart_no, created_by)
         SELECT app.uuidv7(), i.tenant_id, i.centre_id, i.id, r.level, r.raised_at, r.elapsed_seconds, r.restart_no, $3::uuid
           FROM jsonb_to_recordset($2::jsonb) AS r(tat_item_id uuid, level text, raised_at timestamptz, elapsed_seconds integer, restart_no integer)
           JOIN quality.tat_items i ON i.tenant_id = $1 AND i.id = r.tat_item_id
         ON CONFLICT (tenant_id, tat_item_id, restart_no, level) DO NOTHING RETURNING id`,
        [t, JSON.stringify(rows.map((r) => ({ tat_item_id: r.tat_item_id, level: r.level, raised_at: r.raised_at, elapsed_seconds: r.elapsed_seconds, restart_no: r.restart_no }))), actorId]);
      return count(res);
    },

    /** P-18(c): expired rows without alert events or acks; `expires_at IS NULL` never matches (strict comparison). The cut-off is a bound parameter (the caller's clock). */
    async deleteExpired(tx, t, nowIso) {
      return count(await tx.query(
        `DELETE FROM quality.tat_items t WHERE t.tenant_id = $1 AND t.expires_at < $2::timestamptz
            AND NOT EXISTS (SELECT 1 FROM quality.tat_alert_events e WHERE e.tenant_id = t.tenant_id AND e.tat_item_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM quality.tat_alert_acks a WHERE a.tenant_id = t.tenant_id AND a.tat_item_id = t.id)`, [t, nowIso]));
    },

    /** Open alerts = running clocks at warning or above. The order-by comes from a fixed list; the cursor carries the instant of the first page so the percentage order is stable across pages. */
    async listAlerts(tx, t, f, page) {
      const order = Object.hasOwn(SORTS, f.sort) ? SORTS[f.sort] : undefined;
      if (!order) throw new LimsError('common.validation_failed');
      const cur = page.cursor !== undefined ? decodeCursor(page.cursor, f.sort) : undefined;
      const values: unknown[] = [t];
      const bind = (v: unknown, cast = '') => { values.push(v); return `$${values.length}${cast}`; };
      const nowP = bind(cur?.now ?? f.now, '::timestamptz');
      const where = ['tenant_id = $1', `state = 'running'`, `alert_level <> 'none'`];
      if (f.levels !== undefined) where.push(`alert_level = ANY(${bind(f.levels, '::text[]')})`);
      if (f.acknowledged !== undefined) {
        const covered = `(acknowledged_level IS NOT NULL AND ${rank('acknowledged_level')} >= ${rank('alert_level')})`;   // an ack at warning does not cover breached
        where.push(f.acknowledged ? covered : `NOT ${covered}`);
      }
      if (f.segment !== undefined) where.push(`segment = ${bind(f.segment)}`);
      if (f.departmentId !== undefined) where.push(`department_id = ${bind(f.departmentId, '::uuid')}`);
      if (f.centreId !== undefined) where.push(`centre_id = ${bind(f.centreId, '::uuid')}`);
      if (f.priority !== undefined) where.push(`priority = ${bind(f.priority)}`);
      const after: string[] = [];
      if (cur) {
        const id = bind(cur.id, '::uuid');
        if (f.sort === '-alert_level_rank') { const a = bind(cur.k1), b = bind(cur.k2); after.push(`(lvl_rank < ${a} OR (lvl_rank = ${a} AND (pct_key < ${b} OR (pct_key = ${b} AND id > ${id}))))`); }
        else if (f.sort === '-pct_of_target') { const a = bind(cur.k1); after.push(`(pct_key < ${a} OR (pct_key = ${a} AND id > ${id}))`); }
        else { const a = bind(cur.k1, '::timestamptz'); after.push(`(started_at > ${a} OR (started_at = ${a} AND id > ${id}))`); }
      }
      const limit = bind(page.limit + 1);
      const { rows } = await tx.query(
        `SELECT * FROM (SELECT ${itemCols()}, ${rank('alert_level')} AS lvl_rank,
                 COALESCE(floor(extract(epoch FROM (${nowP} - started_at)) * 100 / target_seconds), 0)::bigint AS pct_key, to_char(started_at AT TIME ZONE 'UTC', ${US}) AS started_key
            FROM quality.tat_items WHERE ${where.join(' AND ')}) x${after.length ? ` WHERE ${after.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${limit}`, values);
      const strip = (r: Row): TatItemRow => { const { lvl_rank: _l, pct_key: _p, started_key: _s, ...rest } = r; return rest as TatItemRow; };
      if (rows.length <= page.limit) return { rows: rows.map(strip) };
      const kept = rows.slice(0, page.limit), last = kept[kept.length - 1]!;
      const k1 = f.sort === '-alert_level_rank' ? Number(last['lvl_rank']) : f.sort === '-pct_of_target' ? Number(last['pct_key']) : last['started_key'];
      return { rows: kept.map(strip), nextCursor: encodeCursor(f.sort, { now: cur?.now ?? f.now, k1, k2: f.sort === '-alert_level_rank' ? Number(last['pct_key']) : null, id: last['id'] }) };
    },

    async getItem(tx, t, id) {
      return (await tx.query(`SELECT ${itemCols()} FROM quality.tat_items WHERE tenant_id = $1 AND id = $2::uuid`, [t, id])).rows[0];
    },

    async listLevelEvents(tx, t, id) {
      return (await tx.query(
        `SELECT ${EVENT_COLS} FROM quality.tat_alert_events WHERE tenant_id = $1 AND tat_item_id = $2::uuid ORDER BY restart_no, raised_at, ${rank('level')}, id`, [t, id])).rows;
    },

    async listAcks(tx, t, id) {
      return (await tx.query(`SELECT ${ACK_COLS} FROM quality.tat_alert_acks WHERE tenant_id = $1 AND tat_item_id = $2::uuid ORDER BY created_at, id`, [t, id])).rows;
    },

    /** ONE statement: the item UPDATE (guarded by version = expected; RLS hides foreign centres) and, only when it hit a row, the ack INSERT selected FROM that update's RETURNING. No row back = lost race / invisible. */
    async ack(tx, t, a) {
      const { rows } = await tx.query(
        `WITH u AS (
           UPDATE quality.tat_items SET acknowledged_level = $4, acknowledged_at = $6::timestamptz, acknowledged_by = $7::uuid, version = version + 1, updated_by = $8::uuid, updated_at = now()
            WHERE tenant_id = $1 AND id = $2::uuid AND version = $3::integer
           RETURNING tenant_id, ${itemCols()}),
         a AS (
           INSERT INTO quality.tat_alert_acks (id, tenant_id, centre_id, tat_item_id, level, note, acknowledged_by_membership_id, created_at, created_by)
           SELECT app.uuidv7(), u.tenant_id, u.centre_id, u.id, $4, $5, $7::uuid, $6::timestamptz, $8::uuid FROM u)
         SELECT ${NAMES} FROM u`, [t, a.id, a.expectedVersion, a.level, a.note, a.at, a.membershipId, a.actorId]);
      return rows[0];
    },

    async listMembershipLabels(tx, t, ids) {
      if (ids.length === 0) return [];
      return (await tx.query(
        `SELECT m.id AS membership_id, u.display_name AS display FROM core.memberships m JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id WHERE m.tenant_id = $1 AND m.id = ANY($2::uuid[])`, [t, ids])).rows;
    },
  };
}
