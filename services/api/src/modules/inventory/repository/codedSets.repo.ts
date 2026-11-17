// Coded sets (05 §2.1-2.3, §6): global g_cs_* rows (seeded) + tenant cs_reasons / cs_tax_codes. A tenant row (active or not) shadows the global row of the same group + code.
// Each returned row carries scope 'tenant' | 'global'. Explicit tenant filter on every tenant-table statement.
import { type Row, type RepoCtx, getRow, insertRow, query, table, updateRow } from './_base.js';

const REASONS = table('cs_reasons', 'M', ['reason_group', 'code', 'display', 'sort_order', 'system', 'system_version']);
const TAX_CODES = table('cs_tax_codes', 'M', ['code', 'display']);

/** Global table, no tenant column: bypasses query() because that helper always binds the tenant as $1 (an unused parameter is a PG error). */
export const listUom = async (rc: RepoCtx): Promise<Row[]> => (await rc.tx.query('SELECT * FROM inventory.g_cs_uom WHERE is_active ORDER BY sort_order, code')).rows;

export const listReasons = (rc: RepoCtx, reasonGroup: string): Promise<Row[]> =>
  query(rc, `SELECT id, reason_group, code, display, sort_order, system, system_version, 'tenant' AS scope FROM inventory.cs_reasons
              WHERE tenant_id = $1 AND reason_group = $2 AND is_active
             UNION ALL
             SELECT g.id, g.reason_group, g.code, g.display, g.sort_order, g.system, g.system_version, 'global' AS scope FROM inventory.g_cs_reasons g
              WHERE g.reason_group = $2 AND g.is_active
                AND NOT EXISTS (SELECT 1 FROM inventory.cs_reasons t WHERE t.tenant_id = $1 AND t.reason_group = g.reason_group AND t.code = g.code)
             ORDER BY sort_order, code`, [reasonGroup]);
export const insertReason = (rc: RepoCtx, row: Row) => insertRow(rc, REASONS, row);
export const getReason = (rc: RepoCtx, id: string) => getRow(rc, REASONS, id);
export const updateReason = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, REASONS, id, expectedVersion, patch);

export const listTaxCodes = (rc: RepoCtx): Promise<Row[]> =>
  query(rc, `SELECT id, code, display, 'tenant' AS scope FROM inventory.cs_tax_codes WHERE tenant_id = $1 AND is_active
             UNION ALL
             SELECT g.id, g.code, g.display, 'global' AS scope FROM inventory.g_cs_tax_codes g
              WHERE g.is_active AND NOT EXISTS (SELECT 1 FROM inventory.cs_tax_codes t WHERE t.tenant_id = $1 AND t.code = g.code)
             ORDER BY code`);
export const insertTaxCode = (rc: RepoCtx, row: Row) => insertRow(rc, TAX_CODES, row);
export const getTaxCode = (rc: RepoCtx, id: string) => getRow(rc, TAX_CODES, id);
export const updateTaxCode = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, TAX_CODES, id, expectedVersion, patch);
