// homecollection.settings (05-SCHEMA §4), one row per tenant (unique tenant_id). Rows are created lazily by the service (HC-T04) with the 08 A17 P-22 defaults.
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.settings';
const FIELDS = ['min_app_version', 'sync_interval_seconds', 'offline_purge_hours', 'capture_gps', 'gps_retention_days', 'map_handoff_enabled',
  'manual_barcode_entry_allowed', 'second_identifier', 'collection_consent_text_version', 'collection_consent_text', 'payment_methods',
  'handover_confirmation_required', 'handover_overdue_hours', 'max_visits_per_route', 'notify_phlebotomist_on_assign', 'notify_patient_on_assign',
  'clock_tolerance_seconds', 'is_active'] as const;
const INSERT_COLS = ['id', ...FIELDS] as const;
const UPDATE_COLS = [...FIELDS, 'updated_by'] as const;
const JSON_COLS = ['payment_methods'] as const;

export async function getSettings(tx: Tx, tenantId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0] ?? null;
}

/** Lazy create: null when the tenant already has a row (the existing row is never overwritten). */
export const insertSettingsIfAbsent = (tx: Tx, tenantId: string, row: Record<string, unknown>) =>
  insertRow(tx, T, INSERT_COLS, tenantId, row, { jsonCols: JSON_COLS, doNothingOnConflict: 'tenant_id' });
export const getSettingsById = (tx: Tx, tenantId: string, settingsId: string) => getRowById(tx, T, tenantId, settingsId);
export const updateSettings = (tx: Tx, tenantId: string, settingsId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, JSON_COLS, tenantId, settingsId, expectedVersion, patch);
