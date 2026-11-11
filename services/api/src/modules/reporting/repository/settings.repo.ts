// reporting settings tables (05-SCHEMA §6: settings, staff_assignments, centre_contacts, referrer_preferences, cs_reasons/g_cs_reasons).
// REQ-SEC-024: every tenant-table statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
// lims_app has no DELETE on these tables (05-SCHEMA §6.3): removal = is_active false.

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

/** Patchable settings columns, in the bind order used by updateSettings ($3..$16). */
export const SETTINGS_PATCH_COLUMNS = [
  'auto_release', 'narrative_report_mode', 'patient_mobile_channel_order', 'patient_email_enabled', 'referrer_delivery_enabled',
  'referrer_channels', 'centre_delivery_enabled', 'whatsapp_fallback_minutes', 'critical_alert_referrer_enabled', 'bulk_release_max',
  'print_critical_label', 'link_reissue_max_per_day', 'dues_link_enabled', 'portal_payment_gateways',
] as const;
export type SettingsPatch = Partial<Record<(typeof SETTINGS_PATCH_COLUMNS)[number], unknown>>;

export async function findSettings(tx: Tx, tenantId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT auto_release, narrative_report_mode, patient_mobile_channel_order, patient_email_enabled,
      referrer_delivery_enabled, referrer_channels, centre_delivery_enabled, whatsapp_fallback_minutes, critical_alert_referrer_enabled,
      bulk_release_max, print_critical_label, link_reissue_max_per_day, dues_link_enabled, portal_payment_gateways, version
    FROM reporting.settings WHERE tenant_id = $1`, [tenantId]);
  return rows[0];
}

/** Lazy defaults (05-SCHEMA §8): the DDL defaults are the §10.2 defaults; a concurrent first access loses the race silently. */
export async function insertDefaultSettings(tx: Tx, id: string, tenantId: string, actorId: string): Promise<void> {
  await tx.query(`INSERT INTO reporting.settings (id, tenant_id, created_by, updated_by) VALUES ($1, $2, $3, $3)
    ON CONFLICT (tenant_id) DO NOTHING`, [id, tenantId, actorId]);
}

/** Optimistic-locked partial update; undefined/null patch entries keep the column (COALESCE). Returns undefined on version mismatch. */
export async function updateSettings(tx: Tx, tenantId: string, expectedVersion: number, patch: SettingsPatch, actorId: string): Promise<any | undefined> {
  const v = SETTINGS_PATCH_COLUMNS.map((c) => patch[c] ?? null);
  const { rows } = await tx.query(`UPDATE reporting.settings SET
      auto_release = COALESCE($3, auto_release), narrative_report_mode = COALESCE($4, narrative_report_mode),
      patient_mobile_channel_order = COALESCE($5::text[], patient_mobile_channel_order), patient_email_enabled = COALESCE($6::boolean, patient_email_enabled),
      referrer_delivery_enabled = COALESCE($7::boolean, referrer_delivery_enabled), referrer_channels = COALESCE($8::text[], referrer_channels),
      centre_delivery_enabled = COALESCE($9::boolean, centre_delivery_enabled), whatsapp_fallback_minutes = COALESCE($10::integer, whatsapp_fallback_minutes),
      critical_alert_referrer_enabled = COALESCE($11::boolean, critical_alert_referrer_enabled), bulk_release_max = COALESCE($12::integer, bulk_release_max),
      print_critical_label = COALESCE($13::boolean, print_critical_label), link_reissue_max_per_day = COALESCE($14::smallint, link_reissue_max_per_day),
      dues_link_enabled = COALESCE($15::boolean, dues_link_enabled), portal_payment_gateways = COALESCE($16::text[], portal_payment_gateways),
      version = version + 1, updated_by = $17, updated_at = now()
    WHERE tenant_id = $1 AND version = $2
    RETURNING auto_release, narrative_report_mode, patient_mobile_channel_order, patient_email_enabled, referrer_delivery_enabled,
      referrer_channels, centre_delivery_enabled, whatsapp_fallback_minutes, critical_alert_referrer_enabled, bulk_release_max,
      print_critical_label, link_reissue_max_per_day, dues_link_enabled, portal_payment_gateways, version`,
  [tenantId, expectedVersion, ...v, actorId]);
  return rows[0];
}

export async function listCentreContacts(tx: Tx, tenantId: string, centreId: string | null): Promise<any[]> {
  const { rows } = await tx.query(`SELECT id, centre_id, channel, address, label, is_active, version FROM reporting.centre_contacts
    WHERE tenant_id = $1 AND ($2::uuid IS NULL OR centre_id = $2::uuid) ORDER BY centre_id, channel, id`, [tenantId, centreId]);
  return rows;
}

export async function insertCentreContact(tx: Tx, r: { id: string; tenantId: string; centreId: string; channel: string; address: string; label: string; actorId: string }): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.centre_contacts (id, tenant_id, centre_id, channel, address, label, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, centre_id, channel, address, label, is_active, version`,
  [r.id, r.tenantId, r.centreId, r.channel, r.address, r.label, r.actorId]);
  return rows[0];
}

export async function updateCentreContact(tx: Tx, tenantId: string, id: string, expectedVersion: number,
  patch: { label?: string; is_active?: boolean }, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.centre_contacts SET label = COALESCE($4, label), is_active = COALESCE($5::boolean, is_active),
      version = version + 1, updated_by = $6, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, centre_id, channel, address, label, is_active, version`,
  [tenantId, id, expectedVersion, patch.label ?? null, patch.is_active ?? null, actorId]);
  return rows[0];
}

export async function centreContactVersion(tx: Tx, tenantId: string, id: string): Promise<number | undefined> {
  const { rows } = await tx.query('SELECT version FROM reporting.centre_contacts WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return rows[0]?.version;
}

export type Assignment = 'nominated_signatory' | 'critical_alert_recipient';

export async function listStaffAssignments(tx: Tx, tenantId: string, assignment: Assignment): Promise<Array<{ membership_id: string; is_active: boolean; sort_order: number }>> {
  const { rows } = await tx.query(`SELECT membership_id, is_active, sort_order FROM reporting.staff_assignments
    WHERE tenant_id = $1 AND assignment = $2 ORDER BY sort_order, membership_id`, [tenantId, assignment]);
  return rows;
}

export async function deactivateStaffAssignment(tx: Tx, tenantId: string, assignment: Assignment, membershipId: string, actorId: string): Promise<void> {
  await tx.query(`UPDATE reporting.staff_assignments SET is_active = false, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND assignment = $2 AND membership_id = $3`, [tenantId, assignment, membershipId, actorId]);
}

/** Insert, or re-activate a previously removed row (UNIQUE tenant+assignment+membership). */
export async function upsertStaffAssignment(tx: Tx, r: { id: string; tenantId: string; membershipId: string; assignment: Assignment; sortOrder: number; actorId: string }): Promise<void> {
  await tx.query(`INSERT INTO reporting.staff_assignments (id, tenant_id, membership_id, assignment, sort_order, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $6)
    ON CONFLICT (tenant_id, assignment, membership_id) DO UPDATE SET is_active = true, sort_order = EXCLUDED.sort_order,
      version = staff_assignments.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
  [r.id, r.tenantId, r.membershipId, r.assignment, r.sortOrder, r.actorId]);
}

export async function upsertReferrerPreference(tx: Tx, r: { id: string; tenantId: string; referrerId: string; disabledChannels: string[]; actorId: string }): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.referrer_preferences (id, tenant_id, referrer_id, disabled_channels, created_by, updated_by)
    VALUES ($1, $2, $3, $4::text[], $5, $5)
    ON CONFLICT (tenant_id, referrer_id) DO UPDATE SET disabled_channels = EXCLUDED.disabled_channels, is_active = true,
      version = referrer_preferences.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING referrer_id, disabled_channels`, [r.id, r.tenantId, r.referrerId, r.disabledChannels, r.actorId]);
  return rows[0];
}

/** 02-CV §5.5: tenant rows shadow global rows by code; inactive (tenant or global) codes are hidden. */
export async function listCodes(tx: Tx, tenantId: string, setName: string, limit: number): Promise<Array<{ code: string; display: string; sort_order: number }>> {
  const { rows } = await tx.query(`SELECT code, display, sort_order FROM (
      SELECT DISTINCT ON (code) code, display, sort_order, is_active FROM (
        SELECT code, display, sort_order, is_active, 1 AS pri FROM reporting.cs_reasons WHERE tenant_id = $1 AND set_name = $2
        UNION ALL
        SELECT code, display, sort_order, is_active, 2 AS pri FROM reporting.g_cs_reasons WHERE set_name = $2
      ) u ORDER BY code, pri
    ) m WHERE is_active ORDER BY sort_order, code LIMIT $3`, [tenantId, setName, limit]);
  return rows.slice(0, limit).map((r) => ({ code: r.code, display: r.display, sort_order: r.sort_order }));
}
