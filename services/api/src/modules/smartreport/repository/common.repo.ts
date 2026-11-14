// Shared plumbing for the smartreport repositories (02-TRD §3.2, 05-SCHEMA §4-§6, 07-SECURITY REQ-SEC-022/023/024).
// Every statement binds tenant_id = $n from rc.tenantId (never from a row, patch or argument) and is schema-qualified.
// Column names reach SQL only through the per-repository allow-lists; every value is a bound parameter. Rows are never removed (is_active = false).
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export interface RepoTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
/** tx = the request transaction (RLS claims already set); tenantId / actorId come from the authenticated context. */
export interface RepoCtx { readonly tx: RepoTx; readonly tenantId: string; readonly actorId: string }
export interface ListOpts { readonly includeInactive?: boolean }

const JSONB_COLUMNS = new Set(['content', 'llm_overlay', 'items']);
const PG_INT_MAX = 2_147_483_647;

export const cols = (s: string): readonly string[] => s.split(/\s+/);
export const without = (a: readonly string[], ...x: string[]): readonly string[] => a.filter((c) => !x.includes(c));
/** Class M lists return active rows only unless asked (removal = deactivation, 08 A17 P-18(a)). */
export const activeOnly = (o?: ListOpts): string => (o?.includeInactive === true ? '' : ' AND is_active');
export const clampLimit = (n: number): number => Math.min(Math.max(1, Math.trunc(Number(n)) || 1), 1000);

const bindValue = (k: string, v: unknown): unknown => (JSONB_COLUMNS.has(k) && v !== null ? JSON.stringify(v) : v);
/** Own, defined keys; any key outside the allow-list refuses the whole call before SQL is built. */
function allowed(input: Row, allow: readonly string[], what: string): string[] {
  const keys = Object.keys(input).filter((k) => input[k] !== undefined);
  const bad = keys.filter((k) => !allow.includes(k));
  if (bad.length > 0) throw new Error(`smartreport repository: ${what} carries column(s) not allowed: ${bad.join(', ')}`);
  return keys;
}

/** INSERT ... RETURNING *. tenant_id := rc.tenantId, created_by (and updated_by on versioned class M/C tables) := rc.actorId; version defaults to 1. */
export async function insertRow(rc: RepoCtx, table: string, allow: readonly string[], row: Row, versioned: boolean): Promise<Row> {
  const keys = allowed(row, allow, 'insert row');
  const stamp = versioned ? ['created_by', 'updated_by'] : ['created_by'];
  const names = ['tenant_id', ...keys, ...stamp];
  const values = [rc.tenantId, ...keys.map((k) => bindValue(k, row[k])), ...stamp.map(() => rc.actorId)];
  const marks = names.map((_, i) => `$${i + 1}`).join(', ');
  return (await rc.tx.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${marks}) RETURNING *`, values)).rows[0] as Row;
}

export interface UpdateSpec {
  readonly table: string;
  readonly allow: readonly string[];
  /** The UPDATE text; `set` is built here from the allow-list, `actorParam` is the placeholder number of updated_by. $1 tenant, $2 id, $3 expected version. */
  readonly statement: (set: string, actorParam: number) => string;
}

/** Optimistic update: 0 rows -> common.version_conflict if the row exists for this tenant, else common.not_found. DB trigger errors propagate. */
export async function updateRow(rc: RepoCtx, spec: UpdateSpec, id: string, expectedVersion: number, patch: Row): Promise<Row> {
  const keys = allowed(patch, spec.allow, 'patch');
  if (keys.length === 0) throw new Error('smartreport repository: empty patch');
  if (Number.isInteger(expectedVersion) && expectedVersion >= 1 && expectedVersion <= PG_INT_MAX) {
    const set = keys.map((k, i) => `${k} = $${i + 4}`).join(', ');
    const values = [rc.tenantId, id, expectedVersion, ...keys.map((k) => bindValue(k, patch[k])), rc.actorId];
    const { rows } = await rc.tx.query(spec.statement(set, keys.length + 4), values);
    if (rows.length > 0) return rows[0] as Row;
  }
  const seen = await rc.tx.query(`SELECT 1 FROM ${spec.table} WHERE tenant_id = $1 AND id = $2`, [rc.tenantId, id]);
  throw new LimsError(seen.rows.length > 0 ? 'common.version_conflict' : 'common.not_found');
}

export async function getRow(rc: RepoCtx, table: string, id: string): Promise<Row | null> {
  return ((await rc.tx.query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2`, [rc.tenantId, id])).rows[0] as Row | undefined) ?? null;
}
