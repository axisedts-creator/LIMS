// reporting.portal_payment_requests (05-SCHEMA §2.15; 08 A11.1) + the few reads PP1/PP2 need. Static SQL, values only as parameters, tenant_id always bound (REQ-SEC-024).
// The portal request path (PP1/PP2) only INSERTs and SELECTs here; every UPDATE belongs to the worker tasks (create / refresh / expire) and the DELETE to the purge.
// RLS lets a portal actor see only the requests of its own link, so the link-scoped reads below mirror that.

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

// The column list is repeated in each statement: nothing is interpolated into SQL.

export async function findLinkRecipient(tx: Tx, tenantId: string, linkId: string): Promise<{ recipient_kind: string } | undefined> {
  return (await tx.query(`SELECT recipient_kind FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`, [tenantId, linkId])).rows[0];
}

export async function findReportForPayment(tx: Tx, tenantId: string, reportId: string): Promise<{ order_id: string; state: string } | undefined> {
  return (await tx.query(`SELECT order_id, state FROM reporting.reports WHERE tenant_id = $1 AND id = $2`, [tenantId, reportId])).rows[0];
}

export async function findPortalPaymentGateways(tx: Tx, tenantId: string): Promise<string[]> {
  const s = (await tx.query(`SELECT portal_payment_gateways FROM reporting.settings WHERE tenant_id = $1`, [tenantId])).rows[0];
  return Array.isArray(s?.portal_payment_gateways) ? s.portal_payment_gateways : [];
}

/** This link's open (queued / ready) request, newest first. */
export async function findOpenRequestOfLink(tx: Tx, tenantId: string, linkId: string): Promise<any | undefined> {
  return (await tx.query(`SELECT id, link_id, report_id, order_id, gateway, status, review, intent_id, amount_paisa, action_json, failure_code, intent_expires_at, last_checked_at
    FROM reporting.portal_payment_requests WHERE tenant_id = $1 AND link_id = $2 AND status IN ('queued', 'ready') ORDER BY created_at DESC LIMIT 1`,
    [tenantId, linkId])).rows[0];
}

export async function findRequestOfLink(tx: Tx, tenantId: string, linkId: string, id: string): Promise<any | undefined> {
  return (await tx.query(`SELECT id, link_id, report_id, order_id, gateway, status, review, intent_id, amount_paisa, action_json, failure_code, intent_expires_at, last_checked_at
    FROM reporting.portal_payment_requests WHERE tenant_id = $1 AND link_id = $2 AND id = $3`, [tenantId, linkId, id])).rows[0];
}

/** Throws the PostgreSQL unique violation (23505) when another request of the order is open: the partial unique index is the arbiter. */
export async function insertQueuedRequest(tx: Tx, r: { id: string; tenantId: string; linkId: string; reportId: string; orderId: string; gateway: string; now: string; expiresAt: string }): Promise<void> {
  await tx.query(`INSERT INTO reporting.portal_payment_requests (id, tenant_id, link_id, report_id, order_id, gateway, status, review, expires_at, created_at, created_by, updated_at, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, 'queued', false, $7, $8, $3, $8, $3)`, [r.id, r.tenantId, r.linkId, r.reportId, r.orderId, r.gateway, r.expiresAt, r.now]);
}
