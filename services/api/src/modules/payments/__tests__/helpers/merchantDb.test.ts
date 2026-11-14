// PG-T17: self-test of the in-memory SQL fake and fixtures the PG-T17 tests stand on (so a red PG-T17 test means the implementation, not the fake).
import { describe, expect, it } from 'vitest';
import { encryptSecret, openSecret } from '../../service/credentials.js';
import { makeMerchantDb, TENANT_A, TENANT_B, USER } from './merchantDb.js';
import { esewaSim, khaltiSim, makeKek, plantSecret, prodConfig, rotateKek, uatConfig } from './merchantFixtures.js';

const ins = `INSERT INTO payments.merchant_accounts (id, tenant_id, gateway, environment, is_enabled, khalti_website_url, version, created_by, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7) RETURNING *`;
const id = '01930000-0000-7000-8000-0000000000a1';

describe('merchantDb fake', () => {
  it('insert / select / update / constraints / RLS / rollback / access log', async () => {
    const db = makeMerchantDb();
    const row = await db.run(async (c) => (await c.tx.query(ins, [id, TENANT_A, 'khalti', 'uat', false, 'https://x.test', USER])).rows[0]);
    expect(row).toMatchObject({ id, version: 1, is_active: true, api_refunds_enabled: false, secret_ciphertext: null });
    expect(await db.run(async (c) => (await c.tx.query('SELECT id FROM payments.merchant_accounts WHERE tenant_id = $1 AND gateway = $2 FOR UPDATE', [TENANT_A, 'khalti'])).rows)).toEqual([{ id }]);
    expect(await db.run(async (c) => (await c.tx.query('SELECT * FROM payments.merchant_accounts WHERE gateway = $1', ['khalti'])).rows, { tenantId: TENANT_B })).toEqual([]); // RLS
    const up = await db.run(async (c) => c.tx.query('UPDATE payments.merchant_accounts SET is_enabled = $1, version = version + 1, updated_at = now() WHERE id = $2 AND version = $3 RETURNING version', [false, id, 1]));
    expect(up.rows).toEqual([{ version: 2 }]);
    await expect(db.run(async (c) => c.tx.query('UPDATE payments.merchant_accounts SET is_enabled = true WHERE id = $1', [id]))).rejects.toMatchObject({ code: '23514' });  // enabled_complete
    await expect(db.run(async (c) => c.tx.query(ins, [id, TENANT_A, 'khalti', 'uat', false, 'https://x.test', USER]))).rejects.toMatchObject({ code: '23505' });
    await expect(db.run(async (c) => c.tx.query(ins, [id, TENANT_B, 'khalti', 'uat', false, 'https://x.test', USER]))).rejects.toMatchObject({ code: '42501' });
    await db.run(async (c) => c.tx.query('UPDATE payments.merchant_accounts SET version = 9 WHERE id = $1', [id]), { rollback: true });
    expect(db.accounts()[0]!.version).toBe(2);
    await db.run((c) => c.audit.access({ action: 'settings.change', entityType: 'payment_settings', outcome: 'allowed', detail: { fields: 'a,b' } }));
    expect(db.accessRows()).toEqual([{ action: 'settings.change', entityType: 'payment_settings', entityId: undefined, outcome: 'allowed', detail: { fields: 'a,b' } }]);
    await expect(db.run((c) => c.audit.access({ action: 'settings.change', entityType: 'payment_settings', outcome: 'allowed', detail: { fields: ['a'] } as never }))).rejects.toBeDefined(); // arrays refused by core
  });

  it('settings insert ... on conflict do nothing', async () => {
    const db = makeMerchantDb(); const q = 'INSERT INTO payments.settings (tenant_id, created_by, updated_by) VALUES ($1, $2, $2) ON CONFLICT (tenant_id) DO NOTHING';
    await db.run((c) => c.tx.query(q, [TENANT_A, USER])); await db.run((c) => c.tx.query(q, [TENANT_A, USER]));
    expect(db.settings()).toHaveLength(1); expect(db.settings()[0]).toMatchObject({ purchase_order_label: 'Lab payment', reconciliation_enabled: true, version: 1 });
  });

  it('fixtures: kek rotation keeps the old key, configs load, sims answer', async () => {
    const k1 = makeKek('kek-old'); const k2 = rotateKek(k1, 'kek-new'); expect(k2.activeId).toBe('kek-new'); expect([...k2.keys.keys()].sort()).toEqual(['kek-new', 'kek-old']);
    const aad = { tenantId: TENANT_A, gateway: 'esewa', environment: 'uat', merchantAccountId: id }; const e = encryptSecret(k1, 'abc', aad);
    expect(await openSecret(k2, e, aad).use((s) => s)).toBe('abc');
    expect(uatConfig().gatewayEnv).toBe('uat'); expect(prodConfig().gatewayEnv).toBe('production');
    const s = plantSecret(); const ks = khaltiSim(s);
    expect((await ks('https://x', { method: 'POST', headers: { Authorization: `Key ${s}` }, body: '{}' })).status).toBe(404);
    expect((await ks('https://x', { method: 'POST', headers: { Authorization: 'Key nope' }, body: '{}' })).status).toBe(401);
    expect(await (await esewaSim('code')('https://x')).json()).toHaveProperty('code');
  });
});
