// inventory.settings (05 §2.4): one row per tenant, created lazily with the column defaults (08 A17 P-22). Explicit tenant filter on every statement.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { type Row, type RepoCtx, getRow, query, table, updateRow } from './_base.js';

const SETTINGS = table('settings', 'M', ['consumption_enabled_at', 'vat_in_cost', 'po_self_approval_allowed', 'grn_without_po_allowed', 'over_receipt_tolerance_bp',
  'expiry_alert_days', 'default_consumption_store_id', 'count_locks_store', 'per_day_requires_activity', 'reconciliation_gap_alert_bp', 'backdate_max_days', 'po_no_pattern',
  'grn_no_pattern', 'transfer_no_pattern', 'count_no_pattern', 'doc_no_pattern'], { key: null });

export const getSettings = (rc: RepoCtx): Promise<Row | null> => getRow(rc, SETTINGS);
/** INSERT ... ON CONFLICT (tenant_id) DO NOTHING, then SELECT: safe under concurrent first calls. */
export async function ensureSettings(rc: RepoCtx): Promise<Row> {
  await query(rc, 'INSERT INTO inventory.settings (id, tenant_id, created_by, updated_by) VALUES ($2, $1, $3, $3) ON CONFLICT (tenant_id) DO NOTHING', [uuidv7(), rc.actorId]);
  return (await getRow(rc, SETTINGS))!;
}
export const updateSettings = (rc: RepoCtx, expectedVersion: number, patch: Row) => updateRow(rc, SETTINGS, null, expectedVersion, patch);
