// T0D-02 — JWT matrix. AC-0D-2.1, REQ-SEC-066 (02-TRD §6.5). Expected API (core/auth/jwt.ts):
//   createJwtVerifier({ alg, issuer, audience, keyFile, now?: () => number /* ms */ }): { verify(token): Promise<VerifiedJwt> }
//   VerifiedJwt = { sub, sessionId, aal, exp, iat }   (C2 02-TRD §6.1)
//   Failures reject with { code: 'auth.token_invalid' | 'auth.token_expired', statusCode: 401 }.
import { describe, expect, it } from 'vitest';
import { createJwtVerifier } from '../jwt.js';
import { AUD, ISS, NOW_MS, NOW_S, SESSION_ID, SUB, TENANT_B, b64u, expectAuthError, goodPayload, makeKeys, makeToken, noneToken, tamper, tmpFile, wrongKeyFor, type Alg } from './helpers.js';

describe.each(['HS256', 'ES256', 'RS256'] as readonly Alg[])('JWT matrix, pinned alg %s', (alg) => {
  const ks = makeKeys(alg);
  const verifier = () => createJwtVerifier({ alg, issuer: ISS, audience: AUD, keyFile: ks.verifyKeyFile, now: () => NOW_MS });
  const tok = (over: Record<string, unknown> = {}, o = {}) => makeToken(ks, over, o);
  const invalid = (t: string) => expectAuthError(verifier().verify(t), 'auth.token_invalid');
  const others = (['HS256', 'ES256', 'RS256'] as const).filter((a) => a !== alg);

  it('accepts a valid token and returns exactly sub, sessionId, aal, exp, iat', async () => {
    const r = await verifier().verify(tok());
    expect(r).toEqual({ sub: SUB, sessionId: SESSION_ID, aal: 'aal1', exp: NOW_S + 600, iat: NOW_S - 10 });
  });

  it('drops every other claim (tenant_id, membership_id, actor_type, role ...) — REQ-SEC-067', async () => {
    const r: any = await verifier().verify(tok({ tenant_id: TENANT_B, membership_id: 'm', actor_type: 'system', role: 'service_role', app_metadata: { a: 1 } }));
    expect(Object.keys(r).sort()).toEqual(['aal', 'exp', 'iat', 'sessionId', 'sub']);
  });

  it('accepts aal2', async () => {
    expect((await verifier().verify(tok({ aal: 'aal2' }))).aal).toBe('aal2');
  });

  describe('algorithm pinning (AC-0D-2.1)', () => {
    it.each(['none', 'None', 'NONE', 'nOnE'])('alg %s with empty signature -> auth.token_invalid', (a) => invalid(noneToken(a)));
    it('alg none with a stolen-looking signature -> auth.token_invalid', () => invalid(noneToken('none', goodPayload(), b64u('x'.repeat(32)))));
    it('alg none with no third segment at all -> auth.token_invalid', () => invalid(noneToken('none').slice(0, -1)));
    it.each(others)(`token signed with %s while ${alg} is pinned -> auth.token_invalid`, (other) => {
      const o = makeKeys(other);
      return invalid(makeToken(o));
    });
    it.each(others)(`header says %s but signature is ${alg} -> auth.token_invalid`, (other) => invalid(tok({}, { header: { alg: other } })));
    it('header alg lower-case variant -> auth.token_invalid', () => invalid(tok({}, { header: { alg: alg.toLowerCase() } })));
    it('header without alg -> auth.token_invalid', () => invalid(tok({}, { header: { alg: undefined } })));
    it('header alg of the wrong type (array / number) -> auth.token_invalid', async () => {
      await invalid(tok({}, { header: { alg: [alg] } }));
      await invalid(tok({}, { header: { alg: 256 } }));
    });
    it('unsupported alg values (HS512, PS256, EdDSA, ES384) -> auth.token_invalid', async () => {
      for (const a of ['HS512', 'PS256', 'EdDSA', 'ES384', 'RS512']) await invalid(tok({}, { header: { alg: a } }));
    });
    it('header "jku" / "jwk" / "x5u" / "kid" pointing elsewhere never changes the key (local key only) -> signature check still decides', async () => {
      const t = makeToken(ks, {}, { header: { jku: 'http://evil.example/jwks.json', jwk: { kty: 'oct', k: 'AAAA' }, x5u: 'http://evil.example/c', kid: 'attacker' }, key: wrongKeyFor(alg) });
      await invalid(t);
    });
  });

  if (alg === 'HS256') {
    it('key confusion: HS256 token MAC-ed with a public-key PEM as secret is not accepted -> auth.token_invalid', async () => {
      const pem = makeKeys('RS256').verifyKeyFile;
      const { readFileSync } = await import('node:fs');
      await invalid(makeToken(ks, {}, { key: Buffer.from(readFileSync(pem, 'utf8')) }));
    });
  } else {
    it(`key confusion: HS256 token MAC-ed with the pinned ${alg} public key as secret -> auth.token_invalid`, async () => {
      const { readFileSync } = await import('node:fs');
      const pem = Buffer.from(readFileSync(ks.verifyKeyFile, 'utf8'));
      await invalid(makeToken(ks, {}, { header: { alg: 'HS256' }, signAlg: 'HS256', key: pem }));
    });
  }

  describe('signature', () => {
    it('re-signed with a wrong key of the right alg -> auth.token_invalid (tampered-claim test, REQ-SEC-067)', () => invalid(tok({}, { key: wrongKeyFor(alg) })));
    it('payload edited after signing (tenant_id added) -> auth.token_invalid', () => invalid(tamper(tok(), { tenant_id: TENANT_B })));
    it('payload edited after signing (exp extended) -> auth.token_invalid', () => invalid(tamper(tok({ exp: NOW_S + 5 }), { exp: NOW_S + 99999 })));
    it('signature truncated by one char -> auth.token_invalid', () => invalid(tok().slice(0, -1)));
    it('signature with the last char flipped -> auth.token_invalid', () => {
      const t = tok();
      return invalid(t.slice(0, -2) + (t.endsWith('A') ? 'B' : 'A') + t.slice(-1));
    });
    it('empty signature segment -> auth.token_invalid', () => invalid(tok().split('.').slice(0, 2).join('.') + '.'));
    it('an expired token with a BAD signature reports auth.token_invalid, not expired (signature is checked first)', () =>
      invalid(tok({ exp: NOW_S - 5 }, { key: wrongKeyFor(alg) })));
  });

  describe('exp: strictly in the future, 0 s leeway (04 A7)', () => {
    it('exp = now + 1 s is accepted', async () => {
      expect((await verifier().verify(tok({ exp: NOW_S + 1 }))).exp).toBe(NOW_S + 1);
    });
    it('exp = now (not strictly in the future) -> auth.token_expired', () => expectAuthError(verifier().verify(tok({ exp: NOW_S })), 'auth.token_expired'));
    it('exp = now - 1 s -> auth.token_expired', () => expectAuthError(verifier().verify(tok({ exp: NOW_S - 1 })), 'auth.token_expired'));
    it('exp long ago -> auth.token_expired', () => expectAuthError(verifier().verify(tok({ exp: 1 })), 'auth.token_expired'));
    it('expiry is judged against the injected clock (a 10-minute-old clock makes a fresh token expired)', async () => {
      const late = createJwtVerifier({ alg, issuer: ISS, audience: AUD, keyFile: ks.verifyKeyFile, now: () => NOW_MS + 601_000 });
      await expectAuthError(late.verify(tok()), 'auth.token_expired');
    });
    it('missing exp -> auth.token_invalid', () => invalid(tok({}, { omit: ['exp'] })));
    it.each([['string', '9999999999'], ['null', null], ['object', {}], ['float NaN-ish string', 'NaN']])('exp of wrong type (%s) -> auth.token_invalid', (_n, v) => invalid(tok({ exp: v })));
  });

  describe('nbf / iat (60 s clock skew allowed [CONV])', () => {
    it('nbf 30 s in the future is accepted', async () => {
      await expect(verifier().verify(tok({ nbf: NOW_S + 30 }))).resolves.toBeTruthy();
    });
    it('nbf 61+ s in the future -> auth.token_invalid', () => invalid(tok({ nbf: NOW_S + 120 })));
    it('iat 30 s in the future is accepted', async () => {
      await expect(verifier().verify(tok({ iat: NOW_S + 30 }))).resolves.toBeTruthy();
    });
    it('iat 61+ s in the future -> auth.token_invalid', () => invalid(tok({ iat: NOW_S + 120 })));
    it('missing iat -> auth.token_invalid', () => invalid(tok({}, { omit: ['iat'] })));
  });

  describe('iss / aud', () => {
    it('wrong iss -> auth.token_invalid', () => invalid(tok({ iss: 'https://evil.example/auth/v1' })));
    it('iss with a trailing slash difference -> auth.token_invalid', () => invalid(tok({ iss: ISS + '/' })));
    it('missing iss -> auth.token_invalid', () => invalid(tok({}, { omit: ['iss'] })));
    it('wrong aud -> auth.token_invalid', () => invalid(tok({ aud: 'service_role' })));
    it('aud as array that does not contain the expected audience -> auth.token_invalid', () => invalid(tok({ aud: ['a', 'b'] })));
    it('aud with different case -> auth.token_invalid', () => invalid(tok({ aud: AUD.toUpperCase() })));
    it('missing aud -> auth.token_invalid', () => invalid(tok({}, { omit: ['aud'] })));
    it('wrong iss/aud on an otherwise valid-and-expired token -> still a 401 with an auth.* code', async () => {
      const e: any = await verifier().verify(tok({ iss: 'x', exp: NOW_S - 100 })).catch((x) => x);
      expect(['auth.token_invalid', 'auth.token_expired']).toContain(e.code);
      expect(e.statusCode).toBe(401);
    });
  });

  describe('required claims (REQ-SEC-067; AC-0D-2.2a)', () => {
    it('missing session_id -> auth.token_invalid', () => invalid(tok({}, { omit: ['session_id'] })));
    it.each([['empty', ''], ['number', 5], ['null', null], ['object', {}]])('session_id %s -> auth.token_invalid', (_n, v) => invalid(tok({ session_id: v })));
    it('missing sub -> auth.token_invalid', () => invalid(tok({}, { omit: ['sub'] })));
    it('empty sub -> auth.token_invalid', () => invalid(tok({ sub: '' })));
    it('missing aal -> auth.token_invalid', () => invalid(tok({}, { omit: ['aal'] })));
    it('aal outside {aal1, aal2} -> auth.token_invalid', () => invalid(tok({ aal: 'aal3' })));
  });

  describe('malformed input never throws anything but a 401 auth error', () => {
    const bad: ReadonlyArray<[string, string]> = [
      ['empty string', ''], ['one segment', 'abc'], ['two segments', 'a.b'], ['four segments', 'a.b.c.d'],
      ['dots only', '..'], ['non-base64 junk', '!!!.@@@.###'], ['header not JSON', `${b64u('nope')}.${b64u('{}')}.sig`],
      ['payload not JSON', `${b64u('{"alg":"HS256"}')}.${b64u('nope')}.sig`],
      ['payload is a JSON array', `${b64u('{"alg":"HS256"}')}.${b64u('[]')}.sig`],
      ['header is a JSON array', `${b64u('[]')}.${b64u('{}')}.sig`],
      ['whitespace', '   '], ['huge token (200 kB)', 'a'.repeat(200_000) + '.b.c'],
      ['bearer prefix left in', 'Bearer ' + 'a.b.c'], ['NUL byte', 'a\u0000.b.c'],
    ];
    it.each(bad)('%s -> auth.token_invalid', (_n, t) => invalid(t));
    it('non-string input (undefined / null / number) -> auth.token_invalid', async () => {
      for (const v of [undefined, null, 5, {}]) await expectAuthError(verifier().verify(v as any), 'auth.token_invalid');
    });
  });

  it('is stateless: a failure does not poison the next valid verification', async () => {
    const v = verifier();
    await expectAuthError(v.verify('garbage'), 'auth.token_invalid');
    await expect(v.verify(tok())).resolves.toMatchObject({ sub: SUB });
  });
});

describe('createJwtVerifier configuration fails fast', () => {
  const ks = makeKeys('HS256');
  const base = { alg: 'HS256', issuer: ISS, audience: AUD, keyFile: ks.verifyKeyFile } as const;
  it('alg outside {HS256, ES256, RS256} throws at construction', () => {
    for (const a of ['none', 'HS512', 'PS256', '', 'hs256']) expect(() => createJwtVerifier({ ...base, alg: a as any })).toThrow();
  });
  it('missing key file throws at construction (no lazy / network fallback)', () => {
    expect(() => createJwtVerifier({ ...base, keyFile: '/nonexistent/lims/jwt.key' })).toThrow();
  });
  it('empty key file throws at construction', () => {
    expect(() => createJwtVerifier({ ...base, keyFile: tmpFile('') })).toThrow();
  });
  it('empty issuer or audience throws at construction (would otherwise match nothing / anything)', () => {
    expect(() => createJwtVerifier({ ...base, issuer: '' })).toThrow();
    expect(() => createJwtVerifier({ ...base, audience: '' })).toThrow();
  });
  it('ES256 pinned with a garbage PEM throws at construction', () => {
    expect(() => createJwtVerifier({ ...base, alg: 'ES256', keyFile: tmpFile('not a pem') })).toThrow();
  });
  it('REQ-SEC-128: the verifier performs no network access (global fetch is never called)', async () => {
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => { called++; throw new Error('network'); }) as any;
    try {
      const v = createJwtVerifier({ ...base, now: () => NOW_MS });
      await v.verify(makeToken(ks, { iss: 'x' })).catch(() => undefined);
      await v.verify(makeToken(ks, {}, { header: { jku: 'http://evil.example/jwks.json' } })).catch(() => undefined);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
