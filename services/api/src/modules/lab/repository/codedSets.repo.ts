// Coded sets: tenant tables lab.cs_* (class M) shadow the global lab.g_cs_* rows of the same code (05-SCHEMA §1; 06 row T-29).
import { first, insertRow, query, table, updateRow, type RepoCtx, type Row, type Table } from './base.repo.js';

const CS_COLS = ['id', 'tenant_id', 'code', 'display', 'system', 'system_version', 'sort_order', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const opts = { frozen: ['code'] };

const SETS = {
  rejection_reasons: { tenant: table('lab.cs_rejection_reasons', 'id', CS_COLS, opts), global: 'lab.g_cs_rejection_reasons' },
  return_reasons: { tenant: table('lab.cs_return_reasons', 'id', CS_COLS, opts), global: 'lab.g_cs_return_reasons' },
  amendment_reasons: { tenant: table('lab.cs_amendment_reasons', 'id', CS_COLS, opts), global: 'lab.g_cs_amendment_reasons' },
  exception_discard_reasons: { tenant: table('lab.cs_exception_discard_reasons', 'id', CS_COLS, opts), global: 'lab.g_cs_exception_discard_reasons' },
} as const satisfies Record<string, { tenant: Table; global: string }>;
export type CodedSet = keyof typeof SETS;

const set = (s: CodedSet) => {
  if (!Object.hasOwn(SETS, s)) throw new TypeError('unknown coded set');
  return SETS[s];
};

/** Effective entries: the tenant's rows plus global rows whose code the tenant has not overridden. */
export const listCodedSet = (rc: RepoCtx, s: CodedSet) => {
  const { tenant, global } = set(s);
  return query(rc, `SELECT t.code, t.display, t.system, t.system_version, t.sort_order, t.is_active, 'tenant' AS scope FROM ${tenant.name} t WHERE t.tenant_id = $1
                    UNION ALL
                    SELECT g.code, g.display, g.system, g.system_version, g.sort_order, g.is_active, 'global' AS scope FROM ${global} g
                     WHERE NOT EXISTS (SELECT 1 FROM ${tenant.name} o WHERE o.tenant_id = $1 AND o.code = g.code)
                    ORDER BY sort_order, code`);
};
/** T-29 #54: the tenant's own row of `code` (never the global one), or null. */
export const getTenantCode = (rc: RepoCtx, s: CodedSet, code: string) => first(rc, `SELECT * FROM ${set(s).tenant.name} WHERE tenant_id = $1 AND code = $2`, [code]);
export const insertCodedSetEntry = (rc: RepoCtx, s: CodedSet, row: Row) => insertRow(rc, set(s).tenant, row);
export const updateCodedSetEntry = (rc: RepoCtx, s: CodedSet, id: string, expectedVersion: number, patch: Row) =>
  updateRow(rc, set(s).tenant, id, expectedVersion, patch);
