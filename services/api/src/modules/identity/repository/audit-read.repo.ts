// C2-T18 audit viewer reads (02-TRD §5.9; 03-APP-FLOW §7.1; 05-SCHEMA §3.2). Read-only: the view access log goes through ctx.audit.access.
// Every statement binds tenant_id = $1 (REQ-SEC-024) on top of RLS; audit/access statements repeat the CR-C2-010 centre clause in the
// policy's cast form (08 A16.1). Keyset on (occurred_at, id); `cursor_at` is the exact (microsecond) timestamp for the next cursor.
// Optional filters are `($n IS NULL OR col = $n)`: node-postgres sends unnamed statements, so each run gets a custom plan.

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface Keyset { readonly at: string; readonly id: string }

const AUDIT_LIST_DESC = `SELECT a.id, a.occurred_at, a.occurred_at::text AS cursor_at, a.schema_name, a.table_name, a.row_id, a.action,
    a.changed_columns, a.actor_id, a.actor_type, a.membership_id, a.centre_id, a.request_id, a.support_session_id, u.display_name
  FROM audit.audit_log a
  LEFT JOIN core.users u ON u.tenant_id = a.tenant_id AND u.id = a.actor_id AND a.actor_type = 'user'
  WHERE a.tenant_id = $1 AND a.occurred_at >= $2::timestamptz AND a.occurred_at <= $3::timestamptz
    AND (a.occurred_at, a.id) < ($4::timestamptz, $5::uuid)
    AND ($6::text IS NULL OR a.schema_name = $6) AND ($7::text IS NULL OR a.table_name = $7) AND ($8::text IS NULL OR a.action = $8)
    AND ($9::uuid IS NULL OR a.row_id = $9) AND ($10::uuid IS NULL OR a.actor_id = $10) AND ($11::uuid IS NULL OR a.membership_id = $11)
    AND ($12::uuid IS NULL OR a.centre_id = $12) AND ($13::uuid IS NULL OR a.request_id = $13)
    AND ($14::uuid IS NULL OR a.support_session_id = $14)
    AND (a.centre_id IS NULL OR (SELECT app.has_all_centres()) OR a.centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))
  ORDER BY a.occurred_at DESC, a.id DESC
  LIMIT $15`;

const AUDIT_LIST_ASC = `SELECT a.id, a.occurred_at, a.occurred_at::text AS cursor_at, a.schema_name, a.table_name, a.row_id, a.action,
    a.changed_columns, a.actor_id, a.actor_type, a.membership_id, a.centre_id, a.request_id, a.support_session_id, u.display_name
  FROM audit.audit_log a
  LEFT JOIN core.users u ON u.tenant_id = a.tenant_id AND u.id = a.actor_id AND a.actor_type = 'user'
  WHERE a.tenant_id = $1 AND a.occurred_at >= $2::timestamptz AND a.occurred_at <= $3::timestamptz
    AND (a.occurred_at, a.id) > ($4::timestamptz, $5::uuid)
    AND ($6::text IS NULL OR a.schema_name = $6) AND ($7::text IS NULL OR a.table_name = $7) AND ($8::text IS NULL OR a.action = $8)
    AND ($9::uuid IS NULL OR a.row_id = $9) AND ($10::uuid IS NULL OR a.actor_id = $10) AND ($11::uuid IS NULL OR a.membership_id = $11)
    AND ($12::uuid IS NULL OR a.centre_id = $12) AND ($13::uuid IS NULL OR a.request_id = $13)
    AND ($14::uuid IS NULL OR a.support_session_id = $14)
    AND (a.centre_id IS NULL OR (SELECT app.has_all_centres()) OR a.centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))
  ORDER BY a.occurred_at ASC, a.id ASC
  LIMIT $15`;

const AUDIT_BY_ID = `SELECT a.id, a.occurred_at, a.schema_name, a.table_name, a.row_id, a.action, a.changed_columns, a.old_values, a.new_values,
    a.actor_id, a.actor_type, a.membership_id, a.centre_id, a.request_id, a.support_session_id, a.client_ip, a.user_agent, u.display_name
  FROM audit.audit_log a
  LEFT JOIN core.users u ON u.tenant_id = a.tenant_id AND u.id = a.actor_id AND a.actor_type = 'user'
  WHERE a.tenant_id = $1 AND a.id = $2::uuid
    AND (a.centre_id IS NULL OR (SELECT app.has_all_centres()) OR a.centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))`;

const ACCESS_LIST = `SELECT id, occurred_at, occurred_at::text AS cursor_at, centre_id, actor_id, actor_type, membership_id, support_session_id,
    action, entity_type, entity_id, purpose_code, outcome, detail, request_id, client_ip, user_agent
  FROM audit.access_log
  WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at <= $3::timestamptz
    AND (occurred_at, id) < ($4::timestamptz, $5::uuid)
    AND ($6::text IS NULL OR action = $6) AND ($7::text IS NULL OR entity_type = $7) AND ($8::uuid IS NULL OR entity_id = $8)
    AND ($9::uuid IS NULL OR actor_id = $9) AND ($10::uuid IS NULL OR membership_id = $10) AND ($11::uuid IS NULL OR centre_id = $11)
    AND ($12::text IS NULL OR outcome = $12)
    AND (centre_id IS NULL OR (SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))
  ORDER BY occurred_at DESC, id DESC
  LIMIT $13`;

const AUTH_LIST = `SELECT id, occurred_at, occurred_at::text AS cursor_at, tenant_id, user_id, membership_id, platform_staff_id, session_id,
    event_type, reason_code, client_ip, user_agent, request_id
  FROM identity.auth_events
  WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at <= $3::timestamptz
    AND (occurred_at, id) < ($4::timestamptz, $5::uuid)
    AND ($6::text IS NULL OR event_type = $6) AND ($7::uuid IS NULL OR membership_id = $7)
  ORDER BY occurred_at DESC, id DESC
  LIMIT $8`;

export interface ListBase { readonly tenantId: string; readonly from: string; readonly to: string; readonly after: Keyset; readonly limit: number }
const n = (v: unknown) => v ?? null;

export async function listAudit(tx: Tx, p: ListBase & { asc: boolean; f: Record<string, string | undefined> }): Promise<any[]> {
  const f = p.f;
  return (await tx.query(p.asc ? AUDIT_LIST_ASC : AUDIT_LIST_DESC, [p.tenantId, p.from, p.to, p.after.at, p.after.id, n(f.schema_name), n(f.table_name),
    n(f.action), n(f.row_id), n(f.actor_id), n(f.membership_id), n(f.centre_id), n(f.request_id), n(f.support_session_id), p.limit])).rows;
}

export async function getAudit(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  return (await tx.query(AUDIT_BY_ID, [tenantId, id])).rows[0];
}

export async function listAccess(tx: Tx, p: ListBase & { f: Record<string, string | undefined> }): Promise<any[]> {
  const f = p.f;
  return (await tx.query(ACCESS_LIST, [p.tenantId, p.from, p.to, p.after.at, p.after.id, n(f.action), n(f.entity_type), n(f.entity_id),
    n(f.actor_id), n(f.membership_id), n(f.centre_id), n(f.outcome), p.limit])).rows;
}

export async function listAuth(tx: Tx, p: ListBase & { f: Record<string, string | undefined> }): Promise<any[]> {
  return (await tx.query(AUTH_LIST, [p.tenantId, p.from, p.to, p.after.at, p.after.id, n(p.f.event_type), n(p.f.membership_id), p.limit])).rows;
}
