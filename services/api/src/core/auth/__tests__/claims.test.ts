// T0D-02 — identity claimsResolver call + claims builder. AC-0D-2.2, AC-0D-2.2a, REQ-SEC-013, REQ-SEC-067, 08 R10.
// Expected API:
//   core/auth/claims-resolver.ts: authenticateBearer({ verifier, claimsResolver? }, token, request)
//        -> Promise<{ claims: DbClaims; resolved: ResolvedClaims /* kind != 'rejected' */ }>
//        verifier = { verify(token): Promise<VerifiedJwt> } (jwt.ts); request = { clientIp, requestId, endpointFamily, bffKey? }
//        The resolver is called for EVERY accepted JWT with (VerifiedJwt, request). Fails closed (rejects) otherwise.
//   core/auth/claims.ts: buildDbClaims(resolved: ResolvedClaims): DbClaims  (JSON.parse of resolver claimsJson; 'rejected' throws its code)
//   ResolvedClaims / ClaimsResolver shapes: C2 02-TRD §6.1.
import { describe, expect, it } from 'vitest';
import { authenticateBearer } from '../claims-resolver.js';
import { buildDbClaims } from '../claims.js';
import { createJwtVerifier } from '../jwt.js';
import { AUD, ISS, NOW_MS, SESSION_ID, SUB, TENANT_A, TENANT_B, expectAuthError, makeKeys, makeToken } from './helpers.js';

const ks = makeKeys('ES256');
const verifier = createJwtVerifier({ alg: 'ES256', issuer: ISS, audience: AUD, keyFile: ks.verifyKeyFile, now: () => NOW_MS });
const REQ = { clientIp: '203.0.113.9', requestId: '0190a000-0000-7000-8000-0000000000f1', endpointFamily: 'staff', bffKey: 'staff_web' } as const;
const MEMBERSHIP = '0190a000-0000-7000-8000-00000000c001';

const tenantClaims = {
  sub: SUB, tenant_id: TENANT_A, membership_id: MEMBERSHIP, actor_type: 'user', aal: 'aal1', lims_session_id: SESSION_ID, session_state: 'active',
};
const resolvedTenant = (over: Record<string, unknown> = {}) => ({
  kind: 'tenant' as const,
  claimsJson: JSON.stringify({ ...tenantClaims, ...over }),
  tenantId: TENANT_A,
  actor: { type: 'user', id: SUB, membershipId: MEMBERSHIP },
  sessionState: 'active',
});

function fakeResolver(result: unknown | (() => unknown)) {
  const calls: Array<{ jwt: any; request: any }> = [];
  return {
    calls,
    resolve: async (jwt: any, request: any) => {
      calls.push({ jwt, request });
      if (typeof result === 'function') return (result as () => unknown)();
      return result;
    },
  };
}
const run = (r: { resolve: any } | undefined, token: string) =>
  authenticateBearer({ verifier, claimsResolver: r as any }, token, REQ);
const goodToken = (over: Record<string, unknown> = {}, o = {}) => makeToken(ks, over, o);

describe('identity claimsResolver is mandatory and the only claims source (08 R10)', () => {
  it('calls the resolver exactly once with the VerifiedJwt and the request context', async () => {
    const r = fakeResolver(resolvedTenant());
    await run(r, goodToken());
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.jwt).toMatchObject({ sub: SUB, sessionId: SESSION_ID, aal: 'aal1' });
    expect(Object.keys(r.calls[0]!.jwt).sort()).toEqual(['aal', 'exp', 'iat', 'sessionId', 'sub']);
    expect(r.calls[0]!.request).toMatchObject({ clientIp: REQ.clientIp, requestId: REQ.requestId, endpointFamily: 'staff', bffKey: 'staff_web' });
  });

  it('returns the resolver claims verbatim as DbClaims', async () => {
    const out = await run(fakeResolver(resolvedTenant()), goodToken());
    expect(out.claims).toEqual(tenantClaims);
    expect(out.resolved.kind).toBe('tenant');
  });

  it('AC-0D-2.2a: tenant_id / membership_id / actor_type inside the JWT are ignored; only the resolver result is used', async () => {
    const r = fakeResolver(resolvedTenant()); // tenant A
    const out = await run(r, goodToken({ tenant_id: TENANT_B, membership_id: 'evil', actor_type: 'system', role: 'service_role', scope: 'platform' }));
    expect(out.claims.tenant_id).toBe(TENANT_A);
    expect(out.claims.actor_type).toBe('user');
    expect(out.claims.membership_id).toBe(MEMBERSHIP);
    expect(out.claims).not.toHaveProperty('role');
    expect(JSON.stringify(r.calls[0]!.jwt)).not.toContain(TENANT_B);
    expect(JSON.stringify(r.calls[0]!.jwt)).not.toContain('evil');
  });

  it('AC-0D-2.2: request-supplied tenant_id never reaches the resolver call or the claims (no request fields are read except the typed context)', async () => {
    const r = fakeResolver(resolvedTenant());
    const out = await authenticateBearer({ verifier, claimsResolver: r as any }, goodToken(), { ...REQ, tenant_id: TENANT_B, headers: { 'x-tenant-id': TENANT_B } } as any);
    expect(out.claims.tenant_id).toBe(TENANT_A);
    expect(JSON.stringify(r.calls[0]!.request)).not.toContain(TENANT_B);
  });

  it('without session_id the token is 401 auth.token_invalid and the resolver is never called', async () => {
    const r = fakeResolver(resolvedTenant());
    await expectAuthError(run(r, goodToken({}, { omit: ['session_id'] })), 'auth.token_invalid');
    expect(r.calls).toHaveLength(0);
  });

  it('an invalid / expired / forged token never reaches the resolver', async () => {
    const r = fakeResolver(resolvedTenant());
    await expectAuthError(run(r, 'garbage'), 'auth.token_invalid');
    await expectAuthError(run(r, goodToken({ exp: 1 })), 'auth.token_expired');
    await expectAuthError(run(r, goodToken({}, { key: makeKeys('ES256').signKey })), 'auth.token_invalid');
    expect(r.calls).toHaveLength(0);
  });

  it('no claimsResolver registered (identity module missing) -> fails closed: rejects, never resolves with JWT claims', async () => {
    await expect(run(undefined, goodToken({ tenant_id: TENANT_B }))).rejects.toBeTruthy();
  });

  it.each([
    'auth.unauthenticated', 'auth.session_expired', 'auth.account_locked',
    'identity.tenant_suspended', 'identity.membership_inactive', 'identity.platform_ip_denied',
  ])('resolver result {kind: rejected, code: %s} -> 401/4xx error carrying exactly that code', async (code) => {
    const r = fakeResolver({ kind: 'rejected', code });
    let err: any;
    try {
      await run(r, goodToken());
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe(code); // HTTP status mapping of identity.* codes is errors.ts (T0D-04); auth.* are checked below
  });

  it('auth.* rejected codes surface as 401', async () => {
    for (const code of ['auth.unauthenticated', 'auth.session_expired']) {
      await expectAuthError(run(fakeResolver({ kind: 'rejected', code }), goodToken()), code);
    }
  });

  it('resolver throwing is propagated (no silent fallback to the JWT)', async () => {
    const boom = new Error('db down');
    await expect(run(fakeResolver(() => { throw boom; }), goodToken())).rejects.toBe(boom);
  });

  it.each([
    ['undefined', undefined], ['null', null], ['unknown kind', { kind: 'god_mode', claimsJson: '{}' }],
  ])('resolver result %s -> rejects', async (_n, v) => {
    await expect(run(fakeResolver(v), goodToken())).rejects.toBeTruthy();
  });

  it.each([['not json', 'nope'], ['array', '[]'], ['null', 'null'], ['string', '"x"'], ['number', '5'], ['empty', '']])(
    'resolver claimsJson that is %s -> rejects (never a non-object into request.jwt.claims)', async (_n, claimsJson) => {
      await expect(run(fakeResolver({ ...resolvedTenant(), claimsJson }), goodToken())).rejects.toBeTruthy();
    });

  it('AC-0D-2.6 wiring guard: platform / partner / patient / staff_mobile kinds are passed through as the resolver built them', async () => {
    for (const kind of ['platform', 'partner', 'patient', 'staff_mobile'] as const) {
      const cj = { sub: SUB, actor_type: kind === 'platform' ? 'user' : kind === 'partner' ? 'partner' : kind === 'patient' ? 'patient' : 'user', lims_session_id: SESSION_ID };
      const out = await run(fakeResolver({ kind, claimsJson: JSON.stringify(cj), tenantId: TENANT_A, actor: { type: cj.actor_type, id: SUB }, platformRole: 'platform_support', sessionState: 'active' }), goodToken());
      expect(out.claims).toEqual(cj);
    }
  });
});

describe('buildDbClaims (core/auth/claims.ts)', () => {
  it('parses claimsJson of a tenant result', () => {
    expect(buildDbClaims(resolvedTenant() as any)).toEqual(tenantClaims);
  });
  it('platform result with support session keeps scope/support_session_id from the resolver only', () => {
    const cj = { sub: SUB, actor_type: 'user', scope: 'support', support_session_id: SESSION_ID, tenant_id: TENANT_A, platform_staff_id: SUB, platform_role: 'platform_support', lims_session_id: SESSION_ID };
    expect(buildDbClaims({ kind: 'platform', claimsJson: JSON.stringify(cj), actor: { type: 'user', id: SUB }, platformRole: 'platform_support' } as any)).toEqual(cj);
  });
  it('kind rejected -> throws with the rejected code', () => {
    let err: any;
    try {
      buildDbClaims({ kind: 'rejected', code: 'auth.account_locked' } as any);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('auth.account_locked');
  });
  it('returns a fresh object each time (callers cannot mutate a shared claims object)', () => {
    const r = resolvedTenant() as any;
    const a = buildDbClaims(r);
    (a as any).tenant_id = TENANT_B;
    expect(buildDbClaims(r).tenant_id).toBe(TENANT_A);
  });
  it('prototype pollution in claimsJson does not alter Object.prototype', () => {
    try {
      buildDbClaims({ ...resolvedTenant(), claimsJson: '{"sub":"x","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}' } as any);
    } catch {
      /* rejecting is fine */
    }
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).polluted2).toBeUndefined();
  });
});
