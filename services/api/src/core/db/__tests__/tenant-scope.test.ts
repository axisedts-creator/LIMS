// T0D-03 — ctx.db.withTenantScope allowlist (08 R10 item 4 as amended by 08 A25 D-214; CR-C2-004). LIMS_CORE_WITH_TENANT_SCOPE_OPS.
// Expected API:
//   core/db/allowlists.ts: WITH_TENANT_SCOPE_OPS (readonly string[]) — default list of 02-TRD §6.3 (D-214); modules other than the three
//     A28.2 patient-context writes (gated by D-218, not asserted here) are as listed below.
//   createDb({ ..., withTenantScopeOps?: ReadonlySet<string> | readonly string[], identitySystemActorId })
//   db.withTenantScope(tx, tenantId, fn) -> fn() runs with transaction-local claims { sub: <identity system actor>, actor_type: 'system', tenant_id };
//     on return (or throw) the previous claims are restored. Allowed only when tx.operation = { module: 'identity', context: 'platform',
//     operationId ∈ allowlist }; otherwise throws before any statement is issued. No module other than identity may call it.
import { describe, expect, it } from 'vitest';
import { WITH_TENANT_SCOPE_OPS } from '../allowlists.js';
import { createDb } from '../tx.js';
import { IDENTITY_SYSTEM_ACTOR, REQ_ID, SUB, TENANT_A, TENANT_B, createFakePgBouncer, pgError, rejection } from './helpers.js';

const D214 = [
  'provisionTenant', 'inviteTenantAdmin', 'activateTenant', 'suspendTenant', 'reactivateTenant', 'terminateTenant',
  'updateTenantSettingsAsPlatform', 'setFeatureFlagAsPlatform', 'openSupportSession', 'activateSupportSession', 'endSupportSession',
  'revokeSupportSession', 'getDeadLetter',
];
const PLATFORM_CLAIMS = { sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: '0190a000-0000-7000-8000-00000000b001' };
const op = (over: Record<string, unknown> = {}) => ({ module: 'identity', operationId: 'suspendTenant', context: 'platform', ...over });
const open = (db: any, operation: Record<string, unknown>, fn: (tx: any) => Promise<any>) =>
  db.requestTx({ claims: PLATFORM_CLAIMS, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'v', operation }, fn);
const mk = (extra: Record<string, unknown> = {}) => {
  const fake = createFakePgBouncer(1);
  const db = createDb({ pool: fake.pool, sleep: async () => {}, random: () => 0, identitySystemActorId: IDENTITY_SYSTEM_ACTOR, ...extra } as any) as any;
  return { fake, db };
};
const tenantOf = async (tx: any) => (await tx.query('SELECT app.current_tenant_id() AS tenant_id')).rows[0].tenant_id;
const claimsWrites = (fake: ReturnType<typeof createFakePgBouncer>) =>
  fake.log.filter((l) => /set_config\(\s*'request\.jwt\.claims'/i.test(l.text));

describe('withTenantScope allowlist (D-214)', () => {
  it('the default list contains every operationId of 02-TRD §6.3 (D-214 extension included)', () => {
    expect(WITH_TENANT_SCOPE_OPS).toEqual(expect.arrayContaining(D214));
  });

  it('the default list contains no tenant-context login/session operation (those use identityAuthTx)', () => {
    for (const id of ['loginStaff', 'resolveSession', 'loginPartner']) expect(WITH_TENANT_SCOPE_OPS).not.toContain(id);
  });

  it.each(D214)('identity + platform context + %s: allowed, fn runs under the tenant', async (operationId) => {
    const { db } = mk();
    const r = await open(db, op({ operationId }), (tx) => db.withTenantScope(tx, TENANT_A, () => tenantOf(tx)));
    expect(r).toBe(TENANT_A);
  });

  it('claims inside the scope are { sub: <identity system actor>, actor_type: system, tenant_id }; transaction-local', async () => {
    const { fake, db } = mk();
    await open(db, op(), (tx) => db.withTenantScope(tx, TENANT_A, async () => 1));
    const inner = claimsWrites(fake)[1];
    expect(JSON.parse(String(inner.values[0]))).toEqual({ sub: IDENTITY_SYSTEM_ACTOR, actor_type: 'system', tenant_id: TENANT_A });
    expect(inner.text).toMatch(/,\s*true\s*\)/i);
  });

  it('after fn returns the platform claims are restored (no tenant); a second scope for another tenant works', async () => {
    const { fake, db } = mk();
    const seen = await open(db, op(), async (tx) => {
      const out: Array<string | null> = [await tenantOf(tx)];
      out.push(await db.withTenantScope(tx, TENANT_A, () => tenantOf(tx)));
      out.push(await tenantOf(tx));
      out.push(await db.withTenantScope(tx, TENANT_B, () => tenantOf(tx)));
      out.push(await tenantOf(tx));
      return out;
    });
    expect(seen).toEqual([null, TENANT_A, null, TENANT_B, null]);
    expect(await fake.tenantOutsideTx()).toBeNull();
  });

  it('claims are restored when fn throws, and the error propagates', async () => {
    const { db } = mk();
    const boom = new Error('inner');
    const out = await open(db, op(), async (tx) => {
      const e = await rejection(db.withTenantScope(tx, TENANT_A, async () => { throw boom; }));
      return [e === boom, await tenantOf(tx)];
    });
    expect(out).toEqual([true, null]);
  });

  it('the restored claims are exactly the original platform claims', async () => {
    const { fake, db } = mk();
    await open(db, op(), (tx) => db.withTenantScope(tx, TENANT_A, async () => 1));
    const w = claimsWrites(fake);
    expect(JSON.parse(String(w[w.length - 1].values[0]))).toEqual(PLATFORM_CLAIMS);
  });

  it('the tenant id is a bind parameter and must be a UUID', async () => {
    const { fake, db } = mk();
    await open(db, op(), (tx) => db.withTenantScope(tx, TENANT_A, async () => 1));
    for (const s of fake.log) expect(s.text).not.toContain(TENANT_A);
    for (const bad of ["x'); DROP TABLE core.tenants; --", '', 'not-a-uuid']) {
      const { db: d } = mk();
      await rejection(open(d, op(), (tx) => d.withTenantScope(tx, bad, async () => 1)));
    }
  });
});

describe('withTenantScope refusals — thrown before fn runs and before any scope statement', () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    ['operationId not on the list (loginStaff)', { operationId: 'loginStaff' }],
    ['operationId not on the list (listTests)', { operationId: 'listTests' }],
    ['listed id from another module (catalog)', { module: 'catalog' }],
    ['listed id from module core (no module code; core-internal uses are not operationIds)', { module: 'core' }],
    ['listed id from module audit', { module: 'audit' }],
    ['identity + listed id but tenant context', { context: 'tenant' }],
    ['identity + listed id but identity_auth context', { context: 'identity_auth' }],
    ['identity + listed id but no context', { context: undefined }],
    ['operationId differs in case', { operationId: 'SuspendTenant' }],
    ['operationId prototype key', { operationId: 'constructor' }],
  ];
  it.each(refused)('%s', async (_n, over) => {
    const { fake, db } = mk();
    let ran = false;
    await rejection(open(db, op(over), (tx) => db.withTenantScope(tx, TENANT_A, async () => { ran = true; })));
    expect(ran).toBe(false);
    expect(claimsWrites(fake)).toHaveLength(1); // only the opening claims; no scope rewrite
  });

  it('the allowlist is configurable (LIMS_CORE_WITH_TENANT_SCOPE_OPS): removed ids are refused, added ids accepted', async () => {
    const { db } = mk({ withTenantScopeOps: ['getDeadLetter'] });
    await rejection(open(db, op({ operationId: 'suspendTenant' }), (tx) => db.withTenantScope(tx, TENANT_A, async () => 1)));
    expect(await open(db, op({ operationId: 'getDeadLetter' }), (tx) => db.withTenantScope(tx, TENANT_A, async () => 'ok'))).toBe('ok');
  });

  it('a tx object forged by the caller (not produced by requestTx) is refused', async () => {
    const { fake, db } = mk();
    const forged = { operation: op(), query: async () => ({ rows: [] }) };
    await rejection(db.withTenantScope(forged, TENANT_A, async () => 1));
    expect(fake.log).toHaveLength(0);
  });

  it('identityAuthTx transactions cannot use withTenantScope (bindTenant is their only way to a tenant)', async () => {
    const { db } = mk();
    await rejection(db.identityAuthTx(
      { requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'v', operation: { module: 'identity', operationId: 'suspendTenant', context: 'identity_auth' } },
      (tx: any) => db.withTenantScope(tx, TENANT_A, async () => 1),
    ));
  });
});

describe('withTenantScope inside retry / errors', () => {
  it('a 40001 inside the scope retries the whole request; the scope is re-entered cleanly', async () => {
    const { fake, db } = mk();
    fake.inject(/UPDATE tenants/, () => pgError('40001'), 1);
    let runs = 0;
    const out = await open(db, op(), (tx) => {
      runs += 1;
      return db.withTenantScope(tx, TENANT_A, async () => { await tx.query('UPDATE tenants SET status = 1'); return tenantOf(tx); });
    });
    expect(runs).toBe(2);
    expect(out).toBe(TENANT_A);
  });
});
