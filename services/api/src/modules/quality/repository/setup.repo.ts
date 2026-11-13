// C9 T-06 repo: quality.control_materials / _levels / _lots / _id_maps (05-SCHEMA §2) + instruments.v_pub_instrument_directory (labels only).
// Every statement is parameterised, schema-qualified and carries `tenant_id = $1` explicitly on top of RLS (REQ-SEC-022/024, 02-CV §5.13). No deletes (AC-01.4).
// Dates leave the DB as text: expires_on 'YYYY-MM-DD', created_at ISO-8601 UTC with microseconds (keeps keyset cursors exact).
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export interface Page<T = Row> { rows: T[]; nextCursor?: string }
export interface SetupTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const TS = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${c}`;
const TAIL = `is_active, version, ${TS('created_at')}`;
const COLS = {
  materials: `id, tenant_id, code, name, manufacturer, matrix, ${TAIL}`,
  levels: `id, tenant_id, material_id, level_code, display_name, sort_order, ${TAIL}`,
  lots: `id, tenant_id, level_id, material_id, lot_no, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, ${TAIL}`,
  maps: `id, tenant_id, instrument_id, control_id_raw, control_lot_raw, lot_id, ${TAIL}`,
} as const;
const TABLE = { materials: 'control_materials', levels: 'control_levels', lots: 'control_lots', maps: 'control_id_maps' } as const;
/** Columns an update may SET (allowlist: a key outside it is a programming error, never request input). */
const SETTABLE: Record<T, readonly string[]> = {
  materials: ['name', 'manufacturer', 'matrix', 'is_active', 'updated_by'],
  levels: ['display_name', 'sort_order', 'is_active', 'updated_by'],
  lots: ['expires_on', 'is_active', 'updated_by'],
  maps: ['is_active', 'updated_by'],
};
const INSERT_COLS: Record<T, readonly string[]> = {
  materials: ['id', 'code', 'name', 'manufacturer', 'matrix', 'created_by', 'updated_by'],
  levels: ['id', 'material_id', 'level_code', 'display_name', 'sort_order', 'created_by', 'updated_by'],
  lots: ['id', 'level_id', 'material_id', 'lot_no', 'expires_on', 'created_by', 'updated_by'],
  maps: ['id', 'instrument_id', 'control_id_raw', 'control_lot_raw', 'lot_id', 'created_by', 'updated_by'],
};
type T = keyof typeof TABLE;

// ---------------------------------------------------------------------------------------------------- keyset cursor (02-CV §4.3)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encode = (sort: string, key: string, id: string) => Buffer.from(JSON.stringify([sort, key, id]), 'utf8').toString('base64url');
function decode(raw: string, sort: string): { key: string; id: string } {
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== sort || typeof v[1] !== 'string' || v[1].length > 64 || typeof v[2] !== 'string' || !UUID.test(v[2])) throw bad();
  return { key: v[1], id: v[2] };
}
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface Spec { t: T; label: string; col: string; cast: string; desc: boolean }
const BY_CODE: Spec = { t: 'materials', label: 'code', col: 'code', cast: 'text', desc: false };
const BY_CREATED = (t: T): Spec => ({ t, label: '-created_at', col: 'created_at', cast: 'timestamptz', desc: true });
const BY_EXPIRY: Spec = { t: 'lots', label: 'expires_on', col: 'expires_on', cast: 'date', desc: false };

/** Filters are [sql with `?`, value]; undefined value = filter off. Every `?` becomes the same bound placeholder. */
async function list(tx: SetupTx, tenantId: string, s: Spec, filters: Array<[string, unknown]>, cursor: string | undefined, limit: number): Promise<Page> {
  const values: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  for (const [sql, v] of filters) if (v !== undefined) where.push(sql.replaceAll('?', bind(v)));
  if (cursor !== undefined) {
    const c = decode(cursor, s.label);
    where.push(`(${s.col}, id) ${s.desc ? '<' : '>'} (${bind(c.key)}::${s.cast}, ${bind(c.id)}::uuid)`);
  }
  const dir = s.desc ? 'DESC' : 'ASC';
  const { rows } = await tx.query(
    `SELECT ${COLS[s.t]} FROM quality.${TABLE[s.t]} WHERE ${where.join(' AND ')} ORDER BY ${s.col} ${dir}, id ${dir} LIMIT ${bind(limit + 1)}`, values);
  if (rows.length <= limit) return { rows };
  const kept = rows.slice(0, limit), last = kept[kept.length - 1]!;
  return { rows: kept, nextCursor: encode(s.label, String(last[s.col]), last['id']) };
}

async function insert(tx: SetupTx, tenantId: string, t: T, row: Row): Promise<Row> {
  const cols = INSERT_COLS[t];
  const { rows } = await tx.query(
    `INSERT INTO quality.${TABLE[t]} (tenant_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${COLS[t]}`,
    [tenantId, ...cols.map((c) => row[c] ?? null)]);
  return rows[0]!;
}
const find = async (tx: SetupTx, tenantId: string, t: T, id: string): Promise<Row | undefined> =>
  (await tx.query(`SELECT ${COLS[t]} FROM quality.${TABLE[t]} WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];

/** Optimistic lock in SQL: no row = stale version (or invisible row). `null` in the patch clears the column. */
async function update(tx: SetupTx, tenantId: string, t: T, id: string, expected: number, patch: Row): Promise<Row | undefined> {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  for (const k of keys) if (!SETTABLE[t].includes(k)) throw new Error(`setup.repo: column ${k} is not updatable`);
  const values: unknown[] = [tenantId, id, ...keys.map((k) => patch[k]), expected];
  const set = [...keys.map((k, i) => `${k} = $${i + 3}`), 'version = version + 1', 'updated_at = now()'];
  const { rows } = await tx.query(
    `UPDATE quality.${TABLE[t]} SET ${set.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $${values.length} RETURNING ${COLS[t]}`, values);
  return rows[0];
}

const children = (t: T, col: string, order: string) => async (tx: SetupTx, tenantId: string, ids: string[]): Promise<Row[]> =>
  (await tx.query(`SELECT ${COLS[t]} FROM quality.${TABLE[t]} WHERE tenant_id = $1 AND ${col} = ANY($2::uuid[]) ORDER BY ${order}, id`, [tenantId, ids])).rows;

export function createSetupRepo() {
  return {
    listMaterials: (tx: SetupTx, tenantId: string, q: { isActive: boolean; q?: string; sort: 'code' | '-created_at'; cursor?: string; limit: number }) =>
      list(tx, tenantId, q.sort === 'code' ? BY_CODE : BY_CREATED('materials'), [
        ['is_active = ?', q.isActive],
        // prefix match; LIKE metacharacters in the input are escaped and the pattern is bound (REQ-SEC-082)
        ["(code ILIKE ? ESCAPE '\\' OR name ILIKE ? ESCAPE '\\')", q.q ? `${likeEscape(q.q)}%` : undefined],
      ], q.cursor, q.limit),
    insertMaterial: (tx: SetupTx, tenantId: string, row: Row) => insert(tx, tenantId, 'materials', row),
    findMaterial: (tx: SetupTx, tenantId: string, id: string) => find(tx, tenantId, 'materials', id),
    updateMaterial: (tx: SetupTx, tenantId: string, id: string, v: number, patch: Row) => update(tx, tenantId, 'materials', id, v, patch),

    listLevels: children('levels', 'material_id', 'sort_order'),
    insertLevel: (tx: SetupTx, tenantId: string, row: Row) => insert(tx, tenantId, 'levels', row),
    findLevel: (tx: SetupTx, tenantId: string, id: string) => find(tx, tenantId, 'levels', id),
    updateLevel: (tx: SetupTx, tenantId: string, id: string, v: number, patch: Row) => update(tx, tenantId, 'levels', id, v, patch),

    listLotsByMaterials: children('lots', 'material_id', 'expires_on'),
    listLots: (tx: SetupTx, tenantId: string, q: { materialId?: string; levelId?: string; isActive?: boolean; expiresOnTo?: string; sort: 'expires_on' | '-created_at'; cursor?: string; limit: number }) =>
      list(tx, tenantId, q.sort === 'expires_on' ? BY_EXPIRY : BY_CREATED('lots'), [
        ['material_id = ?::uuid', q.materialId], ['level_id = ?::uuid', q.levelId], ['is_active = ?', q.isActive], ['expires_on < ?::date', q.expiresOnTo],
      ], q.cursor, q.limit),
    insertLot: (tx: SetupTx, tenantId: string, row: Row) => insert(tx, tenantId, 'lots', row),
    findLot: (tx: SetupTx, tenantId: string, id: string) => find(tx, tenantId, 'lots', id),
    updateLot: (tx: SetupTx, tenantId: string, id: string, v: number, patch: Row) => update(tx, tenantId, 'lots', id, v, patch),

    listMaps: (tx: SetupTx, tenantId: string, q: { instrumentId?: string; lotId?: string; isActive?: boolean; cursor?: string; limit: number }) =>
      list(tx, tenantId, BY_CREATED('maps'), [['instrument_id = ?::uuid', q.instrumentId], ['lot_id = ?::uuid', q.lotId], ['is_active = ?', q.isActive]], q.cursor, q.limit),
    insertMap: (tx: SetupTx, tenantId: string, row: Row) => insert(tx, tenantId, 'maps', row),
    findMap: (tx: SetupTx, tenantId: string, id: string) => find(tx, tenantId, 'maps', id),
    updateMap: (tx: SetupTx, tenantId: string, id: string, v: number, patch: Row) => update(tx, tenantId, 'maps', id, v, patch),

    /** Labels only (08 R25): the invoker view, so C7's RLS applies. */
    listInstrumentLabels: async (tx: SetupTx, tenantId: string, instrumentIds: string[]) =>
      (await tx.query('SELECT instrument_id, instrument_code, display_name FROM instruments.v_pub_instrument_directory WHERE tenant_id = $1 AND instrument_id = ANY($2::uuid[])', [tenantId, instrumentIds]))
        .rows as Array<{ instrument_id: string; instrument_code: string; display_name: string }>,
  };
}
export type SetupRepo = ReturnType<typeof createSetupRepo>;
