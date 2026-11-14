// C13 T08 — partners.manifest_lines (05-SCHEMA §3.7) plus the small reads line validation needs (settings, price-list projection, referrers).
// Every statement is bound by (tenant_id, partner_id) from partnerContext. Partner-writable columns only: order_id, registration_no, failure_*, sample_*,
// resolved_patient_id, conversion_attempt, is_redacted are never in an INSERT/UPDATE list here (AB11; the DB guard would refuse them anyway).
import type { Scope } from './counters.repo.js';

type Row = Record<string, any>;
const WHERE = 'tenant_id = $1 AND partner_id = $2';

export async function listByManifest(s: Scope, manifestId: string): Promise<Row[]> {
  return (await s.tx.query(`SELECT * FROM partners.manifest_lines WHERE ${WHERE} AND manifest_id = $3 ORDER BY line_no ASC`, [s.tenantId, s.partnerId, manifestId])).rows;
}

/** The line must belong to the manifest in the path AND to this partner. */
export async function lock(s: Scope, manifestId: string, id: string): Promise<Row | undefined> {
  return (await s.tx.query(`SELECT * FROM partners.manifest_lines WHERE ${WHERE} AND manifest_id = $3 AND id = $4 FOR UPDATE`, [s.tenantId, s.partnerId, manifestId, id])).rows[0];
}

/** line_no = MAX + 1: a number freed below the highest is not reused. The manifest row lock serialises writers. */
export async function maxLineNo(s: Scope, manifestId: string): Promise<number> {
  const { rows } = await s.tx.query(`SELECT COALESCE(MAX(line_no), 0) AS max_no FROM partners.manifest_lines WHERE ${WHERE} AND manifest_id = $3`, [s.tenantId, s.partnerId, manifestId]);
  return Number(rows[0]?.['max_no'] ?? 0);
}

export async function idsWithSampleRef(s: Scope, manifestId: string, ref: string): Promise<string[]> {
  const { rows } = await s.tx.query(`SELECT id FROM partners.manifest_lines WHERE ${WHERE} AND manifest_id = $3 AND partner_sample_ref = $4`, [s.tenantId, s.partnerId, manifestId, ref]);
  return rows.map((r) => r['id'] as string);
}

export interface LineValues {
  ref: string | null; name: string; sex: string; birthOn: string | null; ageYears: number | null; phone: string | null;
  sms: boolean; whatsapp: boolean; email: boolean; share: boolean; consentVersion: string;
  orderableIds: string[]; snapshot: unknown[]; priority: string; referrerId: string | null; collectedAt: string | null; clinicalNote: string | null;
}
const valuesOf = (v: LineValues): unknown[] => [v.ref, v.name, v.sex, v.birthOn, v.ageYears, v.phone, v.sms, v.whatsapp, v.email, v.share, v.consentVersion,
  v.orderableIds, JSON.stringify(v.snapshot), v.priority, v.referrerId, v.collectedAt, v.clinicalNote];

export async function insert(s: Scope, m: { id: string; centreId: string }, lineId: string, lineNo: number, v: LineValues): Promise<Row> {
  const { rows } = await s.tx.query(
    'INSERT INTO partners.manifest_lines (id, tenant_id, partner_id, manifest_id, receiving_centre_id, line_no, partner_sample_ref, patient_full_name, patient_sex, patient_birth_on, patient_age_years, '
    + 'patient_phone_e164, consent_attested, consent_sms, consent_whatsapp, consent_email, consent_share_with_referrer, consent_text_version, orderable_ids, orderables_snapshot, priority, referrer_id, '
    + 'collected_at, clinical_note, created_by, updated_by) '
    + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, true, $13, $14, $15, $16, $17, $18::uuid[], $19::jsonb, $20, $21, $22::timestamptz, $23, $24, $24) RETURNING *',
    [lineId, s.tenantId, s.partnerId, m.id, m.centreId, lineNo, ...valuesOf(v), s.actorId]);
  return rows[0]!;
}

/** Replace in place; 0 rows = stale line version or no longer draft. */
export async function replace(s: Scope, manifestId: string, id: string, version: number, v: LineValues): Promise<Row | undefined> {
  const { rows } = await s.tx.query(
    'UPDATE partners.manifest_lines SET partner_sample_ref = $6, patient_full_name = $7, patient_sex = $8, patient_birth_on = $9::date, patient_age_years = $10, patient_phone_e164 = $11, '
    + 'consent_sms = $12, consent_whatsapp = $13, consent_email = $14, consent_share_with_referrer = $15, consent_text_version = $16, orderable_ids = $17::uuid[], orderables_snapshot = $18::jsonb, '
    + 'priority = $19, referrer_id = $20, collected_at = $21::timestamptz, clinical_note = $22, version = version + 1, updated_at = now(), updated_by = $5 '
    + `WHERE ${WHERE} AND manifest_id = $3 AND id = $4 AND version = $23 AND state = 'draft' RETURNING *`,
    [s.tenantId, s.partnerId, manifestId, id, s.actorId, ...valuesOf(v), version]);
  return rows[0];
}

export async function remove(s: Scope, manifestId: string, id: string, version: number): Promise<boolean> {
  const { rows } = await s.tx.query(`DELETE FROM partners.manifest_lines WHERE ${WHERE} AND manifest_id = $3 AND id = $4 AND version = $5 AND state = 'draft' RETURNING id`, [s.tenantId, s.partnerId, manifestId, id, version]);
  return rows.length > 0;
}

/** M10: every draft line follows its manifest to discarded (LS: draft -> discarded). */
export async function discardDrafts(s: Scope, manifestId: string): Promise<void> {
  await s.tx.query(
    `UPDATE partners.manifest_lines SET state = 'discarded', version = version + 1, updated_at = now(), updated_by = $4 WHERE ${WHERE} AND manifest_id = $3 AND state = 'draft'`,
    [s.tenantId, s.partnerId, manifestId, s.actorId]);
}

/** M8: draft lines follow the manifest. on_receipt -> submitted; on_submit -> converting + attempt 1 (LS2b). Every line takes the manifest's refreshed centre. */
export async function submitDrafts(s: Scope, manifestId: string, centreId: string, converting: boolean): Promise<void> {
  await s.tx.query(
    `UPDATE partners.manifest_lines SET state = ${converting ? "'converting', conversion_attempt = 1" : "'submitted'"}, receiving_centre_id = $5, version = version + 1, updated_at = now(), updated_by = $4 `
    + `WHERE ${WHERE} AND manifest_id = $3 AND state = 'draft'`,
    [s.tenantId, s.partnerId, manifestId, s.actorId, centreId]);
}

/** M9: submitted lines -> withdrawn. */
export async function withdrawSubmitted(s: Scope, manifestId: string): Promise<void> {
  await s.tx.query(
    `UPDATE partners.manifest_lines SET state = 'withdrawn', version = version + 1, updated_at = now(), updated_by = $4 WHERE ${WHERE} AND manifest_id = $3 AND state = 'submitted'`,
    [s.tenantId, s.partnerId, manifestId, s.actorId]);
}

/** One conversion job per line; job_key convert:<line_id>:<attempt> makes a repeat a no-op (03-APP-FLOW §4.2). */
export async function enqueueConversion(s: Scope, lineId: string, attempt: number): Promise<void> {
  await s.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['partners.convert_manifest_line', JSON.stringify({ tenant_id: s.tenantId, line_id: lineId, attempt }), `convert:${lineId}:${attempt}`]);
}

// ---- reads for validation / DTOs ----
export async function settings(s: Scope): Promise<{ maxLines: number; includeDefault: boolean; consentVersion: string }> {
  const r = (await s.tx.query('SELECT max_lines_per_manifest, include_default_price_list, consent_text_version FROM partners.settings WHERE tenant_id = $1', [s.tenantId])).rows[0];
  return { maxLines: Math.min(Number(r?.['max_lines_per_manifest'] ?? 200), 200), includeDefault: r?.['include_default_price_list'] ?? true, consentVersion: r?.['consent_text_version'] ?? 'partner-v1' }; // absent row = 05-SCHEMA §3.8 defaults
}

/** Price-list projection rows for the given ids, this partner only. */
export async function priceItems(s: Scope, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  return (await s.tx.query(`SELECT * FROM partners.price_list_items WHERE ${WHERE} AND orderable_id = ANY($3::uuid[])`, [s.tenantId, s.partnerId, ids])).rows;
}

export async function referrers(s: Scope, ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  return (await s.tx.query(`SELECT id, display_name, is_active FROM partners.partner_referrers WHERE ${WHERE} AND id = ANY($3::uuid[])`, [s.tenantId, s.partnerId, ids])).rows;
}

/** P2: q matches code or name (escaped LIKE, bound), this partner's list only. */
export async function searchPrice(s: Scope, q: string | undefined, includeDefault: boolean, limit: number): Promise<Row[]> {
  const vals: unknown[] = [s.tenantId, s.partnerId];
  const add = (v: unknown): string => { vals.push(v); return `$${vals.length}`; };
  const where = [WHERE];
  if (!includeDefault) where.push("source = 'partner'");
  if (q) { const p = add(`%${q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(code ILIKE ${p} OR name ILIKE ${p})`); }
  return (await s.tx.query(`SELECT * FROM partners.price_list_items WHERE ${where.join(' AND ')} ORDER BY code ASC LIMIT ${add(limit)}`, vals)).rows;
}
