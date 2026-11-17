// frontdesk.settings (05-SCHEMA §3), one row per tenant (PK tenant_id); frontdesk.g_cs_reasons + cs_reasons (coded sets, F25).
import type { Tx } from './shared.repo.js';

export async function getSettings(tx: Tx, tenantId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0] ?? null;
}

const SETTING_COLS = ['discount_self_limit_bp', 'discount_self_limit_paisa', 'discount_absolute_max_bp', 'require_referrer', 'consent_text_version',
  'registration_sms_enabled', 'label_autoprint', 'buyer_pan_pattern', 'patient_search_min_chars'] as const;
export const SETTING_FIELDS: readonly string[] = SETTING_COLS;

/** FD-T15 F24: optimistic whole-row replace. null when the row's version != expectedVersion (the loser of a race re-checks the version after the row lock). */
export async function updateSettings(tx: Tx, tenantId: string, expectedVersion: number, v: Record<string, unknown>): Promise<any | null> {
  const sets = SETTING_COLS.map((c, i) => `${c} = $${i + 3}`);
  const { rows } = await tx.query(`UPDATE frontdesk.settings SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = (SELECT app.current_actor_id())'].join(', ')}
    WHERE tenant_id = $1 AND version = $2 RETURNING *`, [tenantId, expectedVersion, ...SETTING_COLS.map((c) => v[c])]);
  return rows[0] ?? null;
}

/** FD-T15 F25: active global codes + active tenant codes of one set, by sort_order. `setName` is checked against the allowlist by the caller and bound as a parameter. */
export async function listCodedSet(tx: Tx, tenantId: string, setName: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT code, display, sort_order FROM (
      SELECT code, display, sort_order FROM frontdesk.g_cs_reasons WHERE set_name = $2 AND is_active
      UNION ALL
      SELECT code, display, sort_order FROM frontdesk.cs_reasons WHERE tenant_id = $1 AND set_name = $2 AND is_active
    ) s ORDER BY sort_order, code`, [tenantId, setName]);
  return rows;
}
