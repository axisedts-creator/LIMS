// Shared repository mechanics for every inventory table (06 row T-03; 02-CONVENTIONS; 05-SCHEMA §2/§4; 07-SECURITY).
// REQ-SEC-024: every statement binds tenant_id = $1 from rc.tenantId (never from a row, patch or argument), in addition to RLS.
// Column names come only from the per-table allowlists in the *.repo.ts files (copied from 05 §8); values are always bound parameters.
// No DELETE anywhere: draft lines are soft-removed (08 A17 D-71); the ledger repos have no update/remove at all (class A, append-only).
import { LimsError } from '../../../core/errors.js';

export interface RepoTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
/** [CONV] the request transaction (02-TRD §3.2) plus the ctx tenant and actor; built by service/ from ctx. */
export interface RepoCtx { readonly tx: RepoTx; readonly tenantId: string; readonly actorId: string }
export type Row = Record<string, any>;
/** `includeInactive` (default false): lists of M tables return is_active rows only (removal = deactivation, 08 A17 P-18(a)). */
export interface ListOpts { includeInactive?: boolean }

/** M = version + is_active; C = version, no is_active; A = append-only (no version/updated_*). */
export type TableClass = 'M' | 'C' | 'A';
export interface Table {
  readonly name: string;
  readonly key: string | null;
  readonly cols: ReadonlySet<string>;
  readonly insertable: ReadonlySet<string>;
  readonly mutable: ReadonlySet<string>;
  readonly json: ReadonlySet<string>;
}

const SYSTEM = ['tenant_id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT4_MAX = 2147483647;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
/** Programming error in the caller (bad column, bad ctx): 500, nothing written. */
const misuse = (): LimsError => new LimsError('common.internal');

/**
 * `business` = the DDL columns besides id / tenant_id / system columns. `key` null = one row per tenant (settings).
 * `noWrite` columns are neither insertable nor patchable (removed_* on draft lines: only remove*Line sets them). `json` columns are serialised here.
 */
export function table(name: string, cls: TableClass, business: readonly string[], opts: { key?: string | null; noWrite?: readonly string[]; json?: readonly string[] } = {}): Table {
  const system = cls === 'A' ? ['tenant_id', 'created_at', 'created_by'] : cls === 'M' ? [...SYSTEM, 'is_active'] : SYSTEM;
  const cols = ['id', ...business, ...system];
  const key = opts.key === undefined ? 'id' : opts.key;
  const no = new Set([...SYSTEM, ...(opts.noWrite ?? [])]);
  return {
    name: `inventory.${name}`, key, cols: new Set(cols),
    insertable: new Set(cols.filter((c) => !no.has(c))),
    mutable: new Set(cls === 'A' ? [] : cols.filter((c) => !no.has(c) && c !== 'id')),
    json: new Set(opts.json ?? []),
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

/** Placeholder allocator for dynamic filters: `q.p(v)` returns `$n` (n >= 2; $1 is the tenant) and remembers v. */
export class Q {
  readonly vals: unknown[] = [];
  p(v: unknown): string { this.vals.push(v); return `$${this.vals.length + 1}`; }
}

/** Default 200, clamped to 1..1000; NaN / non-numbers fall back to the default. */
export function limitOf(n: unknown): number {
  const v = Math.trunc(Number(n ?? 200));
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), 1000) : 200;
}
/** LIKE pattern for a literal prefix: `\`, `%`, `_` are escaped. */
export const prefixOf = (s: unknown): string => String(s ?? '').replace(/[\\%_]/g, '\\$&') + '%';
export const activeOnly = (o?: ListOpts): string => (o?.includeInactive === true ? '' : ' AND is_active');

const ownKeys = (o: unknown): string[] => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);
const ph = (t: Table, k: string, n: number): string => `$${n}${t.json.has(k) ? '::jsonb' : ''}`;
const val = (t: Table, k: string, v: unknown): unknown => (t.json.has(k) && v !== null && v !== undefined ? JSON.stringify(v) : v);

/** INSERT: tenant_id := ctx tenant, created_by/updated_by := ctx actor, version := column default (1). The caller supplies `id`. */
export async function insertRow(rc: RepoCtx, t: Table, row: Row): Promise<Row> {
  const keys = ownKeys(row).filter((k) => row[k] !== undefined);
  if (row === null || typeof row !== 'object' || Array.isArray(row) || ownKeys(row).some((k) => !t.insertable.has(k))) throw misuse();
  const audit = t.cols.has('updated_by') ? ['created_by', 'updated_by'] : ['created_by'];
  const cols = ['tenant_id', ...audit, ...keys];
  const marks = ['$1', ...audit.map(() => '$2'), ...keys.map((k, i) => ph(t, k, i + 3))];
  const text = `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${marks.join(', ')}) RETURNING *`;
  return (await query(rc, text, [rc.actorId, ...keys.map((k) => val(t, k, row[k]))]))[0]!;
}

/** Row by key, or null for unknown / other tenant's key (404 parity). */
export async function getRow(rc: RepoCtx, t: Table, key?: string): Promise<Row | null> {
  if (t.key === null) return first(rc, `SELECT * FROM ${t.name} WHERE tenant_id = $1`);
  if (!isUuid(key)) return null;
  return first(rc, `SELECT * FROM ${t.name} WHERE tenant_id = $1 AND ${t.key} = $2`, [key]);
}

async function conflictOrMissing(rc: RepoCtx, t: Table, keyVals: unknown[]): Promise<never> {
  const exists = await first(rc, `SELECT 1 AS x FROM ${t.name} WHERE tenant_id = $1${t.key === null ? '' : ` AND ${t.key} = $2`}`, keyVals);
  throw new LimsError(exists ? 'common.version_conflict' : 'common.not_found');
}

/**
 * Optimistic update: SET <patch>, version = version + 1, updated_at = now(), updated_by = actor WHERE tenant + key + version = expected (one statement).
 * 0 rows -> common.version_conflict if the row exists for this tenant, else common.not_found.
 */
export async function updateRow(rc: RepoCtx, t: Table, key: string | null, expectedVersion: number, patch: Row): Promise<Row> {
  const keys = ownKeys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0 || ownKeys(patch).some((k) => !t.mutable.has(k)) || !Number.isSafeInteger(expectedVersion)) throw misuse();
  if (t.key !== null && !isUuid(key)) throw new LimsError('common.not_found');
  const keyVals = t.key === null ? [] : [key];
  if (expectedVersion >= 1 && expectedVersion <= INT4_MAX) {
    const set = keys.map((k, i) => `${k} = ${ph(t, k, i + 4 + keyVals.length)}`);
    const text = `UPDATE ${t.name} SET ${set.join(', ')}, version = version + 1, updated_at = now(), updated_by = $2
                   WHERE tenant_id = $1 AND version = $3${t.key === null ? '' : ` AND ${t.key} = $4`} RETURNING *`;
    const rows = await query(rc, text, [rc.actorId, expectedVersion, ...keyVals, ...keys.map((k) => val(t, k, patch[k]))]);
    if (rows[0]) return rows[0];
  }
  return conflictOrMissing(rc, t, keyVals);
}

/** Soft removal of a draft line (D-71): removed_at = now(), removed_by = actor, version + 1. Whether the parent is still draft is the DB trigger's job. */
export async function softRemove(rc: RepoCtx, t: Table, id: string, expectedVersion: number): Promise<Row> {
  if (!Number.isSafeInteger(expectedVersion)) throw misuse();
  if (!isUuid(id)) throw new LimsError('common.not_found');
  if (expectedVersion >= 1 && expectedVersion <= INT4_MAX) {
    const rows = await query(rc, `UPDATE ${t.name} SET removed_at = now(), removed_by = $2, version = version + 1, updated_at = now(), updated_by = $2
                                   WHERE tenant_id = $1 AND id = $4 AND version = $3 AND removed_at IS NULL RETURNING *`, [rc.actorId, expectedVersion, id]);
    if (rows[0]) return rows[0];
  }
  return conflictOrMissing(rc, t, [id]);
}
