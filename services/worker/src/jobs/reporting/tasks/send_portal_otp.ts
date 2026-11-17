// Task reporting.send_portal_otp (02-TRD §9; 08 A13 D-31; 01-PRD AC-11.1, AC-11.4; 07-SECURITY T4, A4, A21, REQ-SEC-070).
// Lock the challenge (a duplicate run waits, then sees `pending` and exits) -> resolve the destination as the system actor (patient contact on file) -> store the
// destination hash + HMAC of a fresh CSPRNG code, status `pending` -> NotificationPort.sendSms / sendEmailLink (template reporting.portal_otp, purpose otp).
// No contact (or a contact that no longer matches the link's destination) -> `failed` / no_contact; the per-destination limit of NotificationPort (common.rate_limited)
// -> `superseded` / send_rate_limited. Both RESOLVE (P2 then answers auth.otp_invalid like any wrong code). Any other failure THROWS: the tx rolls back and the
// challenge stays `pending_send` for the queue retry. The code exists only in this job's memory and the notification params; no phone / code / token is logged.
// [CONV] referrer / centre recipients (CatalogPort / centre_contacts destinations, D-31 (a)) are not resolved here yet: they end `failed` / no_contact.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TaskHandler } from '../../../core/manifest.js';
import { generateOtp, otpHmac, OTP_MAX_TTL_SECONDS } from '../../../../../api/src/modules/reporting/domain/otp.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE = 'reporting.portal_otp';
const RATE_LIMITED_METRIC = 'lims_reporting_otp_send_rate_limited_total';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
/** The template's lab_name param is short_text (<= 40 of [A-Za-z0-9 .,:/()-]): strip, clip, never fail the send on a fancy name. */
const labParam = (name: unknown) => (typeof name === 'string' ? name.replace(/[^A-Za-z0-9 .,:/()-]/g, '').trim().slice(0, 40) : '') || 'Laboratory';

export function createSendPortalOtp(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const challengeId = payload?.['challenge_id'];
    if (typeof tenantId !== 'string' || payload?.['tenant_id'] !== tenantId || typeof challengeId !== 'string' || !UUID.test(challengeId)) {
      ctx.log?.warn?.({ event: 'send_portal_otp_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx;
    const rows = async (sql: string, values: unknown[]): Promise<Row[]> => (await tx.query(sql, values)).rows;
    const now: string = ctx.now();

    const c = (await rows(`SELECT id, link_id, channel, status, expires_at FROM reporting.otp_challenges WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, challengeId]))[0];
    if (!c || c['status'] !== 'pending_send' || Date.parse(c['expires_at']) <= Date.parse(now)) { ctx.log?.info?.({ event: 'send_portal_otp_noop' }); return; }

    const fail = async (status: 'failed' | 'superseded', failureCode: 'no_contact' | 'send_rate_limited') => {
      await tx.query(`UPDATE reporting.otp_challenges SET status = $3, failure_code = $4, code_hmac = NULL WHERE tenant_id = $1 AND id = $2 AND status IN ('pending_send', 'pending')`,
        [tenantId, challengeId, status, failureCode]);
    };

    // 1. who gets the code: the link's patient (D-31 (b)), checked against the destination the link was sent to (a)
    const link = (await rows(`SELECT id, report_id, recipient_kind, destination_sha256 FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`, [tenantId, c['link_id']]))[0];
    const report = link && (await rows(`SELECT id, patient_id FROM reporting.reports WHERE tenant_id = $1 AND id = $2`, [tenantId, link['report_id']]))[0];
    if (!link || !report || link['recipient_kind'] !== 'patient') { await fail('failed', 'no_contact'); return; }
    let contact: unknown;
    try {
      const d = await ctx.ports.FrontdeskPort.getPatientDemographics(ctx, { patientId: report['patient_id'], purpose: 'notification' });
      contact = c['channel'] === 'email' ? d?.email : d?.phoneE164;
    } catch (e) {
      if ((e as Row)?.code !== 'common.not_found') throw e;                          // transient / permission problems retry
    }
    const destination = typeof contact === 'string' && contact ? sha256(contact) : undefined;
    if (!destination || (link['destination_sha256'] && !Buffer.from(link['destination_sha256']).equals(destination))) { await fail('failed', 'no_contact'); return; }

    // 2. fresh code: only its HMAC is stored; the send happens after the write so a failed write never sends a code nobody can verify
    const code = generateOtp();
    const hmac = Buffer.from(otpHmac(new Uint8Array(readFileSync(process.env['LIMS_REPORTING_OTP_HMAC_KEY_FILE']!)), challengeId, code));
    const stored = await rows(`UPDATE reporting.otp_challenges SET status = 'pending', destination_sha256 = $3, code_hmac = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'pending_send' RETURNING id`,
      [tenantId, challengeId, destination, hmac]);
    if (!stored[0]) return;

    const lab = (await rows(`SELECT lab_name_snapshot FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_id = $2 ORDER BY issued_at DESC LIMIT 1`, [tenantId, report['id']]))[0];
    const base = { recipient: { kind: 'patient', patientId: report['patient_id'] }, templateCode: TEMPLATE, purpose: 'otp',
      params: { otp_code: code, lab_name: labParam(lab?.['lab_name_snapshot']), minutes: String(OTP_MAX_TTL_SECONDS / 60) }, idempotencyKey: `portal_otp:${challengeId}` };
    const notification = ctx.ports.NotificationPort;
    try {
      const sent = c['channel'] === 'email'
        ? await notification.sendEmailLink(ctx, { ...base, linkUrl: process.env['LIMS_ORIGIN_PORTAL'] })
        : await notification.sendSms(ctx, base);
      if (sent?.status !== 'queued') { await fail('failed', 'no_contact'); return; }   // suppressed (consent / channel): no oracle, same as no contact
    } catch (e) {
      if ((e as Row)?.code !== 'common.rate_limited') throw e;
      await fail('superseded', 'send_rate_limited');
      ctx.metrics?.inc?.(RATE_LIMITED_METRIC);
      return;
    }
    await ctx.audit.access({ action: 'auth.otp_sent', entityType: 'otp_challenge', entityId: challengeId, outcome: 'allowed', detail: { channel: String(c['channel']) } });
  };
}
