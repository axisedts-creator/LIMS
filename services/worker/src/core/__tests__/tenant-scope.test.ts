// Core-internal 4-arg withTenantScope (02-TRD §7.1, 08 A23.1/A23.2, D-214; AC-0D-5.15 isolation step). Unit test on a recording fake tx.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, systemActorOf } from './helpers.js';
import { withTenantScope } from '../tenant-scope.js';

const BASE = { sub: systemActorOf('core'), actor_type: 'system' };

/** Fake open transaction: tracks request.jwt.claims exactly like set_config('request.jwt.claims', $1, true) would. */
function fakeTx() {
  let claims: any = { ...BASE };
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    get claims() { return claims; },
    async query(text: string, values: unknown[] = []) {
      sql.push({ text, values });
      if (/set_config\(\s*'request\.jwt\.claims'/i.test(text)) claims = JSON.parse(String(values[0]));
      return { rows: [] };
    },
  };
  return { tx: tx as any, sql };
}

describe('core-internal withTenantScope', () => {
  const actor = systemActorOf('lab');

  it('inside fn the claims are {sub: systemActorId, tenant_id, actor_type: system}; afterwards the previous claims are restored', async () => {
    const { tx } = fakeTx();
    let inside: any;
    const out = await withTenantScope(tx, TENANT_A, actor, async () => { inside = { ...tx.claims }; return 42; });
    expect(out).toBe(42);
    expect(inside).toEqual({ sub: actor, tenant_id: TENANT_A, actor_type: 'system' });
    expect(tx.claims).toEqual(BASE);
  });

  it('uses set_config(..., true) (transaction-local), never a session-level setting', async () => {
    const { tx, sql } = fakeTx();
    await withTenantScope(tx, TENANT_A, actor, async () => undefined);
    const sets = sql.filter((s) => /request\.jwt\.claims/.test(s.text));
    expect(sets.length).toBeGreaterThanOrEqual(2);                                   // switch + restore
    for (const s of sets) expect(s.text).toMatch(/set_config\([^)]*,\s*true\s*\)/i);
  });

  it('restores the previous claims when fn throws, and rethrows the same error', async () => {
    const { tx } = fakeTx();
    const boom = new Error('boom');
    await expect(withTenantScope(tx, TENANT_A, actor, async () => { throw boom; })).rejects.toBe(boom);
    expect(tx.claims).toEqual(BASE);
  });

  it('sequential scopes for different tenants never leak into each other', async () => {
    const { tx } = fakeTx();
    const seen: any[] = [];
    await withTenantScope(tx, TENANT_A, actor, async () => { seen.push(tx.claims.tenant_id); });
    expect(tx.claims.tenant_id).toBeUndefined();
    await withTenantScope(tx, TENANT_B, actor, async () => { seen.push(tx.claims.tenant_id); });
    expect(seen).toEqual([TENANT_A, TENANT_B]);
    expect(tx.claims).toEqual(BASE);
  });

  it.each(['', 'not-a-uuid', "x'; DROP TABLE core.tenant; --", '0190a000-0000-7000-8000-00000000aaa', undefined, null, 7])(
    'rejects a non-UUID tenantId (%j) before issuing any SQL', async (bad) => {
      const { tx, sql } = fakeTx();
      let ran = false;
      await expect(withTenantScope(tx, bad as any, actor, async () => { ran = true; })).rejects.toThrow();
      expect(ran).toBe(false);
      expect(sql).toHaveLength(0);
      expect(tx.claims).toEqual(BASE);
    });

  it('rejects a non-UUID systemActorId before issuing any SQL', async () => {
    const { tx, sql } = fakeTx();
    await expect(withTenantScope(tx, TENANT_A, 'nope', async () => undefined)).rejects.toThrow();
    expect(sql).toHaveLength(0);
  });

  it('rejects nested use on the same transaction (no tenant-to-tenant hop), leaving the outer scope intact', async () => {
    const { tx } = fakeTx();
    let innerRan = false;
    await withTenantScope(tx, TENANT_A, actor, async () => {
      await expect(withTenantScope(tx, TENANT_B, actor, async () => { innerRan = true; })).rejects.toThrow();
      expect(tx.claims.tenant_id).toBe(TENANT_A);
    });
    expect(innerRan).toBe(false);
    expect(tx.claims).toEqual(BASE);
  });

  it('can be used again after a failed scope (nesting guard is released on throw)', async () => {
    const { tx } = fakeTx();
    await expect(withTenantScope(tx, TENANT_A, actor, async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(withTenantScope(tx, TENANT_B, actor, async () => tx.claims.tenant_id)).resolves.toBe(TENANT_B);
  });
});
