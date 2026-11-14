// Rate limiting (02-TRD §6.7, 04 §4, REQ-SEC-078/079, 07-SECURITY AB-18).
// Keys are HMAC-SHA256'd (server key) before reaching any backend: no PHI is stored.
import { createHmac } from 'node:crypto';
import { LimsError } from '../errors.js';

export type RateLimitTier = 'general' | 'ingest' | 'login' | 'otp_request' | 'otp_verify' | 'qr_verify' | 'report_download';
export interface RateLimitDecision { allowed: boolean; retryAfterSeconds: number }
export interface RateLimitBackend {
  slidingWindow(keyHash: string, windowSeconds: number, limit: number): Promise<RateLimitDecision>;
  tokenBucket(keyHash: string, ratePerSecond: number, burst: number): Promise<RateLimitDecision>;
  counter(keyHash: string, limit: number, ttlSeconds: number): Promise<RateLimitDecision>;
}
type LogFn = (obj: object, msg?: string) => void;
export interface RateLimiterOptions {
  backend: RateLimitBackend;
  hmacKey: string | Buffer;
  log?: { info: LogFn; warn: LogFn; error: LogFn };
  metrics?: { inc(name: string, labels?: Record<string, string>): void };
  tenant?: { rps?: number; burst?: number }; // LIMS_CORE_TENANT_RPS / _BURST
}
export interface RateLimiter { consume(tier: RateLimitTier, key: string): Promise<void> }

/** OTP TTL ≤ 10 min (04 A9): the otp_verify counter lives at most that long. */
const OTP_LIFETIME_SECONDS = 600;
/** Fail open only for `general`; every other tier is a brute-force / flood surface (REQ-SEC-078). */
const FAIL_OPEN: ReadonlySet<RateLimitTier> = new Set(['general']);

const PAYMENTS_CB = 'payments:cb:';

type Rule = (b: RateLimitBackend, h: string) => Promise<RateLimitDecision>;

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { backend, hmacKey, log, metrics } = opts;
  if (!backend || (typeof hmacKey !== 'string' && !Buffer.isBuffer(hmacKey)) || hmacKey.length === 0) {
    throw new Error('ratelimit: backend and a non-empty hmacKey are required');
  }
  const tRps = opts.tenant?.rps ?? 100;
  const tBurst = opts.tenant?.burst ?? 200;
  // tier -> key prefix -> rule (02-TRD §6.7 table).
  const RULES: Record<RateLimitTier, Record<string, Rule>> = {
    general: { 'u:': (b, h) => b.tokenBucket(h, 10, 20), 't:': (b, h) => b.tokenBucket(h, tRps, tBurst) },
    ingest: { 'd:': (b, h) => b.slidingWindow(h, 60, 60) },
    // `f:<ip>` failed-attempt rule is applied by C2 with its own thresholds; not accepted here.
    login: { 'a:': (b, h) => b.slidingWindow(h, 3600, 10) },
    otp_request: { 'p:': (b, h) => b.slidingWindow(h, 3600, 3) },
    otp_verify: { 'o:': (b, h) => b.counter(h, 5, OTP_LIFETIME_SECONDS) },
    qr_verify: { 'i:': (b, h) => b.slidingWindow(h, 86400, 100) },
    report_download: { 'l:': (b, h) => b.slidingWindow(h, 3600, 20) },
  };

  return {
    async consume(tier, key) {
      const rules = Object.hasOwn(RULES, tier) ? RULES[tier] : undefined;
      // LD-121 (C15 PG-T09): tier `general` also accepts `payments:cb:<intent_id>` (02-TRD §6.3 step 2, D-116),
      // same per-key bucket as `u:` (10/s, burst 20). Every other key/tier keeps the 2-char prefix lookup.
      const rule = typeof key === 'string' && key.length > 2
        ? (tier === 'general' && key.startsWith(PAYMENTS_CB) && key.length > PAYMENTS_CB.length ? rules?.['u:'] : rules?.[key.slice(0, 2)])
        : undefined;
      if (!rule) throw new Error('ratelimit: unknown tier or key prefix'); // programmer error, never fails open
      // Tier in the MAC input: the same key under two tiers never shares a counter.
      const keyHash = createHmac('sha256', hmacKey).update(`${tier}|${key}`).digest('hex');
      let d: RateLimitDecision;
      try {
        d = await rule(backend, keyHash);
      } catch {
        log?.error({ event: 'ratelimit_backend_down', tier }, 'rate-limit backend unavailable');
        if (FAIL_OPEN.has(tier)) return;
        throw new LimsError('common.dependency_unavailable');
      }
      if (d?.allowed === true) return;
      metrics?.inc('lims_ratelimit_rejections_total', { tier });
      const e = new LimsError('common.rate_limited');
      const r = Math.ceil(Number(d?.retryAfterSeconds));
      e.retryAfterSeconds = Number.isFinite(r) && r >= 1 ? r : 1;
      throw e;
    },
  };
}
