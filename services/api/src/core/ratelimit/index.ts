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
  /** LD-410: non-consuming read (hits in the sliding window, latest hit of the key); optional, a backend without it fails closed. */
  peek?(keyHash: string, windowSeconds: number): Promise<RateLimitPeek>;
  /** LD-410: delete every counter of one key. */
  clear?(keyHash: string): Promise<void>;
}
export interface RateLimitPeek { hits: number; lastHit: Date | null }
type LogFn = (obj: object, msg?: string) => void;
export interface RateLimiterOptions {
  backend: RateLimitBackend;
  hmacKey: string | Buffer;
  log?: { info: LogFn; warn: LogFn; error: LogFn };
  metrics?: { inc(name: string, labels?: Record<string, string>): void };
  tenant?: { rps?: number; burst?: number }; // LIMS_CORE_TENANT_RPS / _BURST
}
export interface RateLimiter {
  consume(tier: RateLimitTier, key: string): Promise<void>;
  /** LD-410: only keys with a PEEK window below; never consumes. Fails closed like consume. */
  peek(tier: RateLimitTier, key: string): Promise<RateLimitPeek>;
  clear(tier: RateLimitTier, key: string): Promise<void>;
}

/** OTP TTL ≤ 10 min (04 A9): the otp_verify counter lives at most that long. */
const OTP_LIFETIME_SECONDS = 600;
/** Fail open only for `general`; every other tier is a brute-force / flood surface (REQ-SEC-078). */
const FAIL_OPEN: ReadonlySet<RateLimitTier> = new Set(['general']);

const PAYMENTS_CB = 'payments:cb:';
/** int4 max: a rule that only records (its counter is read back with peek, never refused by consume). */
const RECORD_ONLY = 2_147_483_647;
/** SEC-ABUSE-1 (LD-237 (1), LD-410): the staff-login failure windows of handlers/loginStaff.ts, store-backed.
 *  Windows are the ones the process Maps had (03-APP-FLOW §3.3, 08 A1); loginStaff.ts holds the thresholds. */
const LOGIN_WINDOWS = {
  'x:': 3600, // account failures, sliding 60 min
  'f:': 600,  // IP failures, sliding 10 min
  'w:': 600,  // IP failure-window start marker (first failure of a 10 min run)
  't:': 1800, // IP throttle engaged marker, 30 min
} as const;
const PEEK: Partial<Record<RateLimitTier, Record<string, number>>> = { login: LOGIN_WINDOWS };

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
    // SEC-ABUSE-1 (LD-237 (3)): 'i:<hmac(ip)>' = a public operation without claims; same per-client bucket as 'u:'.
    general: { 'u:': (b, h) => b.tokenBucket(h, 10, 20), 't:': (b, h) => b.tokenBucket(h, tRps, tBurst), 'i:': (b, h) => b.tokenBucket(h, 10, 20) },
    ingest: { 'd:': (b, h) => b.slidingWindow(h, 60, 60) },
    // 'a:' = the hourly attempt cap; the record-only keys are read with peek (LD-410); 'g:' = attempts while the IP is throttled, 5 / 60 s.
    login: {
      'a:': (b, h) => b.slidingWindow(h, 3600, 10),
      ...Object.fromEntries(Object.entries(LOGIN_WINDOWS).map(([p, w]) => [p, (b: RateLimitBackend, h: string) => b.slidingWindow(h, w, RECORD_ONLY)])),
      'g:': (b, h) => b.slidingWindow(h, 60, 5),
    },
    otp_request: { 'p:': (b, h) => b.slidingWindow(h, 3600, 3) },
    otp_verify: { 'o:': (b, h) => b.counter(h, 5, OTP_LIFETIME_SECONDS) },
    qr_verify: { 'i:': (b, h) => b.slidingWindow(h, 86400, 100) },
    report_download: { 'l:': (b, h) => b.slidingWindow(h, 3600, 20) },
  };

  const mac = (tier: RateLimitTier, key: string) => createHmac('sha256', hmacKey).update(`${tier}|${key}`).digest('hex');
  /** peek/clear: same HMAC and prefix lookup as consume; any backend failure (or a backend without peek/clear) fails closed. */
  async function store<T>(tier: RateLimitTier, key: string, run: (h: string, windowSeconds: number) => Promise<T>): Promise<T> {
    const w = typeof key === 'string' && key.length > 2 ? PEEK[tier]?.[key.slice(0, 2)] : undefined;
    if (w === undefined) throw new Error('ratelimit: unknown tier or key prefix');
    try { return await run(mac(tier, key), w); } catch {
      log?.error({ event: 'ratelimit_backend_down', tier }, 'rate-limit backend unavailable');
      throw new LimsError('common.dependency_unavailable');
    }
  }

  return {
    peek: (tier, key) => store(tier, key, async (h, w) => {
      const r = await backend.peek!(h, w);
      if (!r || !Number.isFinite(r.hits)) throw new Error('ratelimit: bad peek');
      return r;
    }),
    clear: (tier, key) => store(tier, key, (h) => backend.clear!(h)),
    async consume(tier, key) {
      const rules = Object.hasOwn(RULES, tier) ? RULES[tier] : undefined;
      // LD-121 (C15 PG-T09): tier `general` also accepts `payments:cb:<intent_id>` (02-TRD §6.3 step 2, D-116),
      // same per-key bucket as `u:` (10/s, burst 20). Every other key/tier keeps the 2-char prefix lookup.
      const rule = typeof key === 'string' && key.length > 2
        ? (tier === 'general' && key.startsWith(PAYMENTS_CB) && key.length > PAYMENTS_CB.length ? rules?.['u:'] : rules?.[key.slice(0, 2)])
        : undefined;
      if (!rule) throw new Error('ratelimit: unknown tier or key prefix'); // programmer error, never fails open
      // Tier in the MAC input: the same key under two tiers never shares a counter.
      const keyHash = mac(tier, key);
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
