// T0D-03 — "interleaving test": request context never leaks between tenants over a shared PgBouncer server connection.
// AC-0D-2.3, 03-APP-FLOW E-6, R-8, SP-9 (the real-PgBouncer proof is SP-9 / AC-0B-3.7; this runs the same scenario against a fake
// that models transaction-local vs session-level settings). API as in tx.test.ts.
import { describe, expect, it } from 'vitest';
import { createDb } from '../tx.js';
import { TENANT_A, TENANT_B, createFakePgBouncer, delay, pgError, rejection, txInput } from './helpers.js';

const claimsFor = (tenant: string) => ({ sub: '0190a000-0000-7000-8000-00000000a001', tenant_id: tenant, actor_type: 'user' });
const mk = (servers: number) => {
  const fake = createFakePgBouncer(servers);
  return { fake, db: createDb({ pool: fake.pool, sleep: async () => {}, random: () => 0 } as any) as any };
};
const readTenant = async (tx: any): Promise<string | null> => (await tx.query('SELECT app.current_tenant_id() AS tenant_id')).rows[0].tenant_id;

describe('AC-0D-2.3 context isolation', () => {
  it('two concurrent requests (tenants A, B) share ONE server connection: each sees its own tenant, an untransacted statement sees NULL', async () => {
    const { fake, db } = mk(1);
    const seen: Record<string, string[]> = { A: [], B: [] };
    const run = (name: 'A' | 'B', tenant: string) =>
      db.requestTx(txInput({ claims: claimsFor(tenant) }), async (tx: any) => {
        seen[name].push((await readTenant(tx))!);
        await delay(5);
        seen[name].push((await readTenant(tx))!);
      });
    await Promise.all([run('A', TENANT_A), run('B', TENANT_B)]);
    expect(seen.A).toEqual([TENANT_A, TENANT_A]);
    expect(seen.B).toEqual([TENANT_B, TENANT_B]);
    expect(new Set(fake.log.map((l) => l.server))).toEqual(new Set([0])); // really the same server connection
    expect(await fake.tenantOutsideTx()).toBeNull();
  });

  it('true statement interleaving on two server connections (A set, B set, A read, B read): no cross-talk', async () => {
    const { db } = mk(2);
    let aReady!: () => void, bReady!: () => void;
    const a = new Promise<void>((r) => (aReady = r));
    const b = new Promise<void>((r) => (bReady = r));
    const [ra, rb] = await Promise.all([
      db.requestTx(txInput({ claims: claimsFor(TENANT_A) }), async (tx: any) => { aReady(); await b; return readTenant(tx); }),
      db.requestTx(txInput({ claims: claimsFor(TENANT_B) }), async (tx: any) => { bReady(); await a; return readTenant(tx); }),
    ]);
    expect([ra, rb]).toEqual([TENANT_A, TENANT_B]);
  });

  it('50 concurrent alternating-tenant requests over 3 server connections with random delays: every read is its own tenant, no context left behind', async () => {
    const { fake, db } = mk(3);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const tenant = i % 2 ? TENANT_B : TENANT_A;
        return db.requestTx(txInput({ claims: claimsFor(tenant) }), async (tx: any) => {
          const first = await readTenant(tx);
          await delay(Math.floor(Math.random() * 6));
          return [tenant, first, await readTenant(tx)] as const;
        });
      }),
    );
    for (const [want, a, b] of results) { expect(a).toBe(want); expect(b).toBe(want); }
    for (const s of fake.servers) { expect(s.local.size).toBe(0); expect(s.session.size).toBe(0); }
    expect(fake.state.releasedInTx).toBe(0);
    expect(await fake.tenantOutsideTx()).toBeNull();
  });

  it('no context survives COMMIT: a statement outside a transaction right after sees NULL on the same server connection', async () => {
    const { fake, db } = mk(1);
    await db.requestTx(txInput({ claims: claimsFor(TENANT_A) }), async () => 1);
    expect(await fake.tenantOutsideTx()).toBeNull();
    expect(fake.servers[0].session.size).toBe(0);
  });

  it('no context survives ROLLBACK after a handler error', async () => {
    const { fake, db } = mk(1);
    await rejection(db.requestTx(txInput({ claims: claimsFor(TENANT_A) }), async (tx: any) => {
      expect(await readTenant(tx)).toBe(TENANT_A);
      throw new Error('boom');
    }));
    expect(await fake.tenantOutsideTx()).toBeNull();
  });

  it('no context survives a failed COMMIT / DB error mid-transaction', async () => {
    const { fake, db } = mk(1);
    fake.inject(/^COMMIT/i, () => pgError('23505', 'dup', { constraint: 'x' }));
    await rejection(db.requestTx(txInput({ claims: claimsFor(TENANT_A) }), async () => 1));
    expect(await fake.tenantOutsideTx()).toBeNull();
    fake.inject(/INSERT bad/, () => pgError('42501'));
    await rejection(db.requestTx(txInput({ claims: claimsFor(TENANT_B) }), (tx: any) => tx.query('INSERT bad')));
    expect(await fake.tenantOutsideTx()).toBeNull();
    expect(fake.state.releasedInTx).toBe(0);
  });

  it('a request with no tenant claim (platform actor) sees NULL tenant inside its tx, even right after a tenant request on the same connection', async () => {
    const { db } = mk(1);
    await db.requestTx(txInput({ claims: claimsFor(TENANT_A) }), async () => 1);
    const t = await db.requestTx(
      txInput({ claims: { sub: '0190a000-0000-7000-8000-00000000a002', actor_type: 'user', scope: 'platform' } }),
      (tx: any) => readTenant(tx),
    );
    expect(t).toBeNull();
  });

  it('the context a request sets is not influenced by input the caller does not own: claims object is serialised once and not mutated', async () => {
    const { fake, db } = mk(1);
    const claims = Object.freeze(claimsFor(TENANT_A));
    await db.requestTx(txInput({ claims }), async () => 1);
    expect(fake.openingClaims()).toEqual(claims);
  });
});
