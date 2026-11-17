// portalSession AuthResolver (CR-C6-001, 02-TRD §6.6; 01-PRD AC-11.5; 07-SECURITY REQ-SEC-019..021/095).
// Credential `link.<token>` | `session.<token>`; only the SHA-256 of the token goes to the DEFINER lookup (CR-C6-002), as bytea.
// Every invalid case (malformed, unknown, revoked, ended, idle/absolute-expired, session of a revoked link) is the SAME module error
// `reporting.link_invalid`. A DB failure is NOT mapped to it: the throw propagates (fail closed, no "valid" oracle). Never logs a credential.
import { hashToken } from '../domain/tokens.js';

const INVALID = Object.freeze({ error: 'reporting.link_invalid' });
const CREDENTIAL = /^(link|session)\.([A-Za-z0-9_-]{22,64})$/;      // base64url of 16 / 32 random bytes (domain/tokens.ts)
const STAGES: Readonly<Record<string, readonly string[]>> = { link: ['link', 'expired_link'], session: ['session'] };

const DEFINER = 'SELECT * FROM app.reporting_resolve_portal_credential($1, $2)';
// The DEFINER does not look at the link of a session: a session of a link revoked after it started is refused here (migration note).
const LINK_NOT_REVOKED = `SELECT id FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`;

type Tx = { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> };

export const portalSessionResolver = Object.freeze({
  invalidError: 'reporting.link_invalid', // LD-66 / CR-C6-021: core pre-resolver rejections (empty / >4096) are the same 404 as every other invalid credential
  async resolve(credential: string, tx: unknown) {
    const m = typeof credential === 'string' ? CREDENTIAL.exec(credential) : null;
    if (!m) return INVALID;
    const kind = m[1]!; const token = m[2]!;
    const db = tx as Tx;
    const row = (await db.query(DEFINER, [kind, Buffer.from(hashToken(token))])).rows[0];
    if (!row || !STAGES[kind]!.includes(row.stage)) return INVALID;
    if (kind === 'session' && !(await db.query(LINK_NOT_REVOKED, [row.tenant_id, row.link_id])).rows[0]) return INVALID;
    const extraClaims: Record<string, string> = { portal_stage: row.stage, portal_report_id: row.report_id };
    if (row.session_id) extraClaims['portal_session_id'] = row.session_id;
    // LD-96 / CR C6-T43 (A37): from the DEFINER row (portal_links.purpose), never from the credential.
    if (typeof row.purpose === 'string') extraClaims['portal_link_purpose'] = row.purpose;
    return { actor: { type: 'portal', id: row.link_id }, tenantId: row.tenant_id, extraClaims };
  },
});
