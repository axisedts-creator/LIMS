// quality.settings / quality.sync_state (05-SCHEMA). Every statement is parameterised and tenant-filtered; nothing here updates or deletes.
export interface SettingsTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const COLS = `id, tenant_id, tat_alerts_enabled, tat_warn_pct, tat_escalate_pct, tat_orphan_close_hours, target_min_points, sim_min_days,
  sim_min_decisions, reprocess_window_days, default_plan_params, activated_at, updated_at, is_active, version`;

/** The nine columns #52 may change (REQ-SEC-080): the SET list is built from this allowlist, never from caller keys. */
export const MUTABLE_COLS = ['tat_alerts_enabled', 'tat_warn_pct', 'tat_escalate_pct', 'tat_orphan_close_hours', 'target_min_points', 'sim_min_days', 'sim_min_decisions',
  'reprocess_window_days', 'default_plan_params'] as const;

/** Compare-and-swap on version (one statement). undefined = no row matched (stale version). */
export async function updateSettings(tx: SettingsTx, tenantId: string, expectedVersion: number, patch: Record<string, unknown>, actorId: string): Promise<Record<string, any> | undefined> {
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((k) => !(MUTABLE_COLS as readonly string[]).includes(k))) throw new Error('settings patch: column not mutable');
  const values: unknown[] = [tenantId, expectedVersion, actorId];
  const sets = MUTABLE_COLS.filter((c) => c in patch).map((c) => {
    values.push(c === 'default_plan_params' ? JSON.stringify(patch[c]) : patch[c]);
    return `${c} = $${values.length}${c === 'default_plan_params' ? '::jsonb' : ''}`;
  });
  const { rows } = await tx.query(
    `UPDATE quality.settings SET ${sets.join(', ')}, version = version + 1, updated_at = now(), updated_by = $3
     WHERE tenant_id = $1 AND version = $2 RETURNING ${COLS}`, values);
  return rows[0];
}

// Coded sets: the table name comes from this fixed allowlist, never from the input string.
const SET_TABLES: Record<string, { g: string; t: string }> = {
  corrective_actions: { g: 'quality.g_cs_corrective_actions', t: 'quality.cs_corrective_actions' },
  exclusion_reasons: { g: 'quality.g_cs_exclusion_reasons', t: 'quality.cs_exclusion_reasons' },
};
const tables = (set: unknown) => {
  if (typeof set !== 'string' || !Object.hasOwn(SET_TABLES, set)) throw new Error('unknown coded set');
  return SET_TABLES[set]!;
};
const CODE_COLS = 'code, display, sort_order, is_active';

export async function listGlobalCodes(tx: SettingsTx, set: string): Promise<Record<string, any>[]> {
  const { rows } = await tx.query(`SELECT ${CODE_COLS} FROM ${tables(set).g} ORDER BY sort_order, code`);
  return rows;
}

export async function listTenantCodes(tx: SettingsTx, tenantId: string, set: string): Promise<Record<string, any>[]> {
  const { rows } = await tx.query(`SELECT ${CODE_COLS} FROM ${tables(set).t} WHERE tenant_id = $1 ORDER BY sort_order, code LIMIT 500`, [tenantId]);
  return rows;
}

/** Race-safe upsert on UNIQUE (tenant_id, code); id / tenant_id / created_* are never rewritten. */
export async function upsertTenantCode(tx: SettingsTx, tenantId: string, set: string,
  a: { id: string; code: string; display: string; sortOrder: number; isActive: boolean; actorId: string }): Promise<Record<string, any>> {
  const { rows } = await tx.query(
    `INSERT INTO ${tables(set).t} AS c (id, tenant_id, code, display, sort_order, is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (tenant_id, code) DO UPDATE SET display = EXCLUDED.display, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
       version = c.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING ${CODE_COLS}`, [a.id, tenantId, a.code, a.display, a.sortOrder, a.isActive, a.actorId]);
  const r = rows[0]!;
  return { code: r['code'], display: r['display'], sort_order: r['sort_order'], is_active: r['is_active'] };
}

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
