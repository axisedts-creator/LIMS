// Portal SQL (service/portal.service.ts P1-P7 + issuePortalLink). Moved here verbatim from the service by T0B-PRINTCFG-1 (ruling dispute 2 point 2:
// single access path, SQL only in repository/*, C6-T03; explicit tenant filter REQ-SEC-024). No behaviour change: the service passes these to tx.query.

export const INSERT_LINK = `INSERT INTO reporting.portal_links (id, tenant_id, centre_id, report_id, bound_version_no, channel, recipient_kind, patient_display_snapshot,
  token_sha256, expires_at, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`;
export const INSERT_CHALLENGE = `INSERT INTO reporting.otp_challenges (id, tenant_id, link_id, channel, status, expires_at, created_by) VALUES ($1, $2, $3, $4, 'pending_send', $5, $6)`;
export const INSERT_SESSION = `INSERT INTO reporting.portal_sessions (id, tenant_id, link_id, report_id, token_sha256, last_seen_at, idle_expires_at, absolute_expires_at,
  link_purpose, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

export const SELECT_LIVE_SESSION = `SELECT id, link_id, report_id, link_purpose, idle_expires_at, absolute_expires_at FROM reporting.portal_sessions
      WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL`;
export const SLIDE_SESSION = `UPDATE reporting.portal_sessions SET last_seen_at = $3, idle_expires_at = $4 WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL`;
export const END_SESSION = `UPDATE reporting.portal_sessions SET ended_at = $3 WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL`;

export const SELECT_REPORT_FOR_LINK = `SELECT id, centre_id, released_version_no, patient_display_name FROM reporting.reports WHERE tenant_id = $1 AND id = $2`;
export const SELECT_VERSION_STATUS = `SELECT status FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3`;
export const SELECT_REPORT_FOR_VIEW = `SELECT id, family, released_version_no, billing_balance_due_paisa FROM reporting.reports WHERE tenant_id = $1 AND id = $2`;
export const SELECT_RELEASED_VERSION = `SELECT id, version_no, report_kind, released_at, smart_summary_json FROM reporting.report_versions
        WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3 AND status = 'released'`;
export const SELECT_QR_OF_VERSION = `SELECT lab_name_snapshot, panel_names_snapshot FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_version_id = $2 AND revoked_at IS NULL`;
export const SELECT_LINK_VIEW = `SELECT recipient_kind, patient_display_snapshot FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2`;
export const SELECT_PAYMENT_GATEWAYS = `SELECT portal_payment_gateways FROM reporting.settings WHERE tenant_id = $1`;
export const SELECT_BALANCE_DUE = `SELECT billing_balance_due_paisa FROM reporting.reports WHERE tenant_id = $1 AND id = $2`;
export const SELECT_LINK_RECIPIENT_KIND = `SELECT recipient_kind FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2`;
export const SELECT_LATEST_QR_LAB_NAME = `SELECT lab_name_snapshot FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_id = $2 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`;
export const SELECT_DOWNLOAD_VERSION = `SELECT id, version_no, pdf_object_path FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 AND id = $3 AND status = 'released'`;

export const LOCK_LINK_FOR_CHALLENGE = `SELECT id, otp_channel FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL FOR UPDATE`;
export const SELECT_RECENT_CHALLENGES = `SELECT created_at FROM reporting.otp_challenges WHERE tenant_id = $1 AND link_id = $2 AND created_at > $3 ORDER BY created_at DESC LIMIT $4`;
export const SUPERSEDE_CHALLENGES = `UPDATE reporting.otp_challenges SET status = 'superseded' WHERE tenant_id = $1 AND link_id = $2 AND status IN ('pending_send', 'pending')`;
export const LOCK_CHALLENGE = `SELECT id, status, attempts, code_hmac, expires_at FROM reporting.otp_challenges WHERE tenant_id = $1 AND id = $2 AND link_id = $3 FOR UPDATE`;
export const BUMP_CHALLENGE_ATTEMPTS = `UPDATE reporting.otp_challenges SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'pending' AND attempts < $3 RETURNING attempts`;
export const EXHAUST_CHALLENGE = `UPDATE reporting.otp_challenges SET status = 'exhausted' WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`;
export const VERIFY_CHALLENGE = `UPDATE reporting.otp_challenges SET status = 'verified', verified_at = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING id`;
export const SELECT_LINK_FOR_SESSION = `SELECT id, report_id, purpose FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`;
export const MARK_LINK_USED = `UPDATE reporting.portal_links SET last_used_at = $3, use_count = use_count + 1 WHERE tenant_id = $1 AND id = $2`;

export const LOCK_LINK_FOR_REISSUE = `SELECT id, reissue_count_day, reissue_day::text AS reissue_day FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL FOR UPDATE`;
export const SELECT_REISSUE_MAX = `SELECT link_reissue_max_per_day FROM reporting.settings WHERE tenant_id = $1`;
export const SET_REISSUE_COUNT = `UPDATE reporting.portal_links SET reissue_count_day = $3, reissue_day = $4::date WHERE tenant_id = $1 AND id = $2`;
