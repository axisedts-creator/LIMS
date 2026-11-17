// T0B-ACCT-1 (LD-313, LD-310) lab accounting SQL: account groups, account particulars, the append only accounting ledger (billing.account_ledger_entries),
// party statement and summary. Every statement is tenant scoped by an explicit tenant_id = $1 on top of RLS; every value is a bound parameter and every
// SQL text is static (optional filters are `$n IS NULL OR ...`), so nothing is ever interpolated into SQL.
// LD-313 (b): the ledger is INSERT only here (lims_app holds SELECT + INSERT, no UPDATE / DELETE grant); a correction is a NEW reversal row.
// The "reversed" status of an original is DERIVED on read (a reversal row exists), never written to the original.
// Money columns are read as ::text and converted by the service with exact integer arithmetic (never a float).
type Tx = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Row = Record<string, any>;
const opt = (v: unknown): unknown => (v === undefined ? null : v);

// ---------------------------------------------------------------- masters
export async function listGroups(tx: Tx, a: { tenantId: string; nature?: string; isActive?: boolean; afterCode?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT id, code, name, nature, is_active, version, created_at, updated_at FROM billing.account_groups
    WHERE tenant_id = $1 AND ($2::text IS NULL OR nature = $2) AND ($3::boolean IS NULL OR is_active = $3) AND ($4::text IS NULL OR code > $4)
    ORDER BY code LIMIT $5`, [a.tenantId, opt(a.nature), opt(a.isActive), opt(a.afterCode), a.limit])).rows;
}
export async function getGroup(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query('SELECT id, code, name, nature, is_active, version, created_at, updated_at FROM billing.account_groups WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0];
}
export async function insertGroup(tx: Tx, a: { id: string; tenantId: string; code: string; name: string; nature: string; isActive: boolean; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.account_groups (id, tenant_id, code, name, nature, is_active, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, code, name, nature, is_active, version, created_at, updated_at`,
  [a.id, a.tenantId, a.code, a.name, a.nature, a.isActive, a.actorId])).rows[0];
}
/** Optimistic update (If-Match): undefined when the id is unknown or the version is stale (the caller tells the two apart). Code and nature never change. */
export async function updateGroup(tx: Tx, a: { tenantId: string; id: string; version: number; name?: string; isActive?: boolean; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.account_groups SET name = COALESCE($4, name), is_active = COALESCE($5, is_active), version = version + 1, updated_at = now(), updated_by = $6
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, code, name, nature, is_active, version, created_at, updated_at`,
  [a.tenantId, a.id, a.version, opt(a.name), opt(a.isActive), a.actorId])).rows[0];
}

export async function listParticulars(tx: Tx, a: { tenantId: string; groupId?: string; isActive?: boolean; afterCode?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT id, account_group_id, code, name, is_active, version, created_at, updated_at FROM billing.account_particulars
    WHERE tenant_id = $1 AND ($2::uuid IS NULL OR account_group_id = $2) AND ($3::boolean IS NULL OR is_active = $3) AND ($4::text IS NULL OR code > $4)
    ORDER BY code LIMIT $5`, [a.tenantId, opt(a.groupId), opt(a.isActive), opt(a.afterCode), a.limit])).rows;
}
export async function getParticular(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query('SELECT id, account_group_id, code, name, is_active, version, created_at, updated_at FROM billing.account_particulars WHERE tenant_id = $1 AND id = $2',
    [tenantId, id])).rows[0];
}
/** The particular and whether it and its group are both active (done_when 5). */
export async function particularUsable(tx: Tx, tenantId: string, id: string): Promise<{ active: boolean } | undefined> {
  const r = (await tx.query(`SELECT (p.is_active AND g.is_active) AS active FROM billing.account_particulars p
    JOIN billing.account_groups g ON g.tenant_id = p.tenant_id AND g.id = p.account_group_id WHERE p.tenant_id = $1 AND p.id = $2`, [tenantId, id])).rows[0];
  return r === undefined ? undefined : { active: r.active === true };
}
export async function insertParticular(tx: Tx, a: { id: string; tenantId: string; groupId: string; code: string; name: string; isActive: boolean; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.account_particulars (id, tenant_id, account_group_id, code, name, is_active, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, account_group_id, code, name, is_active, version, created_at, updated_at`,
  [a.id, a.tenantId, a.groupId, a.code, a.name, a.isActive, a.actorId])).rows[0];
}
/** Group and code never change. */
export async function updateParticular(tx: Tx, a: { tenantId: string; id: string; version: number; name?: string; isActive?: boolean; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.account_particulars SET name = COALESCE($4, name), is_active = COALESCE($5, is_active), version = version + 1, updated_at = now(), updated_by = $6
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, account_group_id, code, name, is_active, version, created_at, updated_at`,
  [a.tenantId, a.id, a.version, opt(a.name), opt(a.isActive), a.actorId])).rows[0];
}

// ---------------------------------------------------------------- references
export async function centreExists(tx: Tx, tenantId: string, centreId: string): Promise<boolean> {
  return (await tx.query('SELECT 1 FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [tenantId, centreId])).rows.length > 0;
}
const PARTY_SQL: Readonly<Record<string, string>> = {
  credit_party: 'SELECT credit_limit_paisa::text AS credit_limit_paisa, is_locked FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = $2',
  franchise: "SELECT NULL::text AS credit_limit_paisa, false AS is_locked FROM core.collection_centres WHERE tenant_id = $1 AND id = $2 AND centre_kind = 'franchise'",
  laboratory: 'SELECT NULL::text AS credit_limit_paisa, false AS is_locked FROM core.branches WHERE tenant_id = $1 AND id = $2',
  user_pocket: `SELECT NULL::text AS credit_limit_paisa, false AS is_locked WHERE EXISTS (SELECT 1 FROM core.memberships WHERE tenant_id = $1 AND id = $2 AND status = 'active')
    OR EXISTS (SELECT 1 FROM core.collection_centres WHERE tenant_id = $1 AND id = $2)`,
};
/**
 * Party of a ledger entry (party_id is polymorphic, no FK: the service checks it). [CONV] credit_party = billing.credit_accounts (limit, is_locked);
 * franchise = a core.collection_centres row of centre_kind 'franchise'; laboratory = a core.branches row.
 * [CONV] T0B-ACCT-2 (LD-313 e, Pocket Ledger unreadable): user_pocket = an active core.memberships row (a user's cash pocket) or a core.collection_centres row (a centre's pocket).
 */
export async function findParty(tx: Tx, tenantId: string, kind: string, partyId: string): Promise<{ creditLimitPaisa: string | null; isLocked: boolean } | undefined> {
  const sql = Object.hasOwn(PARTY_SQL, kind) ? PARTY_SQL[kind] : undefined;
  if (sql === undefined) return undefined;
  const r = (await tx.query(sql, [tenantId, partyId])).rows[0];
  return r === undefined ? undefined : { creditLimitPaisa: r.credit_limit_paisa ?? null, isLocked: r.is_locked === true };
}

// ---------------------------------------------------------------- ledger (append only)
/**
 * done_when 4: the per tenant receipt counter is receipt_seq itself (migration 20261117120000 header): one transaction scoped advisory lock per tenant
 * serialises every ledger insert of the tenant, then max + 1. A refused request rolls back, so no number is consumed (gap free). No sequence.
 */
export async function nextReceiptSeq(tx: Tx, tenantId: string): Promise<number> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('billing.account_ledger_entries:' || $1::text, 0))", [tenantId]);
  const r = (await tx.query('SELECT (COALESCE(MAX(receipt_seq), 0) + 1)::text AS n FROM billing.account_ledger_entries WHERE tenant_id = $1', [tenantId])).rows[0];
  if (typeof r?.n !== 'string' || !/^[1-9][0-9]{0,15}$/.test(r.n)) throw new Error('receipt counter read failed');
  return Number(r.n);
}
export interface NewEntry {
  id: string; tenantId: string; centreId: string; partyKind: string; partyId: string; entryDate: string; particularId: string; entryType: string; amountPaisa: number;
  paymentMode: string; bankName: string | null; referenceNo: string | null; paymentDetails: string | null; comments: string | null; reversesEntryId: string | null;
  receiptNo: string; receiptSeq: number; actorId: string;
}
export async function insertEntry(tx: Tx, a: NewEntry): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.account_ledger_entries (id, tenant_id, centre_id, party_kind, party_id, entry_date, account_particular_id, entry_type, amount_paisa,
      payment_mode, bank_name, reference_no, payment_details, comments, status, reverses_entry_id, receipt_no, receipt_seq, created_by, last_modified_by)
    VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9::bigint, $10, $11, $12, $13, $14, 'submitted', $15, $16, $17, $18, $18)
    RETURNING id, centre_id, party_kind, party_id, entry_date::text AS entry_date, account_particular_id, entry_type, amount_paisa::text AS amount_paisa,
      payment_mode, bank_name, reference_no, payment_details, comments, reverses_entry_id, receipt_no, receipt_seq::text AS receipt_seq,
      created_by, last_modified_by, created_at, status`,
  [a.id, a.tenantId, a.centreId, a.partyKind, a.partyId, a.entryDate, a.particularId, a.entryType, String(a.amountPaisa), a.paymentMode, a.bankName, a.referenceNo, a.paymentDetails,
    a.comments, a.reversesEntryId, a.receiptNo, a.receiptSeq, a.actorId])).rows[0];
}
export async function getEntry(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT e.id, e.centre_id, e.party_kind, e.party_id, e.entry_date::text AS entry_date, e.account_particular_id, e.entry_type, e.amount_paisa::text AS amount_paisa,
      e.payment_mode, e.bank_name, e.reference_no, e.payment_details, e.comments, e.reverses_entry_id, e.receipt_no, e.receipt_seq::text AS receipt_seq,
      e.created_by, e.last_modified_by, e.created_at,
      CASE WHEN EXISTS (SELECT 1 FROM billing.account_ledger_entries r WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id) THEN 'reversed' ELSE e.status END AS status
    FROM billing.account_ledger_entries e WHERE e.tenant_id = $1 AND e.id = $2`, [tenantId, id])).rows[0];
}
export interface EntryFilter {
  tenantId: string; centreId?: string; partyKind?: string; partyId?: string; particularId?: string; entryType?: string; status?: string;
  dateFrom?: string; dateTo?: string; beforeSeq?: number; limit: number;
}
/** Newest first (receipt_seq DESC); keyset cursor on receipt_seq; status filters on the DERIVED status. */
export async function listEntries(tx: Tx, f: EntryFilter): Promise<Row[]> {
  return (await tx.query(`SELECT * FROM (
      SELECT e.id, e.centre_id, e.party_kind, e.party_id, e.entry_date::text AS entry_date, e.account_particular_id, e.entry_type, e.amount_paisa::text AS amount_paisa,
        e.payment_mode, e.bank_name, e.reference_no, e.payment_details, e.comments, e.reverses_entry_id, e.receipt_no, e.receipt_seq,
        e.created_by, e.last_modified_by, e.created_at,
        CASE WHEN EXISTS (SELECT 1 FROM billing.account_ledger_entries r WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id) THEN 'reversed' ELSE e.status END AS status
      FROM billing.account_ledger_entries e
      WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.centre_id = $2) AND ($3::text IS NULL OR e.party_kind = $3) AND ($4::uuid IS NULL OR e.party_id = $4)
        AND ($5::uuid IS NULL OR e.account_particular_id = $5) AND ($6::text IS NULL OR e.entry_type = $6)
        AND ($7::date IS NULL OR e.entry_date >= $7) AND ($8::date IS NULL OR e.entry_date <= $8) AND ($9::bigint IS NULL OR e.receipt_seq < $9)
    ) x WHERE ($10::text IS NULL OR x.status = $10) ORDER BY x.receipt_seq DESC LIMIT $11`,
  [f.tenantId, opt(f.centreId), opt(f.partyKind), opt(f.partyId), opt(f.particularId), opt(f.entryType), opt(f.dateFrom), opt(f.dateTo), opt(f.beforeSeq), opt(f.status), f.limit])).rows;
}

// ---------------------------------------------------------------- statement / summary (done_when 3: computed in SQL, one query each, no per row loop)
type Party = { tenantId: string; partyKind: string; partyId: string };
/** Signed sum (credits - debits) before `from`, as text (bigint). */
export async function openingBalance(tx: Tx, p: Party & { from: string }): Promise<string> {
  return (await tx.query(`SELECT COALESCE(SUM(CASE e.entry_type WHEN 'credit' THEN e.amount_paisa ELSE -e.amount_paisa END), 0)::text AS s FROM billing.account_ledger_entries e
    WHERE e.tenant_id = $1 AND e.party_kind = $2 AND e.party_id = $3 AND e.entry_date < $4::date`, [p.tenantId, p.partyKind, p.partyId, p.from])).rows[0].s;
}
/** Rows of the range in entry order (entry_date, receipt_seq) with the running signed sum of the range; at most `limit` rows; status is the derived one. */
export async function statementRows(tx: Tx, p: Party & { from: string; to: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT e.id, e.entry_date::text AS entry_date, e.receipt_no, e.entry_type, e.account_particular_id, e.reverses_entry_id, e.amount_paisa::text AS amount_paisa,
      (SUM(CASE e.entry_type WHEN 'credit' THEN e.amount_paisa ELSE -e.amount_paisa END)
        OVER (ORDER BY e.entry_date, e.receipt_seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::text AS running,
      CASE WHEN EXISTS (SELECT 1 FROM billing.account_ledger_entries r WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id) THEN 'reversed' ELSE e.status END AS status
    FROM billing.account_ledger_entries e
    WHERE e.tenant_id = $1 AND e.party_kind = $2 AND e.party_id = $3 AND e.entry_date BETWEEN $4::date AND $5::date
    ORDER BY e.entry_date, e.receipt_seq LIMIT $6`, [p.tenantId, p.partyKind, p.partyId, p.from, p.to, p.limit])).rows;
}
/** Signed sum over every entry of the party (no date), as text. */
export async function outstanding(tx: Tx, p: Party): Promise<string> {
  return (await tx.query(`SELECT COALESCE(SUM(CASE e.entry_type WHEN 'credit' THEN e.amount_paisa ELSE -e.amount_paisa END), 0)::text AS s FROM billing.account_ledger_entries e
    WHERE e.tenant_id = $1 AND e.party_kind = $2 AND e.party_id = $3`, [p.tenantId, p.partyKind, p.partyId])).rows[0].s;
}
