// lab.lab_settings: one row per tenant, PK tenant_id (05-SCHEMA §1; 02-TRD §9.1). Missing row = column defaults (service applies them).
import { getRow, insertRow, table, updateRow, type RepoCtx, type Row } from './base.repo.js';

export const LAB_SETTINGS = table('lab.lab_settings', null, ['tenant_id', 'label_width_mm', 'label_height_mm', 'label_copies_default', 'label_renderer',
  'host_query_requires_received', 'ingest_auto_receive', 'critical_notification_blocks_approval', 'recollection_default', 'delta_check_enabled', 'history_days',
  'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by']);

export const getLabSettings = (rc: RepoCtx) => getRow(rc, LAB_SETTINGS);
export const insertLabSettings = (rc: RepoCtx, row: Row) => insertRow(rc, LAB_SETTINGS, row);
export const updateLabSettings = (rc: RepoCtx, expectedVersion: number, patch: Row) => updateRow(rc, LAB_SETTINGS, null, expectedVersion, patch);
