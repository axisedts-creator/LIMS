// T0B-ACCT-2 (LD-313, LD-310) lab accounting part 2 SQL: billing.expense_types, billing.expenses, billing.cash_transfers, user / centre pocket balances and the
// daily collection summary. Same rules as accounts.repo.ts: explicit tenant_id = $1 on top of RLS, bound parameters only, static SQL text.
// Expenses, expense types and cash transfers are never deleted (no DELETE grant either); the account ledger is INSERT only (accounts.repo.insertEntry).
// A decision on a transfer / a cancel of an expense locks the row first (SELECT ... FOR UPDATE) and the UPDATE is guarded again by status = 'pending' /
// cancelled_at IS NULL, so a race never decides twice (done_when 3).
type Tx = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
type Row = Record<string, any>;
const opt = (v: unknown): unknown => (v === undefined ? null : v);

// ---------------------------------------------------------------- expense types
export async function listTypes(tx: Tx, a: { tenantId: string; isActive?: boolean; beforeId?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT id, name, account_particular_id, is_active, version, created_at, updated_at FROM billing.expense_types WHERE tenant_id = $1 AND ($2::boolean IS NULL OR is_active = $2) AND ($3::uuid IS NULL OR id < $3)
    ORDER BY id DESC LIMIT $4`, [a.tenantId, opt(a.isActive), opt(a.beforeId), a.limit])).rows;
}
export async function getType(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT id, name, account_particular_id, is_active, version, created_at, updated_at FROM billing.expense_types WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
}
export async function insertType(tx: Tx, a: { id: string; tenantId: string; name: string; particularId: string; isActive: boolean; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.expense_types (id, tenant_id, name, account_particular_id, is_active, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id, name, account_particular_id, is_active, version, created_at, updated_at`, [a.id, a.tenantId, a.name, a.particularId, a.isActive, a.actorId])).rows[0];
}
/** Optimistic update: undefined when the version is stale. */
export async function updateType(tx: Tx, a: { tenantId: string; id: string; version: number; name?: string; particularId?: string; isActive?: boolean; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.expense_types SET name = COALESCE($4, name), account_particular_id = COALESCE($5::uuid, account_particular_id), is_active = COALESCE($6, is_active),
      version = version + 1, updated_at = now(), updated_by = $7
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id, name, account_particular_id, is_active, version, created_at, updated_at`,
  [a.tenantId, a.id, a.version, opt(a.name), opt(a.particularId), opt(a.isActive), a.actorId])).rows[0];
}

// ---------------------------------------------------------------- expenses
export async function insertExpense(tx: Tx, a: { id: string; tenantId: string; centreId: string; expenseAt: string; typeId: string; amountPaisa: number; description: string | null; ledgerEntryId: string; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.expenses (id, tenant_id, centre_id, expense_at, expense_type_id, amount_paisa, description, ledger_entry_id, created_by, updated_by)
    VALUES ($1, $2, $3, $4::timestamptz, $5, $6::bigint, $7, $8, $9, $9) RETURNING id, centre_id, expense_at, expense_type_id, amount_paisa::text AS amount_paisa, description, ledger_entry_id, cancelled_at, cancel_reason_text, version, created_by, created_at`,
  [a.id, a.tenantId, a.centreId, a.expenseAt, a.typeId, String(a.amountPaisa), a.description, a.ledgerEntryId, a.actorId])).rows[0];
}
/** Row lock: concurrent cancels of the same expense run one after the other. */
export async function lockExpense(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT id, centre_id, expense_at, expense_type_id, amount_paisa::text AS amount_paisa, description, ledger_entry_id, cancelled_at, cancel_reason_text, version, created_by, created_at FROM billing.expenses WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id])).rows[0];
}
export async function cancelExpense(tx: Tx, a: { tenantId: string; id: string; at: string; reason: string | null; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.expenses SET cancelled_at = $3::timestamptz, cancel_reason_text = $4, version = version + 1, updated_at = now(), updated_by = $5
    WHERE tenant_id = $1 AND id = $2 AND cancelled_at IS NULL RETURNING id, centre_id, expense_at, expense_type_id, amount_paisa::text AS amount_paisa, description, ledger_entry_id, cancelled_at, cancel_reason_text, version, created_by, created_at`, [a.tenantId, a.id, a.at, a.reason, a.actorId])).rows[0];
}
export async function listExpenses(tx: Tx, f: { tenantId: string; centreId?: string; typeId?: string; from?: string; to?: string; includeCancelled: boolean; beforeId?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT id, centre_id, expense_at, expense_type_id, amount_paisa::text AS amount_paisa, description, ledger_entry_id, cancelled_at, cancel_reason_text, version, created_by, created_at FROM billing.expenses WHERE tenant_id = $1 AND ($2::uuid IS NULL OR centre_id = $2) AND ($3::uuid IS NULL OR expense_type_id = $3)
      AND ($4::timestamptz IS NULL OR expense_at >= $4) AND ($5::timestamptz IS NULL OR expense_at <= $5) AND ($6::boolean OR cancelled_at IS NULL) AND ($7::uuid IS NULL OR id < $7)
    ORDER BY id DESC LIMIT $8`, [f.tenantId, opt(f.centreId), opt(f.typeId), opt(f.from), opt(f.to), f.includeCancelled, opt(f.beforeId), f.limit])).rows;
}

// ---------------------------------------------------------------- pockets and transfer endpoints
/** A transfer endpoint: user = an active membership of the tenant, centre = a collection centre of the tenant. */
export async function endpointExists(tx: Tx, tenantId: string, kind: string, id: string): Promise<boolean> {
  const r = kind === 'user'
    ? await tx.query("SELECT 1 FROM core.memberships WHERE tenant_id = $1 AND id = $2 AND status = 'active'", [tenantId, id])
    : await tx.query('SELECT 1 FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  return r.rows.length > 0;
}
/** Signed pocket balance (credits - debits) of a user / centre pocket, as text (bigint). */
export async function pocketBalance(tx: Tx, tenantId: string, partyId: string): Promise<string> {
  return (await tx.query(`SELECT COALESCE(SUM(CASE entry_type WHEN 'credit' THEN amount_paisa ELSE -amount_paisa END), 0)::text AS s FROM billing.account_ledger_entries
    WHERE tenant_id = $1 AND party_kind = 'user_pocket' AND party_id = $2`, [tenantId, partyId])).rows[0].s;
}
export async function particularByCode(tx: Tx, tenantId: string, code: string): Promise<string | undefined> {
  return (await tx.query('SELECT id FROM billing.account_particulars WHERE tenant_id = $1 AND code = $2', [tenantId, code])).rows[0]?.id;
}

// ---------------------------------------------------------------- cash transfers
export async function insertTransfer(tx: Tx, a: { id: string; tenantId: string; fromKind: string; fromId: string; toKind: string; toId: string; amountPaisa: number; remark: string | null; actorId: string }): Promise<Row> {
  return (await tx.query(`INSERT INTO billing.cash_transfers (id, tenant_id, from_kind, from_id, to_kind, to_id, amount_paisa, remark, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9, $9) RETURNING id, from_kind, from_id, to_kind, to_id, amount_paisa::text AS amount_paisa, status, remark, decided_by, decided_at, version, created_by, created_at`,
  [a.id, a.tenantId, a.fromKind, a.fromId, a.toKind, a.toId, String(a.amountPaisa), a.remark, a.actorId])).rows[0];
}
export async function lockTransfer(tx: Tx, tenantId: string, id: string): Promise<Row | undefined> {
  return (await tx.query(`SELECT id, from_kind, from_id, to_kind, to_id, amount_paisa::text AS amount_paisa, status, remark, decided_by, decided_at, version, created_by, created_at FROM billing.cash_transfers WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id])).rows[0];
}
export async function decideTransfer(tx: Tx, a: { tenantId: string; id: string; status: string; at: string; actorId: string }): Promise<Row | undefined> {
  return (await tx.query(`UPDATE billing.cash_transfers SET status = $3, decided_by = $5, decided_at = $4::timestamptz, version = version + 1, updated_at = now(), updated_by = $5
    WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING id, from_kind, from_id, to_kind, to_id, amount_paisa::text AS amount_paisa, status, remark, decided_by, decided_at, version, created_by, created_at`, [a.tenantId, a.id, a.status, a.at, a.actorId])).rows[0];
}
export async function listTransfers(tx: Tx, f: { tenantId: string; status?: string; fromId?: string; toId?: string; beforeId?: string; limit: number }): Promise<Row[]> {
  return (await tx.query(`SELECT id, from_kind, from_id, to_kind, to_id, amount_paisa::text AS amount_paisa, status, remark, decided_by, decided_at, version, created_by, created_at FROM billing.cash_transfers WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR from_id = $3)
      AND ($4::uuid IS NULL OR to_id = $4) AND ($5::uuid IS NULL OR id < $5) ORDER BY id DESC LIMIT $6`,
  [f.tenantId, opt(f.status), opt(f.fromId), opt(f.toId), opt(f.beforeId), f.limit])).rows;
}

// ---------------------------------------------------------------- daily collection summary (done_when 4)
/**
 * Per payment mode for one centre and day: (a) account ledger credits on that entry_date that are neither a reversal nor reversed, plus (b) the invoice
 * payments of billing.ledger_entries on that business_date with exactly getDailyCash's rules (payment rows minus |reversal / refund| rows, collected rows only,
 * listLedgerForDay), so the total reconciles with getDailyCash net + the day's net account credits. One query, summed in SQL (bigint).
 */
export async function dailyCollection(tx: Tx, a: { tenantId: string; centreId: string; day: string }): Promise<Row[]> {
  return (await tx.query(`SELECT mode AS payment_mode, SUM(n)::text AS entry_count, SUM(amt)::text AS total_paisa FROM (
      SELECT e.payment_mode AS mode, 1 AS n, e.amount_paisa AS amt FROM billing.account_ledger_entries e
      WHERE e.tenant_id = $1 AND e.centre_id = $2 AND e.entry_date = $3::date AND e.entry_type = 'credit' AND e.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM billing.account_ledger_entries r WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id)
      UNION ALL
      SELECT l.method_code, CASE l.entry_kind WHEN 'payment' THEN 1 WHEN 'reversal' THEN -1 ELSE 0 END,
        CASE l.entry_kind WHEN 'payment' THEN l.amount_paisa ELSE -abs(l.amount_paisa) END
      FROM billing.ledger_entries l
      WHERE l.tenant_id = $1 AND l.centre_id = $2 AND l.business_date = $3::date AND l.entry_kind IN ('payment', 'reversal', 'refund') AND l.collected_by_membership_id IS NOT NULL
    ) x GROUP BY mode HAVING SUM(n) <> 0 OR SUM(amt) <> 0 ORDER BY mode`, [a.tenantId, a.centreId, a.day])).rows;
}
