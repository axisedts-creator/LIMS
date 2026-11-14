// C6-T25 repository: reporting.g_message_templates (global, read-only here), reporting.message_template_texts, reporting.channel_accounts (05-SCHEMA §2.8/§2.9, §6).
// REQ-SEC-024: every tenant-table statement binds tenant_id explicitly in addition to RLS. Static SQL only; values are always parameters.
// lims_app has no DELETE on these tables (05-SCHEMA §6.3). g_message_templates is a seed-only registry: SELECT grant only.

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export async function listActiveTemplates(tx: Tx): Promise<any[]> {
  const { rows } = await tx.query('SELECT code, purpose, channels, params FROM reporting.g_message_templates WHERE is_active = true ORDER BY code', []);
  return rows;
}

export async function findActiveTemplate(tx: Tx, code: string): Promise<any | undefined> {
  const { rows } = await tx.query('SELECT code, channels, params FROM reporting.g_message_templates WHERE code = $1 AND is_active = true', [code]);
  return rows[0];
}

export async function listTexts(tx: Tx, tenantId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT template_code, channel, language, body_text, subject_text, provider_template_name,
      provider_template_language, provider_variable_order, approval_status, is_active, version
    FROM reporting.message_template_texts
    WHERE tenant_id = $1 ORDER BY template_code, channel, language`, [tenantId]);
  return rows;
}

export interface TextFields {
  bodyText: string; subjectText: string | null; providerTemplateName: string | null; providerTemplateLanguage: string | null;
  providerVariableOrder: string[] | null; approvalStatus: string; approvalRecordedBy: string | null; approvalRecordedAt: unknown; isActive: boolean;
}

/** Returns undefined when (tenant, template, channel, language) already exists: the caller maps that to a version conflict. */
export async function insertText(tx: Tx, r: { id: string; tenantId: string; templateCode: string; channel: string; language: string; actorId: string } & TextFields): Promise<any | undefined> {
  const { rows } = await tx.query(`INSERT INTO reporting.message_template_texts (id, tenant_id, template_code, channel, language, body_text, subject_text,
      provider_template_name, provider_template_language, provider_variable_order, approval_status, approval_recorded_by, approval_recorded_at,
      is_active, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, $14, $15, $15)
    ON CONFLICT (tenant_id, template_code, channel, language) DO NOTHING
    RETURNING template_code, channel, language, body_text, subject_text, provider_template_name, provider_template_language,
      provider_variable_order, approval_status, is_active, version`,
  [r.id, r.tenantId, r.templateCode, r.channel, r.language, r.bodyText, r.subjectText, r.providerTemplateName, r.providerTemplateLanguage,
    r.providerVariableOrder, r.approvalStatus, r.approvalRecordedBy, r.approvalRecordedAt, r.isActive, r.actorId]);
  return rows[0];
}

/** Optimistic-locked full replace of one text. Returns undefined on version mismatch / missing row. */
export async function updateText(tx: Tx, r: { tenantId: string; templateCode: string; channel: string; language: string; expectedVersion: number; actorId: string } & TextFields): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.message_template_texts SET body_text = $6, subject_text = $7, provider_template_name = $8,
      provider_template_language = $9, provider_variable_order = $10::text[], approval_status = $11, approval_recorded_by = $12,
      approval_recorded_at = $13, is_active = $14, version = version + 1, updated_by = $15, updated_at = now()
    WHERE tenant_id = $1 AND template_code = $2 AND channel = $3 AND language = $4 AND version = $5
    RETURNING template_code, channel, language, body_text, subject_text, provider_template_name, provider_template_language,
      provider_variable_order, approval_status, is_active, version`,
  [r.tenantId, r.templateCode, r.channel, r.language, r.expectedVersion, r.bodyText, r.subjectText, r.providerTemplateName,
    r.providerTemplateLanguage, r.providerVariableOrder, r.approvalStatus, r.approvalRecordedBy, r.approvalRecordedAt, r.isActive, r.actorId]);
  return rows[0];
}

export async function textVersion(tx: Tx, tenantId: string, templateCode: string, channel: string, language: string): Promise<number | undefined> {
  const { rows } = await tx.query(`SELECT version FROM reporting.message_template_texts
    WHERE tenant_id = $1 AND template_code = $2 AND channel = $3 AND language = $4`, [tenantId, templateCode, channel, language]);
  return rows[0]?.version;
}

export async function listAccounts(tx: Tx, tenantId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT id, channel, provider_kind, sender_id, secret_ref, callback_token_sha256, is_active, version
    FROM reporting.channel_accounts WHERE tenant_id = $1 ORDER BY channel`, [tenantId]);
  return rows;
}

/** One account per (tenant, channel). The update branch never touches callback_token_sha256: rotation is C3 only. */
export async function upsertAccount(tx: Tx, r: { id: string; tenantId: string; channel: string; providerKind: string; senderId: string | null; secretRef: string; isActive: boolean; actorId: string }): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.channel_accounts (id, tenant_id, channel, provider_kind, sender_id, secret_ref, is_active, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    ON CONFLICT (tenant_id, channel) DO UPDATE SET provider_kind = EXCLUDED.provider_kind, sender_id = EXCLUDED.sender_id,
      secret_ref = EXCLUDED.secret_ref, is_active = EXCLUDED.is_active, version = channel_accounts.version + 1,
      updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING id, channel, provider_kind, sender_id, secret_ref, callback_token_sha256, is_active, version`,
  [r.id, r.tenantId, r.channel, r.providerKind, r.senderId, r.secretRef, r.isActive, r.actorId]);
  return rows[0];
}

/** Version-guarded: a double submit with the same If-Match matches no row. Only the SHA-256 is bound (08 R24, A13 P-8 E1). */
export async function rotateCallbackToken(tx: Tx, r: { tenantId: string; channel: string; expectedVersion: number; tokenSha256: Uint8Array; actorId: string }): Promise<{ id: string; version: number } | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.channel_accounts SET callback_token_sha256 = $4, version = version + 1, updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND channel = $2 AND version = $3 RETURNING id, version`,
  [r.tenantId, r.channel, r.expectedVersion, Buffer.from(r.tokenSha256), r.actorId]);
  return rows[0];
}

export async function accountVersion(tx: Tx, tenantId: string, channel: string): Promise<number | undefined> {
  const { rows } = await tx.query('SELECT version FROM reporting.channel_accounts WHERE tenant_id = $1 AND channel = $2', [tenantId, channel]);
  return rows[0]?.version;
}
