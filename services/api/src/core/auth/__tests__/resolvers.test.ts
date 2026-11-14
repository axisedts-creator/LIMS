// T0D-02 — AuthResolver registry (02-TRD §6.3 "authResolvers", 08 §4.11 / R10 table). Expected API (core/auth/resolvers.ts):
//   createAuthResolverRegistry(modules: ReadonlyArray<{ name: string; authResolvers?: Record<string, AuthResolver> }>)
//     -> { has(key): boolean; authenticate(key, credential, tx): Promise<DbClaims> }
//   keys = manifest keys: deviceToken (instruments), portalSession (reporting), paymentCallback (payments),
//          patientPreAuth + queueDisplayToken (engagement). Construction throws when a module supplies a key it does not own.
//   authenticate(): resolver returns undefined -> rejects { code: 'auth.unauthenticated', statusCode: 401 };
//          { error } -> rejects with that code; ok -> DbClaims { sub: actor.id, tenant_id, actor_type: actor.type, centre_id?, ...extraClaims }.
//   core/auth/claims.ts: buildAuthResolverClaims(moduleName, ok) -> DbClaims (same shape, used by authenticate).
import { describe, expect, it } from 'vitest';
import { buildAuthResolverClaims } from '../claims.js';
import { createAuthResolverRegistry } from '../resolvers.js';
import { TENANT_A, TENANT_B, expectAuthError } from './helpers.js';

const TX = {} as any;
const ID = '0190a000-0000-7000-8000-00000000d001';
const CENTRE = '0190a000-0000-7000-8000-00000000ce01';
const ok = (over: Record<string, unknown> = {}) => ({ tenantId: TENANT_A, actor: { type: 'device', id: ID }, centreId: CENTRE, ...over });
const res = (result: unknown | (() => unknown)) => {
  const calls: Array<{ credential: string; tx: unknown }> = [];
  return { calls, resolve: async (credential: string, tx: unknown) => { calls.push({ credential, tx }); return typeof result === 'function' ? (result as () => unknown)() : result; } };
};

describe('registry ownership: one module per scheme (CI-checked)', () => {
  const allowed: ReadonlyArray<[string, string]> = [
    ['instruments', 'deviceToken'], ['reporting', 'portalSession'], ['payments', 'paymentCallback'],
    ['engagement', 'patientPreAuth'], ['engagement', 'queueDisplayToken'],
  ];
  it.each(allowed)('module %s may supply %s', (name, key) => {
    const reg = createAuthResolverRegistry([{ name, authResolvers: { [key]: res(ok()) } }]);
    expect(reg.has(key)).toBe(true);
  });
  it('has() is false for schemes nobody supplies (and for inherited property names)', () => {
    const reg = createAuthResolverRegistry([]);
    for (const k of ['deviceToken', 'portalSession', 'constructor', '__proto__', 'toString']) expect(reg.has(k)).toBe(false);
  });
  it.each([
    ['frontdesk', 'deviceToken'], ['billing', 'portalSession'], ['identity', 'paymentCallback'],
    ['reporting', 'deviceToken'], ['instruments', 'queueDisplayToken'], ['engagement', 'portalSession'], ['payments', 'patientPreAuth'],
  ])('module %s supplying %s throws at construction', (name, key) => {
    expect(() => createAuthResolverRegistry([{ name, authResolvers: { [key]: res(ok()) } }])).toThrow();
  });
  it('an unknown scheme key throws at construction', () => {
    expect(() => createAuthResolverRegistry([{ name: 'reporting', authResolvers: { godMode: res(ok()) } }])).toThrow();
  });
  it('the same scheme supplied by two registrations throws (single owner)', () => {
    expect(() => createAuthResolverRegistry([
      { name: 'instruments', authResolvers: { deviceToken: res(ok()) } },
      { name: 'instruments', authResolvers: { deviceToken: res(ok()) } },
    ])).toThrow();
  });
  it('authenticate() for a scheme with no resolver rejects (fail closed, never anonymous success)', async () => {
    const reg = createAuthResolverRegistry([]);
    await expect(reg.authenticate('deviceToken', 'cred', TX)).rejects.toBeTruthy();
  });
});

describe('authenticate()', () => {
  const mk = (name: string, key: string, r: unknown) => {
    const rr = res(r);
    return { rr, reg: createAuthResolverRegistry([{ name, authResolvers: { [key]: rr } }]) };
  };

  it('passes the credential and the anonymous tx to the resolver and builds claims from its result only', async () => {
    const { rr, reg } = mk('instruments', 'deviceToken', ok({ extraClaims: { credential_kind: 'bridge_agent', credential_id: ID } }));
    const claims = await reg.authenticate('deviceToken', 'lims-device-credential.abc', TX);
    expect(rr.calls).toEqual([{ credential: 'lims-device-credential.abc', tx: TX }]);
    expect(claims).toMatchObject({ sub: ID, tenant_id: TENANT_A, actor_type: 'device', centre_id: CENTRE, credential_kind: 'bridge_agent', credential_id: ID });
  });
  it('resolver returned undefined (invalid credential) -> 401 auth.unauthenticated', async () => {
    const { reg } = mk('instruments', 'deviceToken', undefined);
    await expectAuthError(reg.authenticate('deviceToken', 'bad', TX), 'auth.unauthenticated');
  });
  it('resolver returned {error} -> rejects with that code (reporting.link_invalid is mapped to 404 by errors.ts)', async () => {
    const { reg } = mk('reporting', 'portalSession', { error: 'reporting.link_invalid' });
    await expect(reg.authenticate('portalSession', 'link.x', TX)).rejects.toMatchObject({ code: 'reporting.link_invalid' });
  });
  it('resolver throwing is propagated, not turned into success', async () => {
    const boom = new Error('lookup failed');
    const { reg } = mk('payments', 'paymentCallback', () => { throw boom; });
    await expect(reg.authenticate('paymentCallback', 'tok', TX)).rejects.toBe(boom);
  });
  it.each([['empty string', ''], ['too long (100 kB)', 'a'.repeat(100_000)]])('credential %s is rejected 401 without crashing', async (_n, cred) => {
    const { reg } = mk('instruments', 'deviceToken', undefined);
    await expectAuthError(reg.authenticate('deviceToken', cred, TX), 'auth.unauthenticated');
  });
  it('resolver result with a malformed shape (no tenantId / no actor) -> rejects', async () => {
    for (const bad of [{}, { tenantId: TENANT_A }, { actor: { type: 'device', id: ID } }, 'ok', 5]) {
      const { reg } = mk('instruments', 'deviceToken', bad);
      await expect(reg.authenticate('deviceToken', 'c', TX)).rejects.toBeTruthy();
    }
  });
});

// LD-66 / CR-C6-021: a registration may declare invalidError; core pre-resolver rejections for THAT key throw it; every other key keeps auth.unauthenticated; 4096 cap stays.
describe('invalidError: per-registration error for pre-resolver credential rejections (LD-66, CR-C6-021)', () => {
  const portal = () => {
    const rr = { ...res(undefined), invalidError: 'reporting.link_invalid' };
    return { rr, reg: createAuthResolverRegistry([{ name: 'reporting', authResolvers: { portalSession: rr } }]) };
  };
  it.each([['empty', ''], ['5000 characters', 'a'.repeat(5000)], ['4097 characters', 'a'.repeat(4097)], ['non-string', 42 as unknown as string]])(
    'portalSession credential %s -> reporting.link_invalid, resolver not called', async (_n, cred) => {
      const { rr, reg } = portal();
      await expect(reg.authenticate('portalSession', cred, TX)).rejects.toMatchObject({ code: 'reporting.link_invalid' });
      expect(rr.calls).toEqual([]);
    });
  it('the 4096 cap is kept: exactly 4096 characters reaches the resolver', async () => {
    const { rr, reg } = portal();
    await expect(reg.authenticate('portalSession', 'a'.repeat(4096), TX)).rejects.toBeTruthy();
    expect(rr.calls).toHaveLength(1);
  });
  it.each([['instruments', 'deviceToken'], ['payments', 'paymentCallback'], ['engagement', 'patientPreAuth'], ['engagement', 'queueDisplayToken']])(
    '%s/%s without invalidError: empty or 5000-char credential -> 401 auth.unauthenticated', async (name, key) => {
      const reg = createAuthResolverRegistry([{ name, authResolvers: { [key]: res(undefined) } }]);
      for (const cred of ['', 'a'.repeat(5000), 7 as unknown as string]) await expectAuthError(reg.authenticate(key, cred, TX), 'auth.unauthenticated');
    });
  it('a reporting/portalSession registration WITHOUT invalidError still gives auth.unauthenticated (opt-in only)', async () => {
    const reg = createAuthResolverRegistry([{ name: 'reporting', authResolvers: { portalSession: res(undefined) } }]);
    await expectAuthError(reg.authenticate('portalSession', 'a'.repeat(5000), TX), 'auth.unauthenticated');
  });
  it('resolver returning undefined for a well-formed credential still gives auth.unauthenticated (only pre-resolver rejections change)', async () => {
    const { reg } = portal();
    await expectAuthError(reg.authenticate('portalSession', 'link.x', TX), 'auth.unauthenticated');
  });
});

describe('buildAuthResolverClaims: extraClaims allowlist per module (02-TRD §6.3)', () => {
  const claimsFor = (mod: string, extra: Record<string, string>, type = 'device') =>
    buildAuthResolverClaims(mod as any, ok({ actor: { type, id: ID }, extraClaims: extra }) as any);

  it.each([
    ['reporting', { portal_stage: 'session', portal_report_id: ID, portal_session_id: ID }, 'portal'],
    ['instruments', { credential_kind: 'bridge_agent', credential_id: ID }, 'device'],
    ['payments', { payment_intent_id: ID }, 'system'],
    ['engagement', { patient_stage: 'pre_auth', otp_token_sha256: 'a'.repeat(64) }, 'patient'],
    ['engagement', { device_kind: 'queue_display' }, 'device'],
  ])('%s: its documented keys are copied into the claims (actor %s)', (mod, extra, type) => {
    expect(claimsFor(mod, extra as any, type)).toMatchObject({ sub: ID, tenant_id: TENANT_A, actor_type: type, ...extra });
  });

  it.each([
    ['reporting', { payment_intent_id: ID }], ['instruments', { portal_stage: 'x' }], ['payments', { credential_kind: 'x' }],
    ['engagement', { portal_report_id: ID }], ['reporting', { extra_unknown: 'x' }],
  ])('%s with a key outside its allowlist (%j) throws', (mod, extra) => {
    expect(() => claimsFor(mod, extra as any)).toThrow();
  });

  it.each(['tenant_id', 'sub', 'actor_type', 'centre_id', 'membership_id', 'scope', 'platform_role', 'support_session_id', 'lims_session_id', '__proto__', 'constructor'])(
    'extraClaims cannot override or inject the reserved claim %s (REQ-SEC-013)', (key) => {
      for (const mod of ['reporting', 'instruments', 'payments', 'engagement']) {
        const extra = Object.fromEntries([[key, TENANT_B]]);
        expect(() => claimsFor(mod, extra)).toThrow();
      }
    });

  it('tenant_id in the claims is always the resolver tenantId, and sub is the actor id', () => {
    const c = buildAuthResolverClaims('reporting' as any, ok({ actor: { type: 'portal', id: ID } }) as any);
    expect(c.tenant_id).toBe(TENANT_A);
    expect(c.sub).toBe(ID);
  });
  it('centre_id is omitted when the resolver gave none', () => {
    const c = buildAuthResolverClaims('instruments' as any, { tenantId: TENANT_A, actor: { type: 'device', id: ID } } as any);
    expect(c).not.toHaveProperty('centre_id');
  });
  it('non-string extraClaims values are rejected (claims are text, 08 §4.11)', () => {
    expect(() => claimsFor('payments', { payment_intent_id: 5 as any })).toThrow();
  });
});
