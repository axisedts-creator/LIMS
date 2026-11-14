// engagement.enquiries / enquiry_messages (05-SCHEMA §3, §8; 02-TRD §4.13). Static SQL only; values are always parameters (subject / body are P3 free text and never reach statement text).
// REQ-SEC-024: every statement binds tenant_id in addition to RLS (PAT_ACC sees its own account only; STAFF is tenant-wide).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;
const COLS = 'id, account_id, patient_id, category_code, subject, status, last_message_at, closed_at, version';

export async function getSettings(tx: Q, a: { tenantId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT * FROM engagement.settings WHERE tenant_id = $1', [a.tenantId]);
  return rows[0];
}

/** The caller's account from the session membership (accounts.membership_id). */
export async function accountOfMembership(tx: Q, a: { tenantId: string; membershipId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT id FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2', [a.tenantId, a.membershipId]);
  return rows[0];
}

/** Links of one account (profile_id on the wire = link id, never the patient id). */
export async function linksOfAccount(tx: Q, a: { tenantId: string; accountId: string; status?: string }): Promise<Row[]> {
  const { rows } = a.status === undefined
    ? await tx.query('SELECT id, patient_id FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2', [a.tenantId, a.accountId])
    : await tx.query('SELECT id, patient_id FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = $3', [a.tenantId, a.accountId, a.status]);
  return rows;
}

/** Serialises creates of one account so the open-limit count cannot be raced (released at commit). */
export async function lockAccountEnquiries(tx: Q, a: { tenantId: string; accountId: string }): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`enquiry_open:${a.tenantId}:${a.accountId}`]);
}

export async function countByStatus(tx: Q, a: { tenantId: string; accountId: string; status: string }): Promise<number> {
  const { rows } = await tx.query('SELECT count(*)::int AS n FROM engagement.enquiries WHERE tenant_id = $1 AND account_id = $2 AND status = $3', [a.tenantId, a.accountId, a.status]);
  return Number(rows[0]?.['n'] ?? 0);
}

/** Newest first (last_message_at DESC, id DESC); `accountId` set for the patient, absent for staff; `after` = keyset of the last row of the previous page. */
export async function listEnquiries(tx: Q, a: { tenantId: string; accountId?: string; status?: string; categoryCode?: string; after?: { lastMessageAt: string; id: string }; limit: number }): Promise<Row[]> {
  const values: unknown[] = [a.tenantId];
  let where = 'tenant_id = $1';
  const p = (v: unknown): string => { values.push(v); return `$${values.length}`; };
  if (a.accountId !== undefined) where += ` AND account_id = ${p(a.accountId)}`;
  if (a.status !== undefined) where += ` AND status = ${p(a.status)}`;
  if (a.categoryCode !== undefined) where += ` AND category_code = ${p(a.categoryCode)}`;
  if (a.after) where += ` AND (last_message_at, id) < (${p(a.after.lastMessageAt)}::timestamptz, ${p(a.after.id)}::uuid)`;
  values.push(a.limit);
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.enquiries WHERE ${where} ORDER BY last_message_at DESC, id DESC LIMIT $${values.length}`, values);
  return rows;
}

export async function getEnquiry(tx: Q, a: { tenantId: string; id: string; accountId?: string; lock?: boolean }): Promise<Row | undefined> {
  const lock = a.lock ? ' FOR UPDATE' : '';
  const { rows } = a.accountId === undefined
    ? await tx.query(`SELECT ${COLS} FROM engagement.enquiries WHERE tenant_id = $1 AND id = $2${lock}`, [a.tenantId, a.id])
    : await tx.query(`SELECT ${COLS} FROM engagement.enquiries WHERE tenant_id = $1 AND id = $2 AND account_id = $3${lock}`, [a.tenantId, a.id, a.accountId]);
  return rows[0];
}

export async function messagesOf(tx: Q, a: { tenantId: string; enquiryId: string }): Promise<Row[]> {
  const { rows } = await tx.query('SELECT author_kind, body, created_at FROM engagement.enquiry_messages WHERE tenant_id = $1 AND enquiry_id = $2 ORDER BY created_at ASC, id ASC LIMIT 200', [a.tenantId, a.enquiryId]);
  return rows;
}

export async function insertEnquiry(tx: Q, a: { id: string; tenantId: string; accountId: string; patientId: string | null; categoryCode: string; subject: string; now: string; createdBy: string }): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.enquiries (id, tenant_id, account_id, patient_id, category_code, subject, last_message_at, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $7, $8)`,
    [a.id, a.tenantId, a.accountId, a.patientId, a.categoryCode, a.subject, a.now, a.createdBy]);
}

export async function insertMessage(tx: Q, a: { id: string; tenantId: string; enquiryId: string; accountId: string; authorKind: 'patient' | 'staff'; authorId: string; body: string; now: string; createdBy: string }): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.enquiry_messages (id, tenant_id, enquiry_id, account_id, author_kind, author_id, body, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [a.id, a.tenantId, a.enquiryId, a.accountId, a.authorKind, a.authorId, a.body, a.now, a.createdBy]);
}

/** A message was added: new status (open | answered), last_message_at = now, closed_at stays NULL. Conditional on the version; undefined = version moved. */
export async function updateStatus(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; status: string; now: string; updatedBy: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.enquiries SET status = $4, last_message_at = $5, version = version + 1, updated_at = $5, updated_by = $6
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${COLS}`,
    [a.tenantId, a.id, a.expectedVersion, a.status, a.now, a.updatedBy]);
  return rows[0];
}

/** Close keeps last_message_at (no message is added). */
export async function closeRow(tx: Q, a: { tenantId: string; id: string; expectedVersion: number; now: string; updatedBy: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE engagement.enquiries SET status = $4, closed_at = $5, version = version + 1, updated_at = $5, updated_by = $6
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${COLS}`,
    [a.tenantId, a.id, a.expectedVersion, 'closed', a.now, a.updatedBy]);
  return rows[0];
}

/** In-app notification for the staff reply: kind / entity / ids only, never the text (07-SECURITY §3). entity_seq = the new version keeps the (account, kind, entity, seq) dedupe key unique per reply. */
export async function insertReplyNotification(tx: Q, a: { id: string; tenantId: string; accountId: string; patientId: string | null; enquiryId: string; seq: number; now: string; expiresAt: string; createdBy: string }): Promise<void> {
  await tx.query(
    `INSERT INTO engagement.notifications (id, tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, created_at, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [a.id, a.tenantId, a.accountId, a.patientId, 'enquiry_reply', 'enquiry', a.enquiryId, a.seq, a.now, a.createdBy, a.expiresAt]);
}
