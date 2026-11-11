// identity.invitations writes of the users API (02-TRD §5.3; 03-APP-FLOW §4.1, §4.5; 05-SCHEMA §4.4). SQL on the request tx; every statement
// names tenant_id on top of RLS (REQ-SEC-040). A row is created pending with its expiry; identity.send_invitation moves it to sent.
type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export function createInvitationsRepo() {
  return {
    async insertInvitation(tx: unknown, tenantId: string, i: { id: string; membershipId: string; userId: string; email: string; expiresAt: Date; actorId: string }): Promise<void> {
      await (tx as Tx).query(`INSERT INTO identity.invitations (id, tenant_id, user_id, membership_id, email, status, expires_at, invited_by, created_by, updated_by)
        VALUES ($2, $1, $3, $4, $5, 'pending', $6, $7, $7, $7)`, [tenantId, i.id, i.userId, i.membershipId, i.email, i.expiresAt, i.actorId]);
    },
    async revokeOpenInvitations(tx: unknown, tenantId: string, membershipId: string, actorId: string): Promise<void> {
      await (tx as Tx).query(`UPDATE identity.invitations SET status = 'revoked', version = version + 1, updated_at = now(), updated_by = $3
        WHERE tenant_id = $1 AND membership_id = $2 AND status IN ('pending', 'sent')`, [tenantId, membershipId, actorId]);
    },
  };
}
