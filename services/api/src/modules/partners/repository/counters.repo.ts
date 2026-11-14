// C13 T08 — partners.manifest_counters (05-SCHEMA §3.7; 03-APP-FLOW §4.1 M1). One atomic upsert per number: the row lock it takes is held to the end of
// the request transaction, so concurrent creates of one partner serialise here and never see the same last_seq.
export type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }> };
export interface Scope { readonly tx: Q; readonly tenantId: string; readonly partnerId: string; readonly actorId: string }

export async function nextSeq(s: Scope, yy: number): Promise<number> {
  const { rows } = await s.tx.query(
    'INSERT INTO partners.manifest_counters (tenant_id, partner_id, yy, last_seq, created_by, updated_by) VALUES ($1, $2, $3, 1, $4, $4) '
    + 'ON CONFLICT (tenant_id, partner_id, yy) DO UPDATE SET last_seq = partners.manifest_counters.last_seq + 1, updated_at = now(), updated_by = $4 RETURNING last_seq',
    [s.tenantId, s.partnerId, yy, s.actorId]);
  return Number(rows[0]!['last_seq']);
}
