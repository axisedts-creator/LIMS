// T0B-CONTENT-1 (LD-313): engagement.portal_content and engagement.profile_image (migration 20261117130000). Static SQL, every value a parameter,
// every statement binds tenant_id (REQ-SEC-024) on top of RLS. No DELETE (deactivate / clear only; the app role has no DELETE grant).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
const COLS = `id, kind, title, body, image_attachment_id, link_url, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
  sort_order, is_active, published_at, created_by, created_at, updated_at, version`;
const IMG_COLS = 'id, profile_kind, profile_id, image_attachment_id, is_active, updated_at, version';

export interface ContentFields { kind?: string; title?: string; body?: string; image_attachment_id?: string; link_url?: string; starts_on?: string; ends_on?: string; sort_order?: number; is_active?: boolean }
const UPDATABLE = ['kind', 'title', 'body', 'image_attachment_id', 'link_url', 'starts_on', 'ends_on', 'sort_order', 'is_active'] as const;
export type Key = { kind: string; sortOrder: number; id: string };

/** [CONV] the branding upload path's accepted images: same tenant, active, not quarantined, not a signature (a clinical secret), png / jpeg. */
export async function assetUsable(tx: Q, a: { tenantId: string; id: string }): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM identity.branding_assets WHERE tenant_id = $1 AND id = $2 AND is_active AND scan_state <> 'quarantined' AND kind <> 'signature' AND content_type IN ('image/png','image/jpeg')`,
    [a.tenantId, a.id]);
  return rows.length === 1;
}

export async function insertContent(tx: Q, a: { tenantId: string; userId: string; f: Required<Pick<ContentFields, 'kind' | 'title' | 'sort_order'>> & ContentFields }): Promise<Row> {
  const f = a.f;
  const { rows } = await tx.query(
    `INSERT INTO engagement.portal_content (id, tenant_id, kind, title, body, image_attachment_id, link_url, starts_on, ends_on, sort_order, is_active, published_at, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, true, now(), 1, $11, $11) RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, f.kind, f.title, f.body ?? null, f.image_attachment_id ?? null, f.link_url ?? null, f.starts_on ?? null, f.ends_on ?? null, f.sort_order, a.userId]);
  return rows[0];
}

export async function getContent(tx: Q, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.portal_content WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
  return rows[0];
}

/** Optimistic lock: undefined = the version moved under us. Only whitelisted column names reach the SQL text. */
export async function updateContent(tx: Q, a: { tenantId: string; userId: string; id: string; expectedVersion: number; f: ContentFields }): Promise<Row | undefined> {
  const v: unknown[] = [a.tenantId, a.id, a.expectedVersion, a.userId];
  const sets: string[] = [];
  for (const k of UPDATABLE) {
    if (a.f[k] === undefined) continue;
    v.push(a.f[k]);
    sets.push(`${k} = $${v.length}${k === 'starts_on' || k === 'ends_on' ? '::date' : ''}`);
  }
  const { rows } = await tx.query(
    `UPDATE engagement.portal_content SET ${[...sets, 'version = version + 1', 'updated_at = now()', 'updated_by = $4'].join(', ')}
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${COLS}`, v);
  return rows[0];
}

/** Staff list: every row, keyset (kind, sort_order, id). Caller asks for limit + 1. */
export async function listContent(tx: Q, a: { tenantId: string; kind?: string; isActive?: boolean; after?: Key; limit: number; publicOnly?: boolean }): Promise<Row[]> {
  const v: unknown[] = [a.tenantId];
  let where = 'tenant_id = $1';
  if (a.publicOnly) where += ' AND is_active AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date)';
  if (a.kind !== undefined) { v.push(a.kind); where += ` AND kind = $${v.length}`; }
  if (a.isActive !== undefined) { v.push(a.isActive); where += ` AND is_active = $${v.length}`; }
  if (a.after) { v.push(a.after.kind, a.after.sortOrder, a.after.id); where += ` AND (kind, sort_order, id) > ($${v.length - 2}::text, $${v.length - 1}::int, $${v.length}::uuid)`; }
  v.push(a.limit);
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.portal_content WHERE ${where} ORDER BY kind, sort_order, id LIMIT $${v.length}`, v);
  return rows;
}

/** Locks every row of the kind (id order: two reorders never deadlock) and returns their ids. */
export async function lockKind(tx: Q, a: { tenantId: string; kind: string }): Promise<string[]> {
  const { rows } = await tx.query(`SELECT id FROM engagement.portal_content WHERE tenant_id = $1 AND kind = $2 ORDER BY id FOR UPDATE`, [a.tenantId, a.kind]);
  return rows.map((r: Row) => String(r['id']));
}

export async function applyOrder(tx: Q, a: { tenantId: string; userId: string; kind: string; ids: string[] }): Promise<Row[]> {
  await tx.query(
    `UPDATE engagement.portal_content c SET sort_order = (x.ord - 1)::int, version = c.version + 1, updated_at = now(), updated_by = $4
     FROM unnest($3::uuid[]) WITH ORDINALITY AS x(id, ord) WHERE c.tenant_id = $1 AND c.kind = $2 AND c.id = x.id`,
    [a.tenantId, a.kind, a.ids, a.userId]);
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.portal_content WHERE tenant_id = $1 AND kind = $2 ORDER BY sort_order, id`, [a.tenantId, a.kind]);
  return rows;
}

/** One row per (tenant, kind, profile): insert, or reuse the row (re-activating it). */
export async function upsertProfileImage(tx: Q, a: { tenantId: string; userId: string; kind: string; profileId: string; imageId: string }): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO engagement.profile_image (id, tenant_id, profile_kind, profile_id, image_attachment_id, is_active, version, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, true, 1, $6, $6)
     ON CONFLICT (tenant_id, profile_kind, profile_id) DO UPDATE
       SET image_attachment_id = EXCLUDED.image_attachment_id, is_active = true, version = engagement.profile_image.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING ${IMG_COLS}`,
    [uuidv7(), a.tenantId, a.kind, a.profileId, a.imageId, a.userId]);
  return rows[0];
}

export async function clearProfileImage(tx: Q, a: { tenantId: string; userId: string; kind: string; profileId: string }): Promise<boolean> {
  const { rows } = await tx.query(
    `UPDATE engagement.profile_image SET is_active = false, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND profile_kind = $2 AND profile_id = $3 AND is_active RETURNING id`,
    [a.tenantId, a.kind, a.profileId, a.userId]);
  return rows.length === 1;
}

export async function listProfileImages(tx: Q, a: { tenantId: string; kind?: string; profileId?: string; isActive?: boolean; after?: { kind: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [a.tenantId];
  let where = 'tenant_id = $1';
  if (a.kind !== undefined) { v.push(a.kind); where += ` AND profile_kind = $${v.length}`; }
  if (a.profileId !== undefined) { v.push(a.profileId); where += ` AND profile_id = $${v.length}`; }
  if (a.isActive !== undefined) { v.push(a.isActive); where += ` AND is_active = $${v.length}`; }
  if (a.after) { v.push(a.after.kind, a.after.id); where += ` AND (profile_kind, profile_id) > ($${v.length - 1}::text, $${v.length}::uuid)`; }
  v.push(a.limit);
  const { rows } = await tx.query(`SELECT ${IMG_COLS} FROM engagement.profile_image WHERE ${where} ORDER BY profile_kind, profile_id LIMIT $${v.length}`, v);
  return rows;
}
