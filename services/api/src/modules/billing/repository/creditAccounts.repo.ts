// billing.credit_accounts, keyed (tenant_id, credit_party_id).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getCreditAccount(tx: Q, a: { tenantId: string; creditPartyId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = $2', [a.tenantId, a.creditPartyId]);
  return rows[0];
}

/**
 * recordCreditCharges: refresh the P0 party snapshot (CatalogPort) and, as a side effect, take the account row lock until the caller's tx ends, so two
 * concurrent charge batches of one party serialize before the limit check. Limit, lock state and `version` (finance's If-Match) are never touched here.
 */
export async function upsertCreditAccount(tx: Q, a: { tenantId: string; creditPartyId: string; partyCode: string; partyName: string; pan?: string; address?: string; userId: string }): Promise<void> {
  await tx.query(
    `INSERT INTO billing.credit_accounts (tenant_id, credit_party_id, party_code, party_display_name, party_pan, party_address, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (tenant_id, credit_party_id) DO UPDATE SET
       party_code = EXCLUDED.party_code, party_display_name = EXCLUDED.party_display_name, party_pan = EXCLUDED.party_pan,
       party_address = EXCLUDED.party_address, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [a.tenantId, a.creditPartyId, a.partyCode, a.partyName, a.pan ?? null, a.address ?? null, a.userId]);
}

/**
 * Money the party already owes (paisa, as text): uninvoiced charges (gross - discount) + unpaid, uncredited periodic credit bills.
 * [CONV] TRD §6.3 names no source; charges carry no tax amounts, so uninvoiced exposure is pre-tax.
 */
export async function sumOpenCreditExposure(tx: Q, a: { tenantId: string; creditPartyId: string }): Promise<string> {
  const { rows } = await tx.query(
    `SELECT (
       COALESCE((SELECT SUM(c.gross_paisa - c.discount_paisa) FROM billing.credit_charges c
                  WHERE c.tenant_id = $1 AND c.credit_party_id = $2 AND c.status = 'uninvoiced'), 0)
     + COALESCE((SELECT SUM(GREATEST(i.net_paisa - i.credited_total_paisa
                         - COALESCE((SELECT SUM(l.amount_paisa) FROM billing.ledger_entries l WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id), 0), 0))
                   FROM billing.invoices i
                  WHERE i.tenant_id = $1 AND i.credit_party_id = $2 AND i.is_periodic_credit_bill AND i.status = 'issued'), 0)
     )::text AS exposure`, [a.tenantId, a.creditPartyId]);
  return rows[0]?.exposure ?? '0';
}

/**
 * T0B-PARTYSET-1 (LD-321) done_when (3): the party commercial setting of a credit party (partners.party_commercial_setting; undefined = none saved = no rule)
 * and its unpaid issued periodic credit invoices with days overdue: due date = invoice date (tenant time zone) + invoice_payment_days, overdue = today - due.
 * Unpaid = net - credited - payments posted against the invoice (the same rule as sumOpenCreditExposure).
 */
export async function overdueFacts(tx: Q, a: { tenantId: string; creditPartyId: string; today: string; timezone: string }): Promise<{
  setting?: { paymentDays: number; blockingDays: number; warningDays: number; autoBlock: boolean; interestBpPerDay: number };
  invoices: Array<{ periodMonth: string; unpaidPaisa: number; daysOverdue: number }>;
}> {
  const s = (await tx.query(`SELECT invoice_payment_days, invoice_blocking_days, invoice_warning_days, auto_block_overdue, interest_bp_per_day FROM partners.party_commercial_setting
      WHERE tenant_id = $1 AND party_kind = $3 AND party_id = $2`, [a.tenantId, a.creditPartyId, 'credit_party'])).rows[0] as Record<string, unknown> | undefined;
  if (!s) return { invoices: [] };
  const setting = { paymentDays: Number(s['invoice_payment_days']), blockingDays: Number(s['invoice_blocking_days']), warningDays: Number(s['invoice_warning_days']),
    autoBlock: s['auto_block_overdue'] === true, interestBpPerDay: Number(s['interest_bp_per_day']) };
  const { rows } = await tx.query(
    `SELECT to_char(x.period_month, 'YYYY-MM') AS period_month, x.unpaid::text AS unpaid, ($3::date - ((x.issued_at AT TIME ZONE $4::text)::date + $5::int)) AS days_overdue
       FROM (SELECT i.period_month, i.issued_at, i.net_paisa - i.credited_total_paisa
                    - COALESCE((SELECT SUM(l.amount_paisa) FROM billing.ledger_entries l WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id), 0) AS unpaid
               FROM billing.invoices i
              WHERE i.tenant_id = $1 AND i.credit_party_id = $2 AND i.is_periodic_credit_bill AND i.status = 'issued') x
      WHERE x.unpaid > 0`, [a.tenantId, a.creditPartyId, a.today, a.timezone, setting.paymentDays]);
  return { setting, invoices: rows.map((r) => ({ periodMonth: String(r['period_month']), unpaidPaisa: Number(r['unpaid']), daysOverdue: Number(r['days_overdue']) })) };
}

/** done_when (3): set the existing block flag with a visible reason (lock_reasons code credit_days_exceeded); an existing lock (manual or not) is never rewritten */
export async function lockOverdue(tx: Q, a: { tenantId: string; creditPartyId: string; userId: string }): Promise<void> {
  await tx.query(`UPDATE billing.credit_accounts SET is_locked = true, lock_reason_code = $3, locked_at = now(), locked_by = $4, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND credit_party_id = $2 AND NOT is_locked`, [a.tenantId, a.creditPartyId, 'credit_days_exceeded', a.userId]);
}

/** B19 list: keyset on credit_party_id; the caller asks for limit + 1 to learn whether a next page exists. */
export async function listCreditAccounts(tx: Q, a: { tenantId: string; afterPartyId?: string; limit: number }): Promise<Record<string, any>[]> {
  const p: unknown[] = [a.tenantId];
  let after = '';
  if (a.afterPartyId !== undefined) { p.push(a.afterPartyId); after = ' AND credit_party_id > $2::uuid'; }
  p.push(a.limit);
  return (await tx.query('SELECT * FROM billing.credit_accounts WHERE tenant_id = $1' + after + ' ORDER BY credit_party_id LIMIT $' + String(p.length), p)).rows;
}

/**
 * B19 update: finance terms + lock only (party snapshot columns are never touched). `expectedVersion` is If-Match; undefined = version moved.
 * Unlocked: locked_at / locked_by are cleared. Locked: `lockedAt` / `lockedBy` (the existing ones when the account stays locked) else now() / userId.
 */
export async function updateCreditAccount(tx: Q, a: {
  tenantId: string; creditPartyId: string; expectedVersion: number; creditLimitPaisa: number | null; creditDays: number | null; isLocked: boolean;
  lockReasonCode: string | null; lockedAt?: string | null; lockedBy?: string | null; userId: string;
}): Promise<Record<string, any> | undefined> {
  const { rows } = await tx.query(
    `UPDATE billing.credit_accounts SET credit_limit_paisa = $4, credit_days = $5, is_locked = $6::boolean, lock_reason_code = $7,
            locked_at = CASE WHEN $6::boolean THEN COALESCE($8::timestamptz, now()) END, locked_by = CASE WHEN $6::boolean THEN COALESCE($9::uuid, $10::uuid) END,
            version = version + 1, updated_at = now(), updated_by = $10
      WHERE tenant_id = $1 AND credit_party_id = $2 AND version = $3 RETURNING *`,
    [a.tenantId, a.creditPartyId, a.expectedVersion, a.creditLimitPaisa, a.creditDays, a.isLocked, a.isLocked ? a.lockReasonCode : null, a.lockedAt ?? null, a.lockedBy ?? null, a.userId]);
  return rows[0];
}

/** B23: months are first days ('YYYY-MM-01'), inclusive. The closing balance is the view's running balance (not recomputed from the filtered rows). */
export async function readCreditPartyStatement(tx: Q, a: { tenantId: string; creditPartyId: string; fromMonth: string; toMonth: string }): Promise<Record<string, any>[]> {
  const { rows } = await tx.query(
    `SELECT period_month, fiscal_year_bs, invoiced_paisa, paid_paisa, credited_paisa, closing_balance_paisa FROM billing.v_pub_credit_party_statement
      WHERE tenant_id = $1 AND credit_party_id = $2 AND period_month BETWEEN $3::date AND $4::date ORDER BY period_month, fiscal_year_bs`,
    [a.tenantId, a.creditPartyId, a.fromMonth, a.toMonth]);
  return rows;
}
