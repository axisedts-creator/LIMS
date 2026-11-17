// preAuthTx (02-TRD §6.3): the claims-less transaction an AuthResolver runs in before any actor/tenant exists.
//   db.preAuthTx({ requestId, clientIp, userAgent, operation, scheme }, fn(tx, ctl))
//   - claims are exactly `{}` (no sub, no tenant_id); refused (common.internal, before any SQL) unless `scheme` is in PRE_AUTH_SCHEMES.
import { describe, expect, it } from 'vitest';
import { PRE_AUTH_SCHEMES } from '../allowlists.js';
import { createDb } from '../tx.js';
import { REQ_ID, createFakePgBouncer, rejection } from './helpers.js';

const input = (over: Record<string, unknown> = {}) => ({
  requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest', scheme: 'patientPreAuth',
  operation: { module: 'engagement', operationId: 'getPatientAppConfig' }, ...over,
});
const mk = (extra: Record<string, unknown> = {}) => {
  const fake = createFakePgBouncer(1);
  const db = createDb({ pool: fake.pool, sleep: async () => {}, random: () => 0, ...extra } as any) as any;
  return { fake, db };
};

describe('PRE_AUTH_SCHEMES', () => {
  it('is exactly patientPreAuth (everything else stays fail-closed until reviewed)', () => {
    expect([...PRE_AUTH_SCHEMES]).toEqual(['patientPreAuth']);
    expect(Object.isFrozen(PRE_AUTH_SCHEMES)).toBe(true);
  });
});

describe('db.preAuthTx', () => {
  it('opens with empty claims: no sub, no tenant_id, no other key', async () => {
    const { fake, db } = mk();
    expect(await db.preAuthTx(input(), async () => 'ok')).toBe('ok');
    expect(fake.openingClaims()).toEqual({});
  });

  it('app.current_tenant_id() is NULL inside, and the context is transaction-local', async () => {
    const { fake, db } = mk();
    const inside = await db.preAuthTx(input(), async (tx: any) => (await tx.query('SELECT app.current_tenant_id() AS tenant_id')).rows[0].tenant_id);
    expect(inside).toBeNull();
    expect(await fake.tenantOutsideTx()).toBeNull();
  });

  it.each(['portalSession', 'deviceToken', 'bearerJwt', '', undefined, 7])('refuses scheme %s with common.internal before any SQL', async (scheme) => {
    const { fake, db } = mk();
    const e = await rejection(db.preAuthTx(input({ scheme }), async () => 1));
    expect((e as any).code).toBe('common.internal');
    expect(fake.log.length).toBe(0);
  });

  it('refuses a call without an operation', async () => {
    const { fake, db } = mk();
    const e = await rejection(db.preAuthTx(input({ operation: undefined }), async () => 1));
    expect((e as any).code).toBe('common.internal');
    expect(fake.log.length).toBe(0);
  });

  it('a scheme list passed at boot replaces the default', async () => {
    const { db } = mk({ preAuthSchemes: ['portalSession'] });
    expect(await db.preAuthTx(input({ scheme: 'portalSession' }), async () => 'ok')).toBe('ok');
    expect(((await rejection(db.preAuthTx(input(), async () => 1))) as any).code).toBe('common.internal');
  });

  it('is not a request transaction: withTenantScope refuses a pre-auth tx', async () => {
    const { db } = mk({ scopeActorId: async () => '0190a000-0000-7000-8000-00000000a5a5' });
    const e = await rejection(db.preAuthTx(input(), (tx: any) => db.withTenantScope(tx, '0190a000-0000-7000-8000-00000000aaaa', async () => 1)));
    expect((e as any).code).toBe('common.internal');
  });

  it('a throwing fn rolls back and releases the connection', async () => {
    const { fake, db } = mk();
    await rejection(db.preAuthTx(input(), async () => { throw new Error('resolver failed'); }));
    expect(fake.log.some((s: any) => /^ROLLBACK/i.test(s.text.trim()))).toBe(true);
    expect(fake.state.releases).toBe(1);
    expect(fake.state.releasedInTx).toBe(0);
  });
});
