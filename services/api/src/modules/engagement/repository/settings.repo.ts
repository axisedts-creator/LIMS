// engagement.settings, one row per tenant (05-SCHEMA §2.1, §3). Lazy row: absent = defaults (service). REQ-SEC-024: every statement binds tenant_id
// in addition to RLS. Static SQL only; values are always parameters.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getEngagementSettings(tx: Q, a: { tenantId: string }): Promise<Record<string, any> | undefined> {
  const { rows } = await tx.query('SELECT * FROM engagement.settings WHERE tenant_id = $1', [a.tenantId]);
  return rows[0];
}

/** DDL defaults apply; undefined = a concurrent request created the row first. */
export async function insertDefaultEngagementSettings(tx: Q, a: { tenantId: string; userId: string }): Promise<Record<string, any> | undefined> {
  const { rows } = await tx.query(
    'INSERT INTO engagement.settings (id, tenant_id, created_by, updated_by) VALUES ($3, $1, $2, $2) ON CONFLICT (tenant_id) DO NOTHING RETURNING *',
    [a.tenantId, a.userId, uuidv7()]);
  return rows[0];
}

/** PUT = full replacement of the editable columns; optional ones absent in the body become NULL. */
export const SETTINGS_COLUMNS = [
  'app_enabled', 'bookings_enabled', 'home_collection_enabled', 'queue_enabled', 'reminders_enabled', 'memberships_enabled', 'enquiries_enabled',
  'smart_report_in_app', 'show_partner_orders', 'auto_no_show', 'auto_follow_up_reminders', 'home_collection_centre_id', 'allowed_phone_prefixes',
  'otp_daily_cap', 'min_app_version_android', 'min_app_version_ios', 'app_gateways', 'support_phone', 'app_consent_text', 'app_consent_text_version',
  'max_profiles_per_account', 'max_accounts_per_patient', 'link_code_ttl_hours', 'dormant_after_days', 'minor_age_years', 'booking_horizon_days',
  'booking_min_lead_minutes', 'booking_cancel_cutoff_minutes', 'no_show_grace_minutes', 'max_active_bookings_per_profile',
  'max_bookings_created_per_account_day', 'max_orderables_per_booking', 'booking_reminder_hours_before', 'follow_up_reminder_lead_days',
  'queue_display_history_count', 'smart_report_disclaimer_text',
] as const;

/** undefined = version mismatch (or no row). Column names come from the constant above, never from input. */
export async function updateEngagementSettings(
  tx: Q, a: { tenantId: string; userId: string; expectedVersion: number; values: Readonly<Record<string, unknown>> },
): Promise<Record<string, any> | undefined> {
  const sets = SETTINGS_COLUMNS.map((c, i) => `${c} = $${i + 3}`).join(', ');
  const { rows } = await tx.query(
    `UPDATE engagement.settings SET ${sets}, version = version + 1, updated_at = now(), updated_by = $${SETTINGS_COLUMNS.length + 3}
     WHERE tenant_id = $1 AND version = $2 RETURNING *`,
    [a.tenantId, a.expectedVersion, ...SETTINGS_COLUMNS.map((c) => a.values[c] ?? null), a.userId]);
  return rows[0];
}
