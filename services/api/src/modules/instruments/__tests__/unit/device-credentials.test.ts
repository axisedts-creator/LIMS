// C7 API-T03 — device auth resolver + credential service (06-IMPLEMENTATION-PLAN row API-T03; 02-TRD §7.1; 07-SECURITY AB3/AB4/AB12, S-05, S-07).
// done_when: "formats, kinds, touch throttle, failures metric". ACs: AC-01.5 (identical 401 for used/expired/unknown code),
// AC-01.6 (enrolment code on any op but enrolAgent -> 401), AC-01.7 (two agents, two tokens, revoking one leaves the other). Synthetic data only.
// Interface expected from the writer (seams the spec does not fix are marked SEAM):
//   ../../auth/deviceTokenResolver.ts
//     classifyCredential(s: unknown): 'device_token' | 'enrolment_code' | undefined          (SEAM name) pure format check, TRD §7.1:
//         device token `lmsd_` + 43 base64url chars; enrolment code `lmse_` + 22 base64url chars; anything else -> undefined (whole string, no trailing \n)
//     createDeviceTokenResolver({ metrics: { inc(name: string, labels?: Record<string, string | number>): void } }): { resolve(credential, tx) }   (SEAM name/deps)
//         The module metric `lims_instruments_device_auth_failures_total` is NOT in core metrics.ts DEFS (core would throw on it): the writer must give the
//         resolver an injected sink (as here) and, for the real wiring, raise a CR for the core metric table. Do not edit core.
//         resolve(): format ok -> ONE query `SELECT * FROM app.instruments_resolve_device_credential($1)` with $1 = sha256(credential utf-8) (32 bytes), no write.
//         ok row {tenant_id, agent_id, centre_id, credential_id, credential_kind} -> { tenantId, actor: {type:'device', id: agent_id}, centreId,
//         extraClaims: { credential_kind, credential_id } } (exactly these keys; accepted by core buildAuthResolverClaims('instruments', ..)).
//         failure (bad format -> metric reason 'format', no query; no row -> reason 'unknown') must surface through the core registry as
//         AuthError 'auth.device_token_invalid' (401), identical for every failure (so the resolver returns { error: 'auth.device_token_invalid' };
//         bare `undefined` would surface as auth.unauthenticated). DB errors propagate (not counted, not turned into 401).
//   ../../service/credentials.service.ts
//     generateDeviceToken() / generateEnrolmentCode(): { token, secretSha256: Uint8Array(32) } (SEAM shape, like reporting issueToken)
//     hashCredential(s: string): Uint8Array   sha256 of utf-8 bytes
//     requireCredentialKind(claims: { credential_kind?: unknown }, expected: 'device_token' | 'enrolment_code'): void   (SEAM name) throws AuthError auth.device_token_invalid
//     touchCredential(tx, credentialId: string, touchSeconds: number): Promise<void>   (SEAM) ONE parameterised UPDATE instruments.agent_credentials
//         SET last_used_at, throttled IN SQL (`last_used_at IS NULL OR last_used_at < ...`, touchSeconds is $2), run on the REQUEST tx (not the resolver's).
import { describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createAuthResolverRegistry } from '../../../../core/auth/resolvers.js';
import { buildAuthResolverClaims } from '../../../../core/auth/claims.js';
import { createDeviceTokenResolver, classifyCredential } from '../../auth/deviceTokenResolver.js';
import {
  generateDeviceToken, generateEnrolmentCode, hashCredential, requireCredentialKind, touchCredential,
} from '../../service/credentials.service.js';
import { manifest } from '../../index.js';

const FAIL_METRIC = 'lims_instruments_device_auth_failures_total';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(0xa1), CENTRE = id(0xc1);
const AGENT_X = id(0x11), AGENT_Y = id(0x12), CRED_X = id(0x21), CRED_Y = id(0x22);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

type Row = { tenant_id: string; agent_id: string; centre_id: string; credential_id: string; credential_kind: string };
const row = (agent: string, cred: string, kind: string): Row => ({ tenant_id: TENANT, agent_id: agent, centre_id: CENTRE, credential_id: cred, credential_kind: kind });

/** Fake of the DEFINER function: answers by sha256(hex) of the presented credential, like `WHERE secret_sha256 = $1`. */
function fakeTx(byHash: Map<string, Row> = new Map()) {
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const r = byHash.get(hex(values[0] as Uint8Array));
      return { rows: r ? [r] : [] };
    }),
  };
  return tx;
}
function sink() {
  const incs: { name: string; labels?: Record<string, string | number> }[] = [];
  return { incs, inc: (name: string, labels?: Record<string, string | number>) => { incs.push({ name, labels }); } };
}
const reasons = (m: ReturnType<typeof sink>) => m.incs.filter((i) => i.name === FAIL_METRIC).map((i) => i.labels?.reason);
function setup(rows: Map<string, Row> = new Map()) {
  const metrics = sink();
  const tx = fakeTx(rows);
  const resolver = createDeviceTokenResolver({ metrics });
  const registry = createAuthResolverRegistry([{ name: 'instruments', authResolvers: { deviceToken: resolver } }]);
  return { metrics, tx, resolver, registry };
}
async function fail(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as Error & { code?: string; statusCode?: number }; }
  throw new Error('expected rejection');
}

describe('credential formats (TRD §7.1)', () => {
  it('generated tokens/codes have the fixed shape, are unique, and hash to sha256 bytes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateDeviceToken(), c = generateEnrolmentCode();
      expect(t.token).toMatch(/^lmsd_[A-Za-z0-9_-]{43}$/);
      expect(c.token).toMatch(/^lmse_[A-Za-z0-9_-]{22}$/);
      expect(t.secretSha256).toHaveLength(32);
      expect(hex(t.secretSha256)).toBe(sha(t.token));
      expect(hex(c.secretSha256)).toBe(sha(c.token));
      seen.add(t.token); seen.add(c.token);
    }
    expect(seen.size).toBe(400);
  });

  it('hashCredential = sha256 of the full string incl. prefix, utf-8', () => {
    const t = generateDeviceToken().token;
    expect(hex(hashCredential(t))).toBe(sha(t));
    expect(hex(hashCredential(t.slice(5)))).not.toBe(sha(t));
  });

  it('classifyCredential accepts exactly the two shapes', () => {
    expect(classifyCredential(generateDeviceToken().token)).toBe('device_token');
    expect(classifyCredential(generateEnrolmentCode().token)).toBe('enrolment_code');
  });

  const b43 = 'A'.repeat(43), b22 = 'B'.repeat(22);
  it.each([
    ['empty', ''], ['prefix only', 'lmsd_'], ['token short by 1', `lmsd_${b43.slice(1)}`], ['token long by 1', `lmsd_${b43}A`],
    ['code short by 1', `lmse_${b22.slice(1)}`], ['code long by 1', `lmse_${b22}B`], ['code body on token prefix', `lmsd_${b22}`],
    ['token body on code prefix', `lmse_${b43}`], ['upper-case prefix', `LMSD_${b43}`], ['unknown prefix', `lmsx_${b43}`],
    ['Bearer scheme left in', `Bearer lmsd_${b43}`], ['base64 plus', `lmsd_${'+'.repeat(43)}`], ['base64 slash', `lmsd_${'/'.repeat(43)}`],
    ['padding', `lmse_${'='.repeat(22)}`], ['space inside', `lmsd_${b43.slice(1)} `], ['trailing newline (regex $ pitfall)', `lmsd_${b43}\n`],
    ['leading space', ` lmsd_${b43}`], ['NUL inside', `lmse_${b22.slice(1)}\0`], ['non-ASCII letter', `lmse_${'é'.repeat(22)}`],
    ['4 KiB junk', 'lmsd_' + 'A'.repeat(4096)], ['raw base64url without prefix', b43],
  ])('rejects %s', (_n, s) => { expect(classifyCredential(s)).toBeUndefined(); });
  it.each([[undefined], [null], [42], [{}], [['lmsd_' + 'A'.repeat(43)]], [Buffer.from('lmsd_' + 'A'.repeat(43))]])('rejects non-string %#', (v) => {
    expect(classifyCredential(v)).toBeUndefined();
  });
});

describe('resolver (TRD §7.1)', () => {
  it('maps the DEFINER row to the core AuthResolver result; one SELECT with the 32-byte sha256, no write', async () => {
    const t = generateDeviceToken();
    const { resolver, tx } = setup(new Map([[hex(t.secretSha256), row(AGENT_X, CRED_X, 'device_token')]]));
    const r = await resolver.resolve(t.token, tx);
    expect(r).toEqual({
      tenantId: TENANT, actor: { type: 'device', id: AGENT_X }, centreId: CENTRE,
      extraClaims: { credential_kind: 'device_token', credential_id: CRED_X },
    });
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0]!.text).toMatch(/app\.instruments_resolve_device_credential\(\s*\$1\s*\)/);
    expect(tx.calls[0]!.text).toMatch(/^\s*SELECT/i);
    expect(tx.calls[0]!.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(tx.calls[0]!.values).toHaveLength(1);
    expect(tx.calls[0]!.values[0]).toBeInstanceOf(Uint8Array); // Buffer is a Uint8Array
    expect(hex(tx.calls[0]!.values[0] as Uint8Array)).toBe(sha(t.token));
  });

  it('result is accepted by core buildAuthResolverClaims and carries only allowlisted claims', async () => {
    const t = generateDeviceToken(), c = generateEnrolmentCode();
    const { resolver, tx } = setup(new Map([
      [hex(t.secretSha256), row(AGENT_X, CRED_X, 'device_token')], [hex(c.secretSha256), row(AGENT_Y, CRED_Y, 'enrolment_code')],
    ]));
    for (const [cred, agent, credId, kind] of [[t.token, AGENT_X, CRED_X, 'device_token'], [c.token, AGENT_Y, CRED_Y, 'enrolment_code']] as const) {
      const r = await resolver.resolve(cred, tx);
      expect(Object.keys((r as any).extraClaims).sort()).toEqual(['credential_id', 'credential_kind']);
      expect(buildAuthResolverClaims('instruments', r)).toEqual({
        sub: agent, tenant_id: TENANT, actor_type: 'device', centre_id: CENTRE, credential_kind: kind, credential_id: credId,
      });
    }
  });

  it('bad format: no DB call, metric reason=format', async () => {
    const { resolver, tx, metrics } = setup();
    for (const bad of ['', 'lmsd_short', `lmsd_${'A'.repeat(43)}\n`, 'Bearer x']) await resolver.resolve(bad, tx);
    expect(tx.query).not.toHaveBeenCalled();
    expect(reasons(metrics)).toEqual(['format', 'format', 'format', 'format']);
  });

  it('well-formed but unknown: one lookup, metric reason=unknown only', async () => {
    const { resolver, tx, metrics } = setup();
    await resolver.resolve(generateDeviceToken().token, tx);
    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(reasons(metrics)).toEqual(['unknown']);
  });

  it('success does not count a failure; metric labels carry no credential material', async () => {
    const t = generateDeviceToken();
    const { resolver, tx, metrics } = setup(new Map([[hex(t.secretSha256), row(AGENT_X, CRED_X, 'device_token')]]));
    await resolver.resolve(t.token, tx);
    await resolver.resolve(`lmsd_${'Z'.repeat(42)}`, tx);
    expect(reasons(metrics)).toEqual(['format']);
    expect(JSON.stringify(metrics.incs)).not.toContain(t.token);
    for (const i of metrics.incs) expect(Object.keys(i.labels ?? {})).toEqual(['reason']);
  });

  it('a DB failure propagates: not a 401, not counted as an auth failure', async () => {
    const { resolver, tx, metrics } = setup();
    tx.query.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
    await expect(resolver.resolve(generateDeviceToken().token, tx)).rejects.toThrow('connection lost');
    expect(reasons(metrics)).toEqual([]);
  });

  it('is exported as the deviceToken authResolver of the module manifest and registers in the core registry', () => {
    expect(typeof (manifest.authResolvers as any)?.deviceToken?.resolve).toBe('function');
    expect(createAuthResolverRegistry([manifest]).has('deviceToken')).toBe(true);
  });
});

describe('AC-01.5 — used, expired and unknown credentials give one identical 401 (through the core registry)', () => {
  it('used / expired / revoked / unknown / malformed: same code, status and message', async () => {
    const { registry, tx } = setup(); // the DEFINER returns no row for used, expired, revoked and unknown alike
    const errs = [];
    for (const cred of [generateEnrolmentCode().token /* used */, generateEnrolmentCode().token /* expired */, generateDeviceToken().token /* unknown */, 'junk', `lmse_${'A'.repeat(22)}\n`]) {
      errs.push(await fail(registry.authenticate('deviceToken', cred, tx)));
    }
    for (const e of errs) {
      expect(e.code).toBe('auth.device_token_invalid');
      expect(e.statusCode).toBe(401);
      expect(e.message).toBe(errs[0]!.message);
    }
    for (const e of errs) for (const cred of ['lmse_', 'lmsd_']) expect(e.message).not.toContain(cred);
  });
});

describe('AC-01.6 — credential kind gate', () => {
  it('enrolment code only on enrolAgent, device token everywhere else', () => {
    expect(() => requireCredentialKind({ credential_kind: 'enrolment_code' }, 'enrolment_code')).not.toThrow();
    expect(() => requireCredentialKind({ credential_kind: 'device_token' }, 'device_token')).not.toThrow();
    for (const [have, want] of [['enrolment_code', 'device_token'], ['device_token', 'enrolment_code']] as const) {
      let e: any;
      try { requireCredentialKind({ credential_kind: have }, want); } catch (x) { e = x; }
      expect(e?.code).toBe('auth.device_token_invalid');
      expect(e?.statusCode).toBe(401);
    }
  });

  it.each([[{}], [{ credential_kind: undefined }], [{ credential_kind: '' }], [{ credential_kind: 'Device_Token' }], [{ credential_kind: ['device_token'] }], [{ credential_kind: null }], [{ credential_kind: 1 }]])(
    'fails closed on missing/odd claim %j', (claims) => {
      for (const want of ['device_token', 'enrolment_code'] as const) {
        expect(() => requireCredentialKind(claims as any, want)).toThrow(expect.objectContaining({ code: 'auth.device_token_invalid' }));
      }
    });

  it('end to end: an enrolment code resolves (kind=enrolment_code) but is refused for a device operation (AB4)', async () => {
    const c = generateEnrolmentCode();
    const { registry, tx } = setup(new Map([[hex(c.secretSha256), row(AGENT_X, CRED_X, 'enrolment_code')]]));
    const claims = await registry.authenticate('deviceToken', c.token, tx);
    expect(claims.credential_kind).toBe('enrolment_code');
    expect(() => requireCredentialKind(claims, 'device_token')).toThrow(expect.objectContaining({ code: 'auth.device_token_invalid' }));
    expect(() => requireCredentialKind(claims, 'enrolment_code')).not.toThrow();
  });
});

describe('AC-01.7 — two agents, two tokens, independent revocation', () => {
  it('distinct tokens resolve to their own agent; revoking X (row disappears) leaves Y working', async () => {
    const x = generateDeviceToken(), y = generateDeviceToken();
    expect(x.token).not.toBe(y.token);
    expect(hex(x.secretSha256)).not.toBe(hex(y.secretSha256));
    const rows = new Map([[hex(x.secretSha256), row(AGENT_X, CRED_X, 'device_token')], [hex(y.secretSha256), row(AGENT_Y, CRED_Y, 'device_token')]]);
    const { registry, tx } = setup(rows);
    expect((await registry.authenticate('deviceToken', x.token, tx)).sub).toBe(AGENT_X);
    expect((await registry.authenticate('deviceToken', y.token, tx)).sub).toBe(AGENT_Y);
    rows.delete(hex(x.secretSha256)); // revoke X
    expect((await fail(registry.authenticate('deviceToken', x.token, tx))).code).toBe('auth.device_token_invalid'); // AB12
    expect((await registry.authenticate('deviceToken', y.token, tx)).sub).toBe(AGENT_Y);
  });

  it('touching one credential binds only that credential id', async () => {
    const tx = fakeTx();
    await touchCredential(tx as any, CRED_X, 300);
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0]!.values).toContain(CRED_X);
    expect(tx.calls[0]!.values).not.toContain(CRED_Y);
  });
});

describe('touch throttle (TRD §7.1: last_used_at at most once per LIMS_INSTRUMENTS_CREDENTIAL_TOUCH_SECONDS)', () => {
  it('is one parameterised, self-throttling UPDATE on the credential row', async () => {
    const tx = fakeTx();
    await touchCredential(tx as any, CRED_X, 300);
    expect(tx.calls).toHaveLength(1);
    const { text, values } = tx.calls[0]!;
    expect(text).toMatch(/UPDATE\s+instruments\.agent_credentials/i);
    expect(text).toMatch(/SET\s+last_used_at\s*=/i);
    expect(text).toMatch(/WHERE[\s\S]*\bid\s*=\s*\$1/i);
    expect(text).toMatch(/last_used_at\s+IS\s+NULL/i);       // first use always touches
    expect(text).toMatch(/last_used_at\s*<[\s\S]*\$2/i);     // otherwise only when older than the window
    expect(text).not.toMatch(/\b(status|secret_sha256|expires_at|kind)\s*=\s*[^=]/i); // touches nothing but last_used_at (mutable-column trigger)
    expect(values[0]).toBe(CRED_X);
    expect(Number(values[1])).toBe(300);
  });

  it('uses the given window', async () => {
    const tx = fakeTx();
    await touchCredential(tx as any, CRED_X, 60);
    expect(Number(tx.calls[0]!.values[1])).toBe(60);
  });

  it.each([[0], [-1], [Number.NaN], [Infinity], [1.5], ['300' as unknown as number]])('rejects window %s before any query', async (w) => {
    const tx = fakeTx();
    await expect(touchCredential(tx as any, CRED_X, w)).rejects.toThrow();
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('credential id is only ever a bound value (no SQL injection through the id)', async () => {
    const tx = fakeTx();
    const evil = `${CRED_X}'; DROP TABLE instruments.agent_credentials; --`;
    await touchCredential(tx as any, evil, 300).catch(() => undefined); // may also validate the uuid and throw — both are fine
    for (const c of tx.calls) expect(c.text).not.toContain('DROP');
  });

  it('a failing UPDATE propagates (the request tx rolls back instead of silently losing the touch)', async () => {
    const tx = fakeTx();
    tx.query.mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }));
    await expect(touchCredential(tx as any, CRED_X, 300)).rejects.toThrow('lock timeout');
  });
});

describe('probes', () => {
  it('prototype-ish and oversized credentials never reach the DB and never crash the resolver', async () => {
    const { resolver, tx } = setup();
    for (const s of ['__proto__', 'constructor', 'lmsd_' + '\u0000'.repeat(43), 'lmse_' + randomBytes(2000).toString('base64url')]) {
      await resolver.resolve(s, tx); // must not throw
    }
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('two failures with different reasons are indistinguishable to the caller', async () => {
    const { registry, tx } = setup();
    const a = await fail(registry.authenticate('deviceToken', 'lmsd_bad', tx));          // reason=format
    const b = await fail(registry.authenticate('deviceToken', generateDeviceToken().token, tx)); // reason=unknown
    expect({ code: a.code, status: a.statusCode, message: a.message }).toEqual({ code: b.code, status: b.statusCode, message: b.message });
  });
});
