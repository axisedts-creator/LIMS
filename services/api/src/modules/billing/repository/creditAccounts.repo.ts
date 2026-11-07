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
