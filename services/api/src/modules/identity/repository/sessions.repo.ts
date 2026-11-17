// Session lookup for the claims resolver (02-TRD §6.2 step 1). DEFINER-only: app.identity_resolve_session (05-SCHEMA §6) sets the
// app.pre_* GUCs itself and reads under FORCE RLS owner policies (05-SCHEMA §5.4; 08 A10.5, A12.1, A15.1). No direct table access here.
import type { Tx } from '../../../core/db/tx.js';

/** One output row of app.identity_resolve_session (columns verbatim). */
export interface ResolveSessionRow {
  readonly session_id: string; readonly kind: string; readonly state: string; readonly session_aal: string | null;
  readonly tenant_id: string | null; readonly tenant_status: string | null;
  readonly membership_id: string | null; readonly membership_status: string | null; readonly membership_locked: boolean | null;
  readonly partner_role: string | null;
  readonly platform_staff_id: string | null; readonly platform_role: string | null; readonly platform_allowed_cidrs: string[] | string | null;
  readonly support_session_id: string | null; readonly support_tenant_id: string | null; readonly support_tenant_status: string | null;
  readonly support_scope: string | null; readonly support_expires_at: Date | string | null;
  readonly idle_expires_at: Date | string | null; readonly absolute_expires_at: Date | string | null; readonly revoked_at: Date | string | null;
}

const SQL = 'SELECT * FROM app.identity_resolve_session($1::uuid, $2::uuid)';

export async function resolveSessionRow(tx: Pick<Tx, 'query'>, gotrueSessionId: string, sub: string): Promise<ResolveSessionRow | undefined> {
  const { rows } = await tx.query(SQL, [gotrueSessionId, sub]);
  return rows[0];
}
