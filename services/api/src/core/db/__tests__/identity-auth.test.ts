// T0D-03 — ctx.db.identityAuthTx + tx.bindTenant + LIMS_CORE_IDENTITY_AUTH_OPS + authz-guard exemption. AC-0D-2.6, 08 A25 D-212, C2 07-SECURITY A-20.
// Expected API:
//   core/db/allowlists.ts: IDENTITY_AUTH_OPS (the 15 default operationIds, readonly string[]), WITH_TENANT_SCOPE_OPS (D-214 list),
//                          authzGuardExempt(operation: { context?: string }) -> boolean  (stage 9 skips x-context: identity_auth)
//   createDb({ ..., identityAuthOps?: ReadonlySet<string> | readonly string[] (default IDENTITY_AUTH_OPS), identitySystemActorId: string })
//   db.identityAuthTx({ requestId, clientIp, userAgent, operation: { module, operationId, context } }, fn(tx, ctl))
//     tx.bindTenant(tenantId) — once per transaction attempt; the second call throws code 'common.internal'.
import { describe, expect, it } from 'vitest';
import { IDENTITY_AUTH_OPS, authzGuardExempt } from '../allowlists.js';
import { createDb } from '../tx.js';
import { IDENTITY_SYSTEM_ACTOR, REQ_ID, TENANT_A, TENANT_B, createFakePgBouncer, pgError, rejection } from './helpers.js';

const FIFTEEN = [
  'loginStaff', 'loginPartner', 'openMobileSession', 'refreshMobileSession', 'logoutMobileSession', 'confirmEmailToken',
  'requestPasswordRecovery', 'verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment', 'resolveSession', 'logoutSession',
  'setPasswordFromSetup', 'resolvePatientSession', 'logoutPatientSession',
];
const authOp = (over: Record<string, unknown> = {}) => ({ module: 'identity', operationId: 'loginStaff', context: 'identity_auth', ...over });
const input = (over: Record<string, unknown> = {}) => ({
  requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest', operation: authOp(), ...over,
});
const mk = (extra: Record<string, unknown> = {}) => {
  const fake = createFakePgBouncer(1);
  const db = createDb({ pool: fake.pool, sleep: async () => {}, random: () => 0, identitySystemActorId: IDENTITY_SYSTEM_ACTOR, ...extra } as any) as any;
  return { fake, db };
};
const tenantOf = async (tx: any) => (await tx.query('SELECT app.current_tenant_id() AS tenant_id')).rows[0].tenant_id;

describe('LIMS_CORE_IDENTITY_AUTH_OPS defaults (D-212)', () => {
  it('are exactly the 15 operationIds of 08 A25 D-212', () => {
    expect([...IDENTITY_AUTH_OPS].sort()).toEqual([...FIFTEEN].sort());
  });
});

describe('AC-0D-2.6 identityAuthTx opens with system-actor claims and no tenant', () => {
  it.each(FIFTEEN)('listed operation %s may open it', async (operationId) => {
    const { db } = mk();
    expect(await db.identityAuthTx(input({ operation: authOp({ operationId }) }), async () => 'ok')).toBe('ok');
  });

  it('claims are exactly { sub: <identity system actor>, actor_type: "system" } — no tenant_id, no other key', async () => {
    const { fake, db } = mk();
    await db.identityAuthTx(input(), async () => 1);
    expect(fake.openingClaims()).toEqual({ sub: IDENTITY_SYSTEM_ACTOR, actor_type: 'system' });
  });

  it('inside the transaction app.current_tenant_id() is NULL; the context is transaction-local', async () => {
    const { fake, db } = mk();
    expect(await db.identityAuthTx(input(), (tx: any) => tenantOf(tx))).toBeNull();
    expect(await fake.tenantOutsideTx()).toBeNull();
    const t = fake.texts();
    expect(t[0]).toMatch(/^BEGIN/i);
    for (const c of t.find((x) => /set_config/i.test(x))!.match(/set_config\([^)]*\)/gi)!) expect(c).toMatch(/,\s*true\s*\)$/i);
  });

  it('request id / client ip / user agent are set like any request transaction', async () => {
    const { fake, db } = mk();
    await db.identityAuthTx(input(), async () => 1);
    const st = fake.log.find((l) => /set_config/i.test(l.text))!;
    expect(st.values.map(String).slice(1, 4)).toEqual([REQ_ID, '203.0.113.9', 'vitest']);
  });

  it('claims cannot be supplied or overridden by the caller (extra input claims are ignored)', async () => {
    const { fake, db } = mk();
    await db.identityAuthTx(input({ claims: { sub: 'attacker', tenant_id: TENANT_B, actor_type: 'user' } }), async () => 1);
    expect(fake.openingClaims()).toEqual({ sub: IDENTITY_SYSTEM_ACTOR, actor_type: 'system' });
  });

  it('commits on success; rolls back and releases on error; no context left behind', async () => {
    const { fake, db } = mk();
    await db.identityAuthTx(input(), async () => 1);
    await rejection(db.identityAuthTx(input(), async () => { throw new Error('boom'); }));
    const t = fake.texts();
    expect(t.filter((x) => /^COMMIT/i.test(x))).toHaveLength(1);
    expect(t.filter((x) => x === 'ROLLBACK')).toHaveLength(1);
    expect(fake.state.releasedInTx).toBe(0);
    expect(fake.state.releases).toBe(2);
    expect(await fake.tenantOutsideTx()).toBeNull();
  });

  it('DB errors reject mapped, like requestTx (23503 -> 404 common.not_found)', async () => {
    const { fake, db } = mk();
    fake.inject(/INSERT auth_events/, () => pgError('23503'));
    expect(await rejection(db.identityAuthTx(input(), (tx: any) => tx.query('INSERT auth_events')))).toMatchObject({ code: 'common.not_found', statusCode: 404 });
  });
});

describe('AC-0D-2.6 tx.bindTenant', () => {
  it('succeeds once: afterwards the ordinary tenant context applies (current tenant = bound tenant), still system actor', async () => {
    const { fake, db } = mk();
    const seen = await db.identityAuthTx(input(), async (tx: any) => {
      const before = await tenantOf(tx);
      await tx.bindTenant(TENANT_A);
      return [before, await tenantOf(tx)];
    });
    expect(seen).toEqual([null, TENANT_A]);
    const rebind = fake.log.filter((l) => /set_config\(\s*'request\.jwt\.claims'/i.test(l.text)).at(-1)!;
    expect(JSON.parse(String(rebind.values[0]))).toEqual({ sub: IDENTITY_SYSTEM_ACTOR, actor_type: 'system', tenant_id: TENANT_A });
    expect(rebind.text).toMatch(/,\s*true\s*\)/i); // transaction-local rewrite
    expect(await fake.tenantOutsideTx()).toBeNull();
  });

  it('a second call throws common.internal — same tenant or another (A-20: no writing into a tenant the DEFINER did not choose)', async () => {
    for (const second of [TENANT_A, TENANT_B]) {
      const { db } = mk();
      const e = await rejection(db.identityAuthTx(input(), async (tx: any) => {
        await tx.bindTenant(TENANT_A);
        await tx.bindTenant(second);
      }));
      expect(e).toMatchObject({ code: 'common.internal' });
    }
  });

  it('the failed second call does not change the bound tenant (the transaction rolls back; nothing leaks)', async () => {
    const { fake, db } = mk();
    await rejection(db.identityAuthTx(input(), async (tx: any) => { await tx.bindTenant(TENANT_A); await tx.bindTenant(TENANT_B); }));
    expect(await fake.tenantOutsideTx()).toBeNull();
    expect(fake.texts()).toContain('ROLLBACK');
  });

  it('the tenant id is a bind parameter (never SQL text) and must be a UUID', async () => {
    const { fake, db } = mk();
    await db.identityAuthTx(input(), (tx: any) => tx.bindTenant(TENANT_A));
    for (const s of fake.log) expect(s.text).not.toContain(TENANT_A);
    for (const bad of ["x'); DROP TABLE core.tenants; --", '', 'not-a-uuid', '*']) {
      const { db: d } = mk();
      await rejection(d.identityAuthTx(input(), (tx: any) => tx.bindTenant(bad)));
    }
  });

  it('a retry (40001) starts a fresh attempt: bindTenant is allowed once again in the new transaction', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE session/, () => pgError('40001'), 1);
    let binds = 0;
    await db.identityAuthTx(input(), async (tx: any) => {
      await tx.bindTenant(TENANT_A);
      binds += 1;
      await tx.query('UPDATE session SET seen = now()');
    });
    expect(binds).toBe(2);
  });

  it('only identityAuthTx transactions have bindTenant; an ordinary request transaction does not', async () => {
    const { db } = mk();
    const has = await db.requestTx(
      { claims: { sub: IDENTITY_SYSTEM_ACTOR, actor_type: 'system' }, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'v',
        operation: { module: 'identity', operationId: 'loginStaff', context: 'tenant' } },
      async (tx: any) => typeof tx.bindTenant,
    );
    expect(has).toBe('undefined');
  });
});

describe('AC-0D-2.6 the same call from any other operation or module throws, before touching the database', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['other module, listed operationId', { module: 'catalog' }],
    ['module core', { module: 'core' }],
    ['module patients-like (engagement)', { module: 'engagement', operationId: 'resolvePatientSession' }],
    ['identity but operationId not listed', { operationId: 'getUser' }],
    ['identity, listed id, but not tagged x-context: identity_auth (tenant)', { context: 'tenant' }],
    ['identity, listed id, platform context', { context: 'platform' }],
    ['identity, listed id, context missing', { context: undefined }],
    ['operationId with different case', { operationId: 'LoginStaff' }],
    ['operationId with whitespace', { operationId: 'loginStaff ' }],
    ['operationId prototype key', { operationId: 'constructor' }],
    ['operationId __proto__', { operationId: '__proto__' }],
  ];
  it.each(cases)('%s', async (_n, over) => {
    const { fake, db } = mk();
    await rejection(db.identityAuthTx(input({ operation: authOp(over) }), async () => 'should not run'));
    expect(fake.log).toHaveLength(0);
    expect(fake.state.connects).toBe(0);
  });

  it('a missing operation descriptor throws', async () => {
    const { fake, db } = mk();
    await rejection(db.identityAuthTx(input({ operation: undefined }), async () => 1));
    expect(fake.log).toHaveLength(0);
  });

  it('the allowlist is configurable: an id removed from LIMS_CORE_IDENTITY_AUTH_OPS is refused, a custom one is accepted', async () => {
    const { fake, db } = mk({ identityAuthOps: ['loginPartner'] });
    await rejection(db.identityAuthTx(input({ operation: authOp({ operationId: 'loginStaff' }) }), async () => 1));
    expect(fake.log).toHaveLength(0);
    expect(await db.identityAuthTx(input({ operation: authOp({ operationId: 'loginPartner' }) }), async () => 'ok')).toBe('ok');
  });

  it('requestTx cannot be used to get identity-auth claims: it never adds a system actor of its own', async () => {
    const { fake, db } = mk();
    await db.requestTx(
      { claims: { sub: '0190a000-0000-7000-8000-00000000a001', tenant_id: TENANT_A, actor_type: 'user' }, requestId: REQ_ID, clientIp: '203.0.113.9',
        userAgent: 'v', operation: { module: 'catalog', operationId: 'listTests', context: 'tenant' } },
      async () => 1,
    );
    expect(fake.openingClaims()).not.toMatchObject({ sub: IDENTITY_SYSTEM_ACTOR });
  });
});

describe('authz guard exemption (02-TRD §6.2 stage 9, D-212)', () => {
  it('x-context: identity_auth is exempt; tenant, platform and untagged operations are not', () => {
    expect(authzGuardExempt({ context: 'identity_auth' })).toBe(true);
    expect(authzGuardExempt({ context: 'tenant' })).toBe(false);
    expect(authzGuardExempt({ context: 'platform' })).toBe(false);
    expect(authzGuardExempt({})).toBe(false);
    expect(authzGuardExempt({ context: 'Identity_Auth' })).toBe(false);
  });
});
