// billing.settings, one row per tenant (lazy defaults are created by settings.service, BL-T05), and the B34 coded sets.
// REQ-SEC-024: every tenant-table statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getBillingSettings(tx: Q, a: { tenantId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.settings WHERE tenant_id = $1', [a.tenantId]);
  return rows[0];
}

/** Column defaults apply; undefined = a concurrent request created the row first. */
export async function insertDefaultBillingSettings(tx: Q, a: { tenantId: string; userId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    'INSERT INTO billing.settings (tenant_id, created_by, updated_by) VALUES ($1, $2, $2) ON CONFLICT (tenant_id) DO NOTHING RETURNING *',
    [a.tenantId, a.userId]);
  return rows[0];
}

export interface SettingsValues {
  invoice_series_scope?: string; prices_include_tax?: boolean; abbreviated_invoice_enabled?: boolean; pay_by_qr_enabled?: boolean;
  receipt_no_enabled?: boolean; credit_days_auto_lock?: boolean; cash_variance_alert_paisa?: number; refund_alert_per_day?: number;
}

/** Partial update; an absent key keeps the column. undefined = version mismatch (or no row). */
export async function updateBillingSettings(tx: Q, a: { tenantId: string; userId: string; expectedVersion: number; values: SettingsValues }): Promise<Record<string, unknown> | undefined> {
  const v = a.values;
  const { rows } = await tx.query(
    `UPDATE billing.settings SET
       invoice_series_scope = COALESCE($3::text, invoice_series_scope), prices_include_tax = COALESCE($4::boolean, prices_include_tax),
       abbreviated_invoice_enabled = COALESCE($5::boolean, abbreviated_invoice_enabled), pay_by_qr_enabled = COALESCE($6::boolean, pay_by_qr_enabled),
       receipt_no_enabled = COALESCE($7::boolean, receipt_no_enabled), credit_days_auto_lock = COALESCE($8::boolean, credit_days_auto_lock),
       cash_variance_alert_paisa = COALESCE($9::bigint, cash_variance_alert_paisa), refund_alert_per_day = COALESCE($10::integer, refund_alert_per_day),
       version = version + 1, updated_at = now(), updated_by = $11
     WHERE tenant_id = $1 AND version = $2 RETURNING *`,
    [a.tenantId, a.expectedVersion, v.invoice_series_scope ?? null, v.prices_include_tax ?? null, v.abbreviated_invoice_enabled ?? null, v.pay_by_qr_enabled ?? null,
      v.receipt_no_enabled ?? null, v.credit_days_auto_lock ?? null, v.cash_variance_alert_paisa ?? null, v.refund_alert_per_day ?? null, a.userId]);
  return rows[0];
}

/** US-BL-01.5: any invoice (any status) of this tenant in the B.S. fiscal year, e.g. '2083/84'. */
export async function hasInvoiceInFiscalYear(tx: Q, a: { tenantId: string; fiscalYearBs: string }): Promise<boolean> {
  const { rows } = await tx.query(
    'SELECT EXISTS (SELECT 1 FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2) AS found', [a.tenantId, a.fiscalYearBs]);
  return rows[0]?.found === true;
}

/** Tenant row wins over the global row of the same code (so a tenant can retire a global code); callers drop is_active = false. */
export async function listCodes(tx: Q, a: { tenantId: string; setName: string }): Promise<Array<Record<string, any>>> {
  const { rows } = a.setName === 'payment_methods'
    ? await tx.query(`SELECT DISTINCT ON (code) code, display, sort_order, is_active FROM (
        SELECT code, display, sort_order, is_active, 1 AS pri FROM billing.cs_payment_methods WHERE tenant_id = $1
        UNION ALL
        SELECT code, display, sort_order, is_active, 2 AS pri FROM billing.g_cs_payment_methods
      ) u ORDER BY code, pri`, [a.tenantId])
    : await tx.query(`SELECT DISTINCT ON (code) code, display, sort_order, is_active FROM (
        SELECT code, display, sort_order, is_active, 1 AS pri FROM billing.cs_reasons WHERE tenant_id = $1 AND set_name = $2
        UNION ALL
        SELECT code, display, sort_order, is_active, 2 AS pri FROM billing.g_cs_reasons WHERE set_name = $2
      ) u ORDER BY code, pri`, [a.tenantId, a.setName]);
  return rows;
}
