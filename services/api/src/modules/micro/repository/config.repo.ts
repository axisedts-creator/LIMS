// micro.settings (one row per tenant, lazy) and the versioned plating protocols with their media and selection keys (05-SCHEMA §8).
// REQ-SEC-024: every statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ------------------------------------------------------------------ settings
export async function getSettings(tx: Q, a: { tenantId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT * FROM micro.settings WHERE tenant_id = $1', [a.tenantId]);
  return rows[0];
}

export interface SettingsValues {
  manual_ast_standard: string | null; zone_suggestion_enabled: boolean; mic_suggestion_enabled: boolean;
  default_final_no_growth_hours: number; early_final_requires_reason: boolean; recent_window_days: number;
}

/** 08 A17 P-22: ON CONFLICT (tenant_id) DO NOTHING; undefined = a concurrent request created the row first. */
export async function insertSettings(tx: Q, a: { tenantId: string; userId: string; id: string; values: SettingsValues }): Promise<Row | undefined> {
  const v = a.values;
  const { rows } = await tx.query(
    `INSERT INTO micro.settings (id, tenant_id, manual_ast_standard, zone_suggestion_enabled, mic_suggestion_enabled, default_final_no_growth_hours,
       early_final_requires_reason, recent_window_days, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) ON CONFLICT (tenant_id) DO NOTHING RETURNING *`,
    [a.id, a.tenantId, v.manual_ast_standard, v.zone_suggestion_enabled, v.mic_suggestion_enabled, v.default_final_no_growth_hours, v.early_final_requires_reason, v.recent_window_days, a.userId]);
  return rows[0];
}

/** `standard` undefined keeps the column, null clears it. undefined result = version mismatch. */
export async function updateSettings(tx: Q, a: { tenantId: string; userId: string; expectedVersion: number; standard: string | null | undefined; values: Omit<SettingsValues, 'manual_ast_standard'> }): Promise<Row | undefined> {
  const v = a.values;
  const { rows } = await tx.query(
    `UPDATE micro.settings SET
       manual_ast_standard = CASE WHEN $3::boolean THEN $4::text ELSE manual_ast_standard END,
       zone_suggestion_enabled = $5, mic_suggestion_enabled = $6, default_final_no_growth_hours = $7, early_final_requires_reason = $8, recent_window_days = $9,
       version = version + 1, updated_at = now(), updated_by = $10
     WHERE tenant_id = $1 AND version = $2 RETURNING *`,
    [a.tenantId, a.expectedVersion, a.standard !== undefined, a.standard ?? null, v.zone_suggestion_enabled, v.mic_suggestion_enabled,
      v.default_final_no_growth_hours, v.early_final_requires_reason, v.recent_window_days, a.userId]);
  return rows[0];
}

// ------------------------------------------------------------------ plating protocols
export async function listProtocols(tx: Q, a: { tenantId: string; includeSuperseded: boolean; isActive?: boolean | undefined }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM micro.plating_protocols WHERE tenant_id = $1 AND ($2::boolean OR superseded_at IS NULL) AND ($3::boolean IS NULL OR is_active = $3::boolean)
     ORDER BY code, version_no LIMIT 2000`, [a.tenantId, a.includeSuperseded, a.isActive ?? null]);
  return rows;
}

export async function getProtocol(tx: Q, a: { tenantId: string; id: string; forUpdate?: boolean }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM micro.plating_protocols WHERE tenant_id = $1 AND id = $2${a.forUpdate ? ' FOR UPDATE' : ''}`, [a.tenantId, a.id]);
  return rows[0];
}

export async function mediaOf(tx: Q, a: { tenantId: string; protocolIds: readonly string[] }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT protocol_id, media_code, sort_order, incubation_text FROM micro.plating_protocol_media WHERE tenant_id = $1 AND protocol_id = ANY($2::uuid[]) ORDER BY protocol_id, sort_order',
    [a.tenantId, a.protocolIds]);
  return rows;
}

/** Active selection keys of the given protocol codes (keys belong to the code, not to one version). */
export async function keysOf(tx: Q, a: { tenantId: string; codes: readonly string[] }): Promise<Row[]> {
  const { rows } = await tx.query(
    'SELECT protocol_code, test_id, specimen_type_code FROM micro.plating_protocol_keys WHERE tenant_id = $1 AND is_active AND protocol_code = ANY($2::text[]) ORDER BY protocol_code, id',
    [a.tenantId, a.codes]);
  return rows;
}

export async function activeCodeTaken(tx: Q, a: { tenantId: string; code: string }): Promise<boolean> {
  const { rows } = await tx.query('SELECT 1 FROM micro.plating_protocols WHERE tenant_id = $1 AND code = $2 AND superseded_at IS NULL LIMIT 1', [a.tenantId, a.code]);
  return rows.length > 0;
}

/** True when another protocol's ACTIVE key equals this key (same coalesce as the partial unique index). */
export async function keyClash(tx: Q, a: { tenantId: string; excludeCode: string; testId?: string | undefined; specimenTypeCode?: string | undefined }): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM micro.plating_protocol_keys WHERE tenant_id = $1 AND is_active AND protocol_code <> $2
       AND coalesce(test_id, '${NIL_UUID}'::uuid) = coalesce($3::uuid, '${NIL_UUID}'::uuid) AND coalesce(specimen_type_code, '') = coalesce($4::text, '') LIMIT 1`,
    [a.tenantId, a.excludeCode, a.testId ?? null, a.specimenTypeCode ?? null]);
  return rows.length > 0;
}

export interface ProtocolValues {
  display: string; read_schedule_hours: readonly number[]; final_no_growth_hours: number; requires_gram_stain: boolean; default_specimen_site_code?: string | undefined;
}
export async function insertProtocol(tx: Q, a: { tenantId: string; userId: string; id: string; code: string; versionNo: number; values: ProtocolValues }): Promise<Row> {
  const v = a.values;
  const { rows } = await tx.query(
    `INSERT INTO micro.plating_protocols (id, tenant_id, code, version_no, display, read_schedule_hours, final_no_growth_hours, requires_gram_stain,
       default_specimen_site_code, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6::integer[], $7, $8, $9, $10, $10) RETURNING *`,
    [a.id, a.tenantId, a.code, a.versionNo, v.display, v.read_schedule_hours, v.final_no_growth_hours, v.requires_gram_stain, v.default_specimen_site_code ?? null, a.userId]);
  return rows[0]!;
}

export async function insertMedia(tx: Q, a: { tenantId: string; userId: string; id: string; protocolId: string; mediaCode: string; sortOrder: number; incubationText?: string | undefined }): Promise<void> {
  await tx.query(
    `INSERT INTO micro.plating_protocol_media (id, tenant_id, protocol_id, media_code, sort_order, incubation_text, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [a.id, a.tenantId, a.protocolId, a.mediaCode, a.sortOrder, a.incubationText ?? null, a.userId]);
}

export async function insertKey(tx: Q, a: { tenantId: string; userId: string; id: string; protocolCode: string; testId?: string | undefined; specimenTypeCode?: string | undefined }): Promise<void> {
  await tx.query(
    `INSERT INTO micro.plating_protocol_keys (id, tenant_id, protocol_code, test_id, specimen_type_code, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [a.id, a.tenantId, a.protocolCode, a.testId ?? null, a.specimenTypeCode ?? null, a.userId]);
}

/** Frees the protocol's selection keys (partial unique index WHERE is_active). */
export async function deactivateKeys(tx: Q, a: { tenantId: string; userId: string; code: string }): Promise<void> {
  await tx.query(
    'UPDATE micro.plating_protocol_keys SET is_active = false, version = version + 1, updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND protocol_code = $2 AND is_active',
    [a.tenantId, a.code, a.userId]);
}

export async function supersedeProtocol(tx: Q, a: { tenantId: string; userId: string; id: string }): Promise<void> {
  await tx.query('UPDATE micro.plating_protocols SET superseded_at = now(), version = version + 1, updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND id = $2',
    [a.tenantId, a.id, a.userId]);
}

export async function deactivateProtocol(tx: Q, a: { tenantId: string; userId: string; id: string }): Promise<Row> {
  const { rows } = await tx.query(
    'UPDATE micro.plating_protocols SET is_active = false, version = version + 1, updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND id = $2 RETURNING *',
    [a.tenantId, a.id, a.userId]);
  return rows[0]!;
}
