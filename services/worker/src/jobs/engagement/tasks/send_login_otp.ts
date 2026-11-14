// Task engagement.send_login_otp (02-TRD §4.1 step 2, §8.1 max 3, §9 sendSms row; PRD US-EN-01.2, .9; 07-SECURITY OTP rows). Job key otp:<challenge_id>.
// Re-read the challenge (tenant-scoped, FOR UPDATE): anything but a live `pending` one (unknown, other tenant, sent, superseded, verified, failed, expired) is a silent
// no-op, so duplicates and races send nothing. Then: earlier pending/sent challenges of the same phone + app instance -> superseded; decrypt the code; sendSms as the
// system actor with idempotencyKey otp:<id>; ciphertext -> NULL, status sent, send_delivery_id; access log auth.otp_sent.
// C6 common.rate_limited (or a suppressed outcome) -> challenge `failed`, no throw. Any other port error / unknown status THROWS while attempt < maxAttempts: the tx rolls
// back (still pending, ciphertext kept) and the retry reuses the key; on the last attempt the challenge is `failed` (TRD §8.1, review T-A2 item 1). Phone, code, token and ciphertext are never logged, audited or put in an error (02-CV §9.2).
import type { TaskHandler } from '../../../core/manifest.js';
import { decryptOtpCode } from '../../../../../api/src/modules/engagement/service/auth.service.js';
import * as otpRepo from '../../../../../api/src/modules/engagement/repository/otp.repo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORT_SUPPRESSED = new Set(['suppressed_no_consent', 'suppressed_no_contact', 'suppressed_channel_disabled', 'suppressed_channel_off']);
/** short_text template param (<= 40 of [A-Za-z0-9 .,:/()-]): strip, clip, never fail the send on a fancy lab name. */
const labParam = (name: unknown) => (typeof name === 'string' ? name.replace(/[^A-Za-z0-9 .,:/()-]/g, '').trim().slice(0, 40) : '') || 'Laboratory';

export function createSendLoginOtp(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const id = payload?.['challenge_id'];
    if (typeof tenantId !== 'string' || (payload?.['tenant_id'] !== undefined && payload['tenant_id'] !== tenantId) || typeof id !== 'string' || !UUID.test(id)) {
      ctx.log?.warn?.({ event: 'send_login_otp_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx; const now: string = ctx.now();
    const ch = await otpRepo.loadForSend(tx, { tenantId, id });
    if (!ch || ch['status'] !== 'pending' || !(Date.parse(ch['expires_at']) > Date.parse(now)) || !ch['code_ciphertext'] || !ch['code_key_id']) {
      ctx.log?.info?.({ event: 'send_login_otp_noop' });
      return;
    }

    await otpRepo.supersedeEarlier(tx, { tenantId, id, phoneHmac: ch['phone_hmac'], appInstanceId: ch['app_instance_id'], createdAt: ch['created_at'] });
    const code = decryptOtpCode(id, ch['code_key_id'], ch['code_ciphertext']);
    const tenantSettings = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['branding'] });
    const minutes = Math.max(1, Math.round((Date.parse(ch['expires_at']) - Date.parse(ch['created_at'])) / 60_000));

    // TRD §8.1 (02-TRD.md:655): after 3 failures the challenge is `failed` -> on the last attempt never rethrow, fail it (ciphertext NULL).
    const lastAttempt = !(typeof ctx.attempt === 'number' && typeof ctx.maxAttempts === 'number' && ctx.attempt < ctx.maxAttempts);
    let sent: { deliveryId?: string; status?: string } | undefined;
    try {
      sent = await ctx.ports.NotificationPort.sendSms(ctx, {
        recipient: { kind: 'phone_otp', phoneE164: ch['phone_e164'] }, templateCode: 'engagement.login_otp', purpose: 'otp',
        params: { otp_code: code, lab_name: labParam(tenantSettings?.branding?.displayName), minutes: String(minutes) }, idempotencyKey: `otp:${id}`,
      });
    } catch (e) {
      if ((e as { code?: unknown })?.code !== 'common.rate_limited' && !lastAttempt) throw e; // transient: rollback + retry
      await otpRepo.markFailed(tx, { tenantId, id }); // rate-limited or retries exhausted: the app's resend timer shows the generic message
      return;
    }
    if (sent?.status === 'queued' && typeof sent.deliveryId === 'string') {
      await otpRepo.markSent(tx, { tenantId, id, deliveryId: sent.deliveryId });
      await ctx.audit.access({ action: 'auth.otp_sent', entityType: 'otp_challenge', entityId: id, outcome: 'success' });
    } else if (PORT_SUPPRESSED.has(sent?.status as string) || lastAttempt) {
      await otpRepo.markFailed(tx, { tenantId, id }); // nothing left the gateway: the code can never be used
    } else {
      throw new Error('send_login_otp: unexpected NotificationPort status'); // fail closed: retry, never record an unknown outcome
    }
  };
}
