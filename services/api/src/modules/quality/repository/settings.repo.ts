// quality.settings / quality.sync_state (05-SCHEMA). Every statement is parameterised and tenant-filtered; nothing here updates or deletes.
export interface SettingsTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const COLS = `id, tenant_id, tat_alerts_enabled, tat_warn_pct, tat_escalate_pct, tat_orphan_close_hours, target_min_points, sim_min_days,
  sim_min_decisions, reprocess_window_days, default_plan_params, activated_at, is_active, version`;

/** Column defaults come from the DDL (02-TRD §12.1); activated_at is the DB clock = transaction start. */
export const insertSettingsDefaults = (tx: SettingsTx, a: { id: string; tenantId: string; actorId: string }) =>
  tx.query(
    `INSERT INTO quality.settings (id, tenant_id, activated_at, created_by, updated_by)
     VALUES ($1, $2, now(), $3, $3) ON CONFLICT (tenant_id) DO NOTHING`, [a.id, a.tenantId, a.actorId]);

export async function getSettings(tx: SettingsTx, tenantId: string): Promise<Record<string, any> | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM quality.settings WHERE tenant_id = $1`, [tenantId]);
  return rows[0];
}

/** [CONV] initial cursor = activated_at − 400 days (02-TRD §6.2 step 1, 08 A17 D-56). Never overwrites an existing cursor. */
export const insertSyncState = (tx: SettingsTx, a: { id: string; tenantId: string; activatedAt: Date | string }) =>
  tx.query(
    `INSERT INTO quality.sync_state (id, tenant_id, qc_cursor_at)
     VALUES ($1, $2, $3::timestamptz - interval '400 days') ON CONFLICT (tenant_id) DO NOTHING`, [a.id, a.tenantId, a.activatedAt]);
