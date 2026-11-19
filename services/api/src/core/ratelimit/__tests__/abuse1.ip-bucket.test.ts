// SEC-ABUSE-1 (LD-237): the limiter accepts the pipeline's public-IP key on tier `general` (prefix 'i:'), same shape as the other general buckets
// (token bucket), and keeps its fail-open policy ONLY for `general`. The qr_verify tier keeps its own 'i:' rule (100/day) untouched.
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../index.js';
import { KEY, recordingBackend } from './helpers.js';

const IPKEY = 'i:' + 'ab'.repeat(32);

describe('general tier: i:<hmac(ip)>', () => {
  it('is accepted (not "unknown tier or key prefix") and hits the backend once, with an HMAC-ed key', async () => {
    const { backend, calls } = recordingBackend(); const l = createRateLimiter({ backend, hmacKey: KEY } as any);
    await l.consume('general', IPKEY);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.args[0])).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(calls)).not.toContain(IPKEY);
  });
  it('a refusal from the backend is common.rate_limited with Retry-After', async () => {
    const { backend } = recordingBackend(() => ({ allowed: false, retryAfterSeconds: 3 })); const l = createRateLimiter({ backend, hmacKey: KEY } as any);
    const e: any = await l.consume('general', IPKEY).then(() => null, (x) => x);
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBe(3);
  });
  it('the same text under general and qr_verify are two counters (tier is in the MAC input)', async () => {
    const { backend, calls } = recordingBackend(); const l = createRateLimiter({ backend, hmacKey: KEY } as any);
    await l.consume('general', IPKEY); await l.consume('qr_verify', IPKEY);
    expect(calls[0]!.args[0]).not.toBe(calls[1]!.args[0]);
  });
  it('backend down on general still fails open (unchanged policy), on login still fails closed', async () => {
    const r = recordingBackend(); r.state.down = true; const l = createRateLimiter({ backend: r.backend, hmacKey: KEY } as any);
    await l.consume('general', IPKEY);
    const e: any = await l.consume('login', 'a:' + 'cd'.repeat(32)).then(() => null, (x) => x);
    expect(e.code).toBe('common.dependency_unavailable');
  });
  it('login-tier a: threshold is unchanged: sliding window 3600 s, limit 10', async () => {
    const { backend, calls } = recordingBackend(); const l = createRateLimiter({ backend, hmacKey: KEY } as any);
    await l.consume('login', 'a:' + 'ef'.repeat(32));
    expect(calls[0]).toMatchObject({ kind: 'slidingWindow' }); expect(calls[0]!.args.slice(1)).toEqual([3600, 10]);
  });
});
