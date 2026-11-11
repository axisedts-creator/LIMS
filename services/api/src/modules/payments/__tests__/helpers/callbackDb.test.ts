// PG-T09 helper self-test: payments.callbacks, the DEFINER emulation and the SAVEPOINT in merchantDb.ts behave like 05-SCHEMA §6 (so the contract tests rest on a sound fake).
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, makeMerchantDb } from './merchantDb';

const hash = (s: string) => createHash('sha256').update(s).digest();
const INTENT = '01930000-0000-7000-8000-0000000c1001';
const seed = () => {
  const db = makeMerchantDb();
  db.put('payments.intents', { id: INTENT, tenant_id: TENANT_A, callback_token_sha256: hash('tok-a'), created_at: new Date(Date.UTC(2026, 10, 11, 6)) });
  return db;
};
const ins = (outcome = 'ok', q: unknown = null, kind = 'launch', intent = INTENT) => (ctx: any) => ctx.tx.query(
  'INSERT INTO payments.callbacks (id, tenant_id, intent_id, gateway, kind, query_redacted, signature_valid, outcome_code, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
  [randomBytes(8).toString('hex'), TENANT_A, intent, 'esewa', kind, q, null, outcome, TENANT_A]);

describe('merchantDb PG-T09 additions', () => {
  it('callbacks: insert ok; bad kind/outcome/mobile violate their CHECKs; unknown intent violates the FK; rows are append-only', async () => {
    const db = seed();
    await db.run(ins('ok', JSON.stringify({ pidx: 'p' })));
    expect(db.callbacks()).toHaveLength(1);
    expect(db.callbacks()[0]!.received_at).toBeInstanceOf(Date);
    await expect(db.run(ins('nope'))).rejects.toMatchObject({ code: '23514', constraint: 'callbacks__outcome__ck' });
    await expect(db.run(ins('ok', null, 'bogus'))).rejects.toMatchObject({ constraint: 'callbacks__kind__ck' });
    await expect(db.run(ins('ok', JSON.stringify({ mobile: '1' })))).rejects.toMatchObject({ constraint: 'callbacks__no_mobile__ck' });
    await expect(db.run(ins('ok', null, 'launch', '01930000-0000-7000-8000-0000000c1999'))).rejects.toMatchObject({ code: '23503' });
    await expect(db.run((ctx: any) => ctx.tx.query("UPDATE payments.callbacks SET outcome_code = 'ok' WHERE intent_id = $1", [INTENT]))).rejects.toMatchObject({ code: '42501' });
    expect(db.callbacks(TENANT_B)).toHaveLength(0);
  });

  it('DEFINER emulation: live token -> (tenant_id, intent_id) across tenants; other hash / short hash / null / > 30 days -> nothing', async () => {
    const db = seed();
    const q = (h: unknown, now = new Date(Date.UTC(2026, 10, 12))) => db.run((ctx: any) => ctx.tx.query('SELECT tenant_id, intent_id FROM app.payments_resolve_callback_token($1::bytea)', [h]), { tenantId: TENANT_B, now: () => now });
    expect((await q(hash('tok-a'))).rows).toEqual([{ tenant_id: TENANT_A, intent_id: INTENT }]);
    expect((await q(hash('tok-b'))).rows).toEqual([]);
    expect((await q(randomBytes(31))).rows).toEqual([]);
    expect((await q(null)).rows).toEqual([]);
    expect((await q(hash('tok-a'), new Date(Date.UTC(2026, 11, 20)))).rows).toEqual([]);
  });

  it('ctx.db.tx = savepoint: a throw inside undoes the writes made inside it, keeps earlier ones, and rethrows', async () => {
    const db = seed();
    await db.run(async (ctx: any) => {
      await ins('ok')(ctx);
      await expect(ctx.db.tx(async () => { await ins('rate_limited')(ctx); throw new Error('boom'); })).rejects.toThrow('boom');
    });
    expect(db.callbacks().map((r) => r.outcome_code)).toEqual(['ok']);
  });
});
