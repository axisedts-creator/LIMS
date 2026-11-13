// E1 getPatientAppConfig + E2 requestPatientOtp (02-TRD §4.1 step 1, §4.2, §5; 05-SCHEMA otp_challenges, number_counters, settings; PRD US-EN-01.1, .6-.9; 07-SECURITY E2).
// Pre-auth context: tenant from the credential only. E2 never reads engagement.accounts (identical answer with/without an account) and never sends:
// it stores the challenge (hashes + AES-GCM ciphertext of the code) and enqueues engagement.send_login_otp (job_key otp:<id>, payload carries no secret).
// Nothing secret or personal is logged, audited or put in a metric label or an error (02-CV §9.2). Field errors are fixed text, never an echo of the input.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { randomToken, sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { loadEngagementConfig, type EngagementConfig } from '../config.js';
import { generateOtp, isWellFormedOtp } from '../domain/otp.js';
import { hasAllowedPrefix, isE164, maskPhone } from '../domain/phone.js';
import { engagementMetrics } from '../metrics.js';
import * as accountsRepo from '../repository/accounts.repo.js';
import * as otpRepo from '../repository/otp.repo.js';
import { getEngagementSettings } from '../repository/settings.repo.js';
import { DEFAULT_SETTINGS } from './settings.service.js';

export interface AuthCtx {
  readonly tenantId?: string; readonly actor?: { readonly type?: string; readonly id: string }; readonly tx?: unknown;
  now(): string; ports?: any; rateLimit?: { consume(tier: string, key: string): Promise<void> };
  audit?: { access(entry: Record<string, unknown>): Promise<void> }; commitOnError?(): void;
}
type Scope = { tx: any; tenantId: string; actorId: string };
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS = ['android', 'ios'];
const BODY_KEYS = ['phone_e164', 'app_instance_id', 'app_platform'];
const RESEND_AFTER_SECONDS = 60; // 04 A9
const CODE_LENGTH = 6; // domain/otp.ts OTP_LENGTH; E3 accepts ^[0-9]{6}$
const MAX_ATTEMPTS = 5; // 04 A9; otp_challenges__attempts__ck
const IV_BYTES = 12; const TAG_BYTES = 16;

let cfg: EngagementConfig | undefined;
const config = (): EngagementConfig => (cfg ??= loadEngagementConfig()); // validated once; key files are read lazily below
const keyCache = new Map<string, Buffer>();
const keyFile = (path: string): Buffer => { let k = keyCache.get(path); if (!k) { k = readFileSync(path); keyCache.set(path, k); } return k; };
const encKeys = (): Array<[string, Buffer]> =>
  Object.entries(JSON.parse(keyFile(config().otpEncKeysFile).toString('utf8')) as Record<string, string>).map(([id, b64]) => [id, Buffer.from(b64, 'base64')]);

/** HMAC-SHA256(otp key, challenge_id ‖ ':' ‖ code), raw 32 bytes (TRD §4.1). */
export const codeHmac = (challengeId: string, code: string): Buffer => createHmac('sha256', keyFile(config().otpHmacKeyFile)).update(`${challengeId}:${code}`).digest();
/** HMAC-SHA256(phone key, tenant_id ‖ ':' ‖ phone_e164), raw 32 bytes (TRD §4.3). */
export const phoneHmac = (tenantId: string, phone: string): Buffer => createHmac('sha256', keyFile(config().phoneHmacKeyFile)).update(`${tenantId}:${phone}`).digest();

/** AES-256-GCM under the newest key ([CONV] newest = last entry of the key file); layout iv(12) | ciphertext | tag(16); aad = challenge_id. */
export function encryptOtpCode(challengeId: string, code: string): { ciphertext: Buffer; keyId: string } {
  const [keyId, key] = encKeys().at(-1)!;
  const iv = randomBytes(IV_BYTES); const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(challengeId));
  const body = Buffer.concat([c.update(code, 'utf8'), c.final()]);
  return { ciphertext: Buffer.concat([iv, body, c.getAuthTag()]), keyId };
}
/** Throws on an unknown key id, a wrong aad or a tampered ciphertext (GCM tag). */
export function decryptOtpCode(challengeId: string, keyId: string, ciphertext: Uint8Array): string {
  const key = encKeys().find(([id]) => id === keyId)?.[1]; const buf = Buffer.from(ciphertext);
  if (!key || buf.length < IV_BYTES + TAG_BYTES) throw new Error('otp: cannot decrypt');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES)); d.setAAD(Buffer.from(challengeId)); d.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
  return Buffer.concat([d.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)), d.final()]).toString('utf8');
}

const invalid = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
function scope(ctx: AuthCtx): Scope {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || ctx.actor.type !== 'patient' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const settingsOf = async (s: Scope): Promise<Row> => (await getEngagementSettings(s.tx, { tenantId: s.tenantId })) ?? { ...DEFAULT_SETTINGS };

/** Tenant business date as yyyymmdd + seconds left in that day (for Retry-After). */
function businessDay(instant: string, timeZone: string): { key: string; secondsLeft: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  const sinceMidnight = Number(p['hour']) * 3600 + Number(p['minute']) * 60 + Number(p['second']);
  return { key: `${p['year']}${p['month']}${p['day']}`, secondsLeft: Math.max(1, 86_400 - sinceMidnight) }; // ponytail: DST days are off by an hour; Retry-After is a hint
}

export function createAuthService() {
  return {
    /** E1: tenant settings the app needs before sign-in. No tenant id, lab name or secret; calendar/timezone via the patient-readable settings keys only (08 A19 D-119). */
    async getAppConfig(ctx: AuthCtx): Promise<Record<string, unknown>> {
      const s = scope(ctx);
      const st = await settingsOf(s);
      const tenant = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone', 'calendarDisplay'] });
      const gateways: string[] = [...(st['app_gateways'] ?? [])];
      return {
        features: {
          app: st['app_enabled'] === true, bookings: st['bookings_enabled'] === true, home_collection: st['home_collection_enabled'] === true,
          payments: gateways.length > 0, // [CONV] payments are on when at least one gateway is configured
          membership: st['memberships_enabled'] === true, enquiries: st['enquiries_enabled'] === true, smart_report: st['smart_report_in_app'] === true,
        },
        min_app_version: { android: st['min_app_version_android'], ios: st['min_app_version_ios'] },
        consent: {
          ...(st['app_consent_text_version'] ? { text_version: st['app_consent_text_version'] } : {}), ...(st['app_consent_text'] ? { text: st['app_consent_text'] } : {}),
        },
        gateways,
        allowed_phone_prefixes: [...st['allowed_phone_prefixes']],
        ...(st['support_phone'] ? { support_phone: st['support_phone'] } : {}),
        calendar_display: tenant.calendarDisplay,
        timezone: tenant.timezone,
        order_poll_seconds: config().orderPollSeconds,
      };
    },

    /** E2: shape -> feature flag -> prefix -> per-phone limit -> tenant daily cap -> challenge row + job. Nothing is written before the last two gates pass. */
    async requestOtp(ctx: AuthCtx, body: unknown): Promise<{ status: 202; body: Record<string, unknown> }> {
      const s = scope(ctx);
      const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : invalid('/');
      for (const k of Object.keys(b)) if (!BODY_KEYS.includes(k)) invalid('/');
      const phone = b['phone_e164'], instance = b['app_instance_id'], platform = b['app_platform'];
      if (!isE164(phone)) invalid('/phone_e164');
      if (typeof instance !== 'string' || !UUID.test(instance)) invalid('/app_instance_id');
      if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) invalid('/app_platform');
      const phoneE164 = phone as string, appInstanceId = instance as string, appPlatform = platform as string;

      const st = await settingsOf(s);
      if (st['app_enabled'] !== true) throw new LimsError('common.feature_disabled');
      if (!hasAllowedPrefix(phoneE164, st['allowed_phone_prefixes'])) { engagementMetrics.otpRequest(ctx, 'prefix_denied'); invalid('/phone_e164'); }

      if (!ctx.rateLimit || !ctx.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve without the limiter (REQ-SEC-099)
      try { await ctx.rateLimit.consume('otp_request', `p:${phoneE164}`); } // 3 / hour / phone (04 §4); throws common.rate_limited with Retry-After
      catch (e) { if (e instanceof LimsError && e.code === 'common.rate_limited') engagementMetrics.otpRequest(ctx, 'rate_limited'); throw e; }

      const now = ctx.now(); const nowMs = Date.parse(now);
      const { timezone } = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone'] });
      const day = businessDay(now, timezone);
      const counted = await otpRepo.countDailyRequest(s.tx, {
        tenantId: s.tenantId, key: `otp_day:${day.key}`, cap: Number(st['otp_daily_cap']), createdBy: s.actorId, expiresAt: new Date(nowMs + 48 * 3_600_000).toISOString(),
      });
      if (!counted) {
        engagementMetrics.otpRequest(ctx, 'cap_reached');
        throw Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: day.secondsLeft });
      }

      const id = uuidv7(); const token = randomToken(32); const code = generateOtp();
      const { ciphertext, keyId } = encryptOtpCode(id, code);
      const expiresAt = new Date(nowMs + config().otpTtlSeconds * 1000).toISOString();
      await otpRepo.insertChallenge(s.tx, {
        id, tenantId: s.tenantId, tokenSha256: sha256Bytes(token), phoneE164, phoneHmac: phoneHmac(s.tenantId, phoneE164), appInstanceId, appPlatform,
        codeHmac: codeHmac(id, code), codeCiphertext: ciphertext, codeKeyId: keyId, createdAt: now, createdBy: s.actorId, expiresAt,
      });
      await s.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['engagement.send_login_otp', JSON.stringify({ tenant_id: s.tenantId, challenge_id: id }), `otp:${id}`]);
      engagementMetrics.otpRequest(ctx, 'queued');
      return { status: 202, body: { challenge_token: token, expires_at: expiresAt, resend_after_seconds: RESEND_AFTER_SECONDS, code_length: CODE_LENGTH } };
    },

    /**
     * E3 (02-TRD §4.1 step 3). actor.id = the challenge id (resolver, §4.2). Order: shape -> limiter -> lock challenge -> usable? -> constant-time compare.
     * Mismatch: attempts/status + access-log row survive the 401 via ctx.commitOnError() (08 A19 P-42). Match: challenge `verified` FIRST (PRE_ACC needs it), then account,
     * C2 provisioning + session; ANY failure after the match is a bare 500 and the transaction rolls back (no commitOnError) so the same code can be retried.
     */
    async verifyOtp(ctx: AuthCtx, body: unknown): Promise<{ status: 200; body: Record<string, unknown> }> {
      const s = scope(ctx);
      const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : invalid('/');
      for (const k of Object.keys(b)) if (k !== 'code') invalid('/');
      if (!isWellFormedOtp(b['code'])) invalid('/code');
      const code = b['code'] as string;
      if (!ctx.rateLimit || !ctx.ports?.IdentityPort || !ctx.audit || !ctx.commitOnError) throw new LimsError('common.service_unavailable'); // never serve without the limiter (REQ-SEC-099)
      await ctx.rateLimit.consume('otp_verify', `o:${s.actorId}`); // 5 / OTP (04 §4); throws common.rate_limited

      const ch = await otpRepo.loadForVerify(s.tx, { tenantId: s.tenantId, id: s.actorId });
      const nowMs = Date.parse(ctx.now());
      if (!ch || !['pending', 'sent'].includes(ch['status'])) { engagementMetrics.otpVerification(ctx, 'invalid'); throw new LimsError('auth.otp_invalid'); } // no write, no oracle
      if (new Date(ch['expires_at']).getTime() <= nowMs) { engagementMetrics.otpVerification(ctx, 'expired'); throw new LimsError('auth.otp_invalid'); }

      const attempts = Number(ch['attempts']) + 1;
      const stored = Buffer.from(ch['code_hmac']); const given = codeHmac(s.actorId, code);
      if (stored.length !== given.length || !timingSafeEqual(stored, given)) { // 08 A5.5: 32-byte digests, constant time
        const exhausted = attempts >= MAX_ATTEMPTS;
        await otpRepo.recordMismatch(s.tx, { tenantId: s.tenantId, id: s.actorId, attempts, status: exhausted ? 'failed' : ch['status'] });
        await ctx.audit.access({ action: 'auth.otp_failure', entityType: 'otp_challenge', entityId: s.actorId, outcome: 'denied' }); // no code, no phone
        ctx.commitOnError();
        engagementMetrics.otpVerification(ctx, exhausted ? 'exhausted' : 'invalid');
        throw new LimsError(exhausted ? 'auth.otp_attempts_exhausted' : 'auth.otp_invalid');
      }

      try {
        await otpRepo.markVerified(s.tx, { tenantId: s.tenantId, id: s.actorId, attempts });
        const phone = String(ch['phone_e164']);
        // [CONV] a NEW account takes id = challenge id: a retry after a rolled-back verify reuses it, so C2's per-accountId provisioning makes no orphan user (TRD §4.1 step 3)
        const acc = (await accountsRepo.findLiveByPhone(s.tx, { tenantId: s.tenantId, phoneE164: phone }))
          ?? await accountsRepo.insertAccount(s.tx, { id: s.actorId, tenantId: s.tenantId, phoneE164: phone, phoneHmac: Buffer.from(ch['phone_hmac']), createdBy: s.actorId });
        const ids = acc['membership_id'] ? { membershipId: String(acc['membership_id']), userId: String(acc['user_id']) }
          : await ctx.ports.IdentityPort.provisionPatientMembership(ctx, { accountId: acc['id'] });
        const session = await ctx.ports.IdentityPort.openPatientSession(ctx, { membershipId: ids.membershipId, appInstanceId: ch['app_instance_id'], appPlatform: ch['app_platform'] });
        const row = await accountsRepo.recordLogin(s.tx, {
          id: acc['id'], tenantId: s.tenantId, membershipId: ids.membershipId, userId: ids.userId, loginAt: ctx.now(), appPlatform: ch['app_platform'], updatedBy: s.actorId,
        });
        engagementMetrics.otpVerification(ctx, 'verified');
        return {
          status: 200,
          body: {
            session_token: session.sessionToken, access_token: session.accessToken, access_expires_at: session.accessExpiresAt, session_expires_at: session.sessionExpiresAt,
            account: {
              id: row['id'], phone_masked: maskPhone(phone), status: row['status'], reminders_opt_out: row['reminders_opt_out'],
              last_login_at: new Date(row['last_login_at']).toISOString(), created_at: new Date(row['created_at']).toISOString(), version: Number(row['version']),
            },
          },
        };
      } catch { throw new LimsError('common.internal'); } // port or DB failure after a match: rolled back, code stays usable; no detail echoed (TRD §6.2)
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
