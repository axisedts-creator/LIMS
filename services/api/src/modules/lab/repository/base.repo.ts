// Shared repository mechanics for every lab table (06 row T-03; 02-TRD §3.1; 02-CV §2 / §5 "version = version + 1 in the same statement").
// REQ-SEC-024: every statement binds tenant_id = $1 from rc.tenantId (never from a row, patch or argument), in addition to RLS.
// Column names come only from the per-table allowlists below (copied from the lab DDL), values are always bound parameters.
import { LimsError } from '../../../core/errors.js';

export interface RepoTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
/** [CONV] the request transaction (02-TRD §3.2) plus the ctx tenant and actor; built by service/ from ctx. */
export interface RepoCtx { readonly tx: RepoTx; readonly tenantId: string; readonly actorId: string }
export type Row = Record<string, any>;

export interface Table {
  readonly name: string;
  /** Row key besides tenant_id; null = one row per tenant (PK tenant_id). */
  readonly key: string | null;
  readonly cols: ReadonlySet<string>;
  readonly insertable: ReadonlySet<string>;
  readonly mutable: ReadonlySet<string>;
}

const SYSTEM = ['tenant_id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4_MAX = 2147483647;
const MAX_LIMIT = 1000;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
/** Programming error in the caller (bad column, bad ctx): 500, nothing written. */
const misuse = (): LimsError => new LimsError('common.internal');

/**
 * Table definition. `mutable` defaults to every column except the system columns, the key, `id` and `frozen`;
 * tables without a `version` column are append-only (no UPDATE). Triggers (enforce_mutable_columns, result lock) still apply.
 */
export function table(name: string, key: string | null, cols: readonly string[], opts: { mutable?: readonly string[]; frozen?: readonly string[] } = {}): Table {
  const skip = new Set([...SYSTEM, ...(opts.frozen ?? []), 'id', ...(key ? [key] : [])]);
  const mutable = !cols.includes('version') ? [] : (opts.mutable ?? cols).filter((c) => !skip.has(c));
  return {
    name, key, cols: new Set(cols),
    insertable: new Set(cols.filter((c) => !SYSTEM.includes(c))),
    mutable: new Set(mutable),
  };
}

function scope(rc: RepoCtx): RepoCtx {
  if (!rc || !isUuid(rc.tenantId) || !isUuid(rc.actorId) || typeof rc.tx?.query !== 'function') throw misuse();
  return rc;
}

/** Run `text` with $1 = ctx tenant; `values` become $2.. */
export async function query(rc: RepoCtx, text: string, values: readonly unknown[] = []): Promise<Row[]> {
  const { tx, tenantId } = scope(rc);
  return (await tx.query(text, [tenantId, ...values])).rows;
}
export const first = async (rc: RepoCtx, text: string, values: readonly unknown[] = []): Promise<Row | null> =>
  (await query(rc, text, values))[0] ?? null;

export function limitOf(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw misuse();
  return n;
}

const ownKeys = (o: unknown): string[] => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);

/** INSERT: tenant_id := ctx tenant, created_by/updated_by := ctx actor, version := column default (1). */
export async function insertRow(rc: RepoCtx, t: Table, row: Row): Promise<Row> {
  const keys = ownKeys(row);
  if (row === null || typeof row !== 'object' || Array.isArray(row) || keys.some((k) => !t.insertable.has(k))) throw misuse();
  const audit = t.cols.has('updated_by') ? ['created_by', 'updated_by'] : ['created_by'];
  const cols = ['tenant_id', ...audit, ...keys];
  const ph = ['$1', ...audit.map(() => '$2'), ...keys.map((_, i) => `$${i + 3}`)];
  const text = `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`;
  return (await query(rc, text, [rc.actorId, ...keys.map((k) => row[k])]))[0]!;
}

/** Row by key, or null for unknown / other tenant's key (404 parity). */
export async function getRow(rc: RepoCtx, t: Table, key?: string): Promise<Row | null> {
  if (t.key === null) return first(rc, `SELECT * FROM ${t.name} WHERE tenant_id = $1`);
  if (!isUuid(key)) return null;
  return first(rc, `SELECT * FROM ${t.name} WHERE tenant_id = $1 AND ${t.key} = $2`, [key]);
}

/**
 * Optimistic update: SET <patch>, version = version + 1, updated_at = now(), updated_by = actor WHERE tenant + key + version = expected.
 * 0 rows -> common.version_conflict if the row exists for this tenant, else common.not_found.
 */
export async function updateRow(rc: RepoCtx, t: Table, key: string | null, expectedVersion: number, patch: Row): Promise<Row> {
  const keys = ownKeys(patch);
  if (keys.length === 0 || keys.some((k) => !t.mutable.has(k)) || !Number.isSafeInteger(expectedVersion)) throw misuse();
  if (t.key !== null && !isUuid(key)) throw new LimsError('common.not_found');
  const keyVals = t.key === null ? [] : [key];
  if (expectedVersion >= 0 && expectedVersion <= INT4_MAX) {
    const set = keys.map((k, i) => `${k} = $${i + 4 + keyVals.length}`);
    const text = `UPDATE ${t.name} SET ${set.join(', ')}, version = version + 1, updated_at = now(), updated_by = $2
                   WHERE tenant_id = $1 AND version = $3${t.key === null ? '' : ` AND ${t.key} = $4`} RETURNING *`;
    const rows = await query(rc, text, [rc.actorId, expectedVersion, ...keyVals, ...keys.map((k) => patch[k])]);
    if (rows[0]) return rows[0];
  }
  const exists = await first(rc, `SELECT 1 AS x FROM ${t.name} WHERE tenant_id = $1${t.key === null ? '' : ` AND ${t.key} = $2`}`, keyVals);
  throw new LimsError(exists ? 'common.version_conflict' : 'common.not_found');
}
