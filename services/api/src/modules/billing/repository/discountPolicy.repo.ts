// T0B-FINCTRL-1 (LD-321, founder blanket authority LD-310) accounting control masters: billing.discount_reason, billing.party_discount_slab,
// billing.user_discount_limit, billing.discount_authority (migration 20261117190000). Explicit tenant_id = $1 on every statement on top of RLS; every value
// is a bound parameter and every SQL text is static (optional filters are `$n IS NULL OR ...`). Money is read as ::text (bigint) and converted exactly.
// Row audit (app.tg_row_audit) on the four tables writes the audit record of every INSERT / UPDATE (done_when 7).
type Tx = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Row = Record<string, any>;
const opt = (v: unknown): unknown => (v === undefined ? null : v);

// ---------------------------------------------------------------- discount reasons
const REASON_COLS = 'id, code, name, display_order, is_active, version, created_at, updated_at';
/** The eight evidence reasons, once per tenant (billing.seed_discount_reasons is idempotent: ON CONFLICT DO NOTHING); only written while one is missing. */
export async function ensureSeedReasons(tx: Tx, tenantId: string, actorId: string): Promise<void> {
  const r = (await tx.query(`SELECT count(*)::int AS n FROM billing.discount_reason WHERE tenant_id = $1 AND code IN
    ('PARTNER_FAMILY','PARTNER_FRIENDS_RELATIVES','PRESCRIBED_BY_DOCTOR','EMPLOYEES_FAMILY','EMPLOYEE_RELATIVES','REGULAR_PATIENT','WALKING_PATIENT','GOLD_MEMBERSHIP')`, [tenantId])).rows[0];
  if (Number(r?.n) < 8) await tx.query('SELECT billing.seed_discount_reasons($1::uuid, $2::uuid)', [tenantId, actorId]);
}
/** Ordered by (display_order, code); keyset `after` = 'oooo:CODE' (display_order zero padded to 4 digits, so text order = tuple order). */
export async function listReasons(tx: Tx, a: { tenantId: string; isActive?: boolean; after?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT ${REASON_COLS} FROM billing.discount_reason
    WHERE tenant_id = $1 AND ($2::boolean IS NULL OR is_active = $2) AND ($3::text IS NULL OR lpad(display_order::text, 4, '0') || ':' || code > $3)
    ORDER BY display_order, code LIMIT $4`, [a.tenantId, opt(a.isActive), opt(a.after), a.limit])).rows;
}
export async function getReason(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${REASON_COLS} FROM billing.discount_reason WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
}
export async function insertReason(tx: Tx, a: { id: string; tenantId: string; code: string; name: string; displayOrder: number; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.discount_reason (id, tenant_id, code, name, display_order, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)
    RETURNING ${REASON_COLS}`, [a.id, a.tenantId, a.code, a.name, a.displayOrder, a.actorId])).rows[0];
}
/** Optimistic update; undefined = stale version. The code never changes. */
export async function updateReason(tx: Tx, a: { tenantId: string; id: string; version: number; name?: string; displayOrder?: number; isActive?: boolean; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.discount_reason SET name = COALESCE($4, name), display_order = COALESCE($5, display_order), is_active = COALESCE($6, is_active),
      version = version + 1, updated_at = now(), updated_by = $7
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${REASON_COLS}`,
  [a.tenantId, a.id, a.version, opt(a.name), opt(a.displayOrder), opt(a.isActive), a.actorId])).rows[0];
}

// ---------------------------------------------------------------- party discount slabs
const SLAB_COLS = `id, party_kind, party_id, amount_from_paisa::text AS amount_from_paisa, amount_to_paisa::text AS amount_to_paisa, discount_bp,
  effective_from::text AS effective_from, effective_to::text AS effective_to, is_active, version, created_at, updated_at`;
const PARTY_SQL: Readonly<Record<string, string>> = {
  credit_party: 'SELECT 1 FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = $2',
  partner: 'SELECT 1 FROM partners.partners WHERE tenant_id = $1 AND id = $2',
  doctor: 'SELECT 1 FROM catalog.doctors WHERE tenant_id = $1 AND id = $2',
  franchise: "SELECT 1 FROM core.collection_centres WHERE tenant_id = $1 AND id = $2 AND centre_kind = 'franchise'",
};
/**
 * party_id is polymorphic (no FK): [CONV] credit_party = billing.credit_accounts (as the T0B-ACCT-1 ledger), partner = partners.partners,
 * doctor = catalog.doctors, franchise = a core.collection_centres row of centre_kind 'franchise'. Read through RLS, so another tenant's party is unknown.
 */
export async function partyExists(tx: Tx, tenantId: string, kind: string, partyId: string): Promise<boolean> {
  const sql = Object.hasOwn(PARTY_SQL, kind) ? PARTY_SQL[kind] : undefined;
  return sql !== undefined && (await tx.query(sql, [tenantId, partyId])).rows.length > 0;
}
/** The per party lock of the DB trigger party_discount_slab_no_overlap (same key): the domain check below and the INSERT / UPDATE run under it, so a race loser sees the winner. */
export async function lockParty(tx: Tx, a: { tenantId: string; partyKind: string; partyId: string }): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('billing.party_discount_slab:' || $1::text || ':' || $2::text || ':' || $3::text, 0))", [a.tenantId, a.partyKind, a.partyId]);
}
/** An ACTIVE slab of the party (other than `exceptId`) overlapping [from, to) AND [effFrom, effTo] (NULL = open ended). */
export async function findOverlap(tx: Tx, a: { tenantId: string; partyKind: string; partyId: string; from: number; to: number; effFrom: string; effTo: string | null; exceptId?: string }): Promise<string | undefined> {
  return (await tx.query(`SELECT id FROM billing.party_discount_slab
    WHERE tenant_id = $1 AND party_kind = $2 AND party_id = $3 AND is_active AND ($8::uuid IS NULL OR id <> $8)
      AND amount_from_paisa < $5::bigint AND $4::bigint < amount_to_paisa
      AND effective_from <= COALESCE($7::date, 'infinity'::date) AND $6::date <= COALESCE(effective_to, 'infinity'::date)
    LIMIT 1`, [a.tenantId, a.partyKind, a.partyId, String(a.from), String(a.to), a.effFrom, a.effTo, opt(a.exceptId)])).rows[0]?.id;
}
export async function insertSlab(tx: Tx, a: { id: string; tenantId: string; partyKind: string; partyId: string; from: number; to: number; bp: number; effFrom: string; effTo: string | null; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.party_discount_slab (id, tenant_id, party_kind, party_id, amount_from_paisa, amount_to_paisa, discount_bp, effective_from, effective_to, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7, $8::date, $9::date, $10, $10) RETURNING ${SLAB_COLS}`,
  [a.id, a.tenantId, a.partyKind, a.partyId, String(a.from), String(a.to), a.bp, a.effFrom, a.effTo, a.actorId])).rows[0];
}
export async function getSlab(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${SLAB_COLS} FROM billing.party_discount_slab WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
}
/** Full replacement of the mutable values at `version`; undefined = stale. The party never changes. */
export async function updateSlab(tx: Tx, a: { tenantId: string; id: string; version: number; from: number; to: number; bp: number; effFrom: string; effTo: string | null; isActive: boolean; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.party_discount_slab SET amount_from_paisa = $4::bigint, amount_to_paisa = $5::bigint, discount_bp = $6, effective_from = $7::date, effective_to = $8::date,
      is_active = $9, version = version + 1, updated_at = now(), updated_by = $10
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${SLAB_COLS}`,
  [a.tenantId, a.id, a.version, String(a.from), String(a.to), a.bp, a.effFrom, a.effTo, a.isActive, a.actorId])).rows[0];
}
/** Newest first (id DESC: UUIDv7 is time ordered); keyset on id. */
export async function listSlabs(tx: Tx, a: { tenantId: string; partyKind?: string; partyId?: string; isActive?: boolean; beforeId?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT ${SLAB_COLS} FROM billing.party_discount_slab
    WHERE tenant_id = $1 AND ($2::text IS NULL OR party_kind = $2) AND ($3::uuid IS NULL OR party_id = $3) AND ($4::boolean IS NULL OR is_active = $4) AND ($5::uuid IS NULL OR id < $5)
    ORDER BY id DESC LIMIT $6`, [a.tenantId, opt(a.partyKind), opt(a.partyId), opt(a.isActive), opt(a.beforeId), a.limit])).rows;
}
/** The one active slab whose [from, to) holds `amount` and whose [effective_from, effective_to] holds `day` (overlaps are impossible; LIMIT 1 is a backstop). */
export async function resolveSlab(tx: Tx, a: { tenantId: string; partyKind: string; partyId: string; amount: number; day: string }): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${SLAB_COLS} FROM billing.party_discount_slab
    WHERE tenant_id = $1 AND party_kind = $2 AND party_id = $3 AND is_active AND amount_from_paisa <= $4::bigint AND $4::bigint < amount_to_paisa
      AND effective_from <= $5::date AND $5::date <= COALESCE(effective_to, 'infinity'::date)
    ORDER BY id LIMIT 1`, [a.tenantId, a.partyKind, a.partyId, String(a.amount), a.day])).rows[0];
}

// ---------------------------------------------------------------- users, limits, authorities ([CONV] user_id = core.users.id)
export async function userExists(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
  return (await tx.query('SELECT 1 FROM core.users WHERE tenant_id = $1 AND id = $2', [tenantId, userId])).rows.length > 0;
}
/** The user of a membership (the actor of a request is a membership). */
export async function userOfMembership(tx: Tx, tenantId: string, membershipId: string): Promise<string | undefined> {
  return (await tx.query('SELECT user_id FROM core.memberships WHERE tenant_id = $1 AND id = $2', [tenantId, membershipId])).rows[0]?.user_id ?? undefined;
}
const CEIL_COLS = 'id, user_id, max_discount_bp, max_discount_paisa::text AS max_discount_paisa, is_active, version, created_at, updated_at';
/** Serialises the set-limit calls of one user (one active row, partial unique index). */
export async function lockUser(tx: Tx, tenantId: string, userId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('billing.user_discount_limit:' || $1::text || ':' || $2::text, 0))", [tenantId, userId]);
}
/** The row a PUT replaces: the active one, else the newest inactive one (switching a limit back on edits it in place). */
export async function currentLimit(tx: Tx, tenantId: string, userId: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${CEIL_COLS} FROM billing.user_discount_limit WHERE tenant_id = $1 AND user_id = $2 ORDER BY is_active DESC, created_at DESC, id DESC LIMIT 1`, [tenantId, userId])).rows[0];
}
export async function activeLimit(tx: Tx, tenantId: string, userId: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${CEIL_COLS} FROM billing.user_discount_limit WHERE tenant_id = $1 AND user_id = $2 AND is_active LIMIT 1`, [tenantId, userId])).rows[0];
}
export async function insertLimit(tx: Tx, a: { id: string; tenantId: string; userId: string; bp: number; paisa: number; isActive: boolean; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.user_discount_limit (id, tenant_id, user_id, max_discount_bp, max_discount_paisa, is_active, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $7) RETURNING ${CEIL_COLS}`, [a.id, a.tenantId, a.userId, a.bp, String(a.paisa), a.isActive, a.actorId])).rows[0];
}
export async function updateLimit(tx: Tx, a: { tenantId: string; id: string; version: number; bp: number; paisa: number; isActive: boolean; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.user_discount_limit SET max_discount_bp = $4, max_discount_paisa = $5::bigint, is_active = $6, version = version + 1, updated_at = now(), updated_by = $7
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${CEIL_COLS}`, [a.tenantId, a.id, a.version, a.bp, String(a.paisa), a.isActive, a.actorId])).rows[0];
}
type CeilTable = 'user_discount_limit' | 'discount_authority';
const LIST_SQL: Readonly<Record<CeilTable, string>> = {
  user_discount_limit: `SELECT ${CEIL_COLS} FROM billing.user_discount_limit WHERE tenant_id = $1 AND ($2::uuid IS NULL OR user_id = $2) AND ($3::boolean IS NULL OR is_active = $3)
    AND ($4::uuid IS NULL OR id < $4) ORDER BY id DESC LIMIT $5`,
  discount_authority: `SELECT ${CEIL_COLS} FROM billing.discount_authority WHERE tenant_id = $1 AND ($2::uuid IS NULL OR user_id = $2) AND ($3::boolean IS NULL OR is_active = $3)
    AND ($4::uuid IS NULL OR id < $4) ORDER BY id DESC LIMIT $5`,
};
export async function listCeilings(tx: Tx, table: CeilTable, a: { tenantId: string; userId?: string; isActive?: boolean; beforeId?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(LIST_SQL[table], [a.tenantId, opt(a.userId), opt(a.isActive), opt(a.beforeId), a.limit])).rows;
}
export async function insertAuthority(tx: Tx, a: { id: string; tenantId: string; userId: string; bp: number; paisa: number; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.discount_authority (id, tenant_id, user_id, max_discount_bp, max_discount_paisa, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5::bigint, $6, $6) RETURNING ${CEIL_COLS}`, [a.id, a.tenantId, a.userId, a.bp, String(a.paisa), a.actorId])).rows[0];
}
export async function getAuthority(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${CEIL_COLS} FROM billing.discount_authority WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
}
export async function deactivateAuthority(tx: Tx, a: { tenantId: string; id: string; version: number; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.discount_authority SET is_active = false, version = version + 1, updated_at = now(), updated_by = $4
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${CEIL_COLS}`, [a.tenantId, a.id, a.version, a.actorId])).rows[0];
}
/** The newest active authority of a user (what getMyDiscountPolicy shows). */
export async function activeAuthority(tx: Tx, tenantId: string, userId: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT ${CEIL_COLS} FROM billing.discount_authority WHERE tenant_id = $1 AND user_id = $2 AND is_active ORDER BY created_at DESC, id DESC LIMIT 1`, [tenantId, userId])).rows[0];
}
