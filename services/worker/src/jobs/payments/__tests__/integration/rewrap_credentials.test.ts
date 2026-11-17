// PG-T17 (C15) — worker task `payments.rewrap_credentials` (02-TRD §6.9 "Rotation: re-encrypts rows whose secret_kek_id ≠ active (daily, per tenant)", §8.3 row
// `payments.rewrap_credentials` cron `10 21 * * *` per_tenant, 03-APP-FLOW KEK rotated, 07-SECURITY §KEK + REQ-SEC-128, RB-7).
// Seam (spec fixes the FILE only): services/worker/src/jobs/payments/tasks/rewrap_credentials.ts
//   export const REWRAP_CREDENTIALS = 'payments.rewrap_credentials'
//   export function createRewrapCredentials(deps: { kek: Kek }): TaskHandler      // (payload { tenant_id }, ctx: JobContext) => Promise<void>
//   Uses ctx.tx (the per-tenant job transaction); SQL stays in the dialect of api/.../__tests__/helpers/merchantDb.ts. cron.ts / manifest wiring belongs to the cron task, not tested here.
// Fails now: ../../tasks/rewrap_credentials.js does not exist.
import { afterEach, describe, expect, it } from 'vitest';
import { encryptSecret, openSecret, secretFingerprint, type Kek } from '../../../../../../api/src/modules/payments/service/credentials.js';
import { makeMerchantDb, TENANT_A, TENANT_B, USER, type Row } from '../../../../../../api/src/modules/payments/__tests__/helpers/merchantDb.js';
import { captureOutput, makeKek, onlyKey, plantSecret, rotateKek, variants } from '../../../../../../api/src/modules/payments/__tests__/helpers/merchantFixtures.js';
import { REWRAP_CREDENTIALS, createRewrapCredentials } from '../../tasks/rewrap_credentials.js';

const T = 30_000;
const ID1 = '01930000-0000-7000-8000-0000000000a1';
const ID2 = '01930000-0000-7000-8000-0000000000a2';
const ID3 = '01930000-0000-7000-8000-0000000000b1';
type Handler = (payload: { tenant_id?: string }, ctx: any) => Promise<void>;
const aad = (tenantId: string, gateway: string, environment: string, merchantAccountId: string) => ({ tenantId, gateway, environment, merchantAccountId });

/** A merchant_accounts row whose secret is encrypted under `kek`'s ACTIVE key with the real PG-T03 code. */
function accountRow(kek: Kek, o: { id: string; tenant?: string; gateway?: string; environment?: string; secret?: string | null }): Row {
  const tenant = o.tenant ?? TENANT_A; const gateway = o.gateway ?? 'khalti'; const environment = o.environment ?? 'uat';
  const base: Row = { id: o.id, tenant_id: tenant, gateway, environment, is_enabled: false, api_refunds_enabled: false, version: 3, is_active: true, created_at: new Date(), updated_at: new Date(), created_by: USER, updated_by: USER,
    khalti_website_url: gateway === 'khalti' ? 'https://lab.example.test' : null, esewa_product_code: gateway === 'esewa' ? 'LABCODE01' : null };
  if (o.secret === null) return base;
  const e = encryptSecret(kek, o.secret ?? plantSecret(), aad(tenant, gateway, environment, o.id));
  return { ...base, secret_ciphertext: e.ciphertext, secret_nonce: e.nonce, secret_auth_tag: e.authTag, secret_kek_id: e.kekId, secret_fingerprint: e.fingerprint, secret_set_at: new Date(), secret_set_by: USER };
}
const plain = (kek: Kek, row: Row) => openSecret(kek, { ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, authTag: row.secret_auth_tag, kekId: row.secret_kek_id }, aad(row.tenant_id, row.gateway, row.environment, row.id)).use((s) => s);
const runTask = (db: ReturnType<typeof makeMerchantDb>, h: Handler, tenantId = TENANT_A) => db.run((ctx) => h({ tenant_id: tenantId }, { ...ctx, tenantId, actor: { type: 'system', id: USER }, attempt: 1, maxAttempts: 3, jobId: 'job-1' }), { tenantId });
let cap: ReturnType<typeof captureOutput> | undefined;
afterEach(() => { cap?.restore(); cap = undefined; });

describe('payments.rewrap_credentials — rotation (TRD §6.9)', () => {
  it('the task id is exactly payments.rewrap_credentials (<module>.<snake_task>)', () => { expect(REWRAP_CREDENTIALS).toBe('payments.rewrap_credentials'); });

  it('rewrap after KEK change: rows under the old key id are re-encrypted under the new ACTIVE id; the secret is unchanged, nonce/ciphertext are fresh, fingerprint is kept', { timeout: T }, async () => {
    const oldKek = makeKek('kek-old'); const secret = plantSecret(); const newKek = rotateKek(oldKek, 'kek-new');
    const seeded = accountRow(oldKek, { id: ID1, secret }); const db = makeMerchantDb({ merchant_accounts: [seeded] });
    await runTask(db, createRewrapCredentials({ kek: newKek }) as Handler);
    const row = db.accounts()[0]!;
    expect(row.secret_kek_id).toBe('kek-new');
    expect(row.secret_nonce).toHaveLength(12); expect(row.secret_auth_tag).toHaveLength(16);
    expect(row.secret_nonce.equals(seeded.secret_nonce)).toBe(false); expect(row.secret_ciphertext.equals(seeded.secret_ciphertext)).toBe(false);
    expect(row.secret_fingerprint).toBe(secretFingerprint(secret));
    expect(await plain(onlyKey(newKek, 'kek-new'), row)).toBe(secret);              // decryptable with the NEW key alone: the old key can now be retired (RB-7)
    expect(() => openSecret(onlyKey(oldKek, 'kek-old'), { ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, authTag: row.secret_auth_tag, kekId: 'kek-old' }, aad(TENANT_A, 'khalti', 'uat', ID1))).toThrow();
  });

  it('every non-active row of the tenant is rewrapped, each under ITS OWN aad (slot + account id); rows already on the active key and rows without a secret are left byte-identical', { timeout: T }, async () => {
    const oldKek = makeKek('kek-old'); const newKek = rotateKek(oldKek, 'kek-new'); const s1 = plantSecret(); const s2 = plantSecret();
    const rows = [accountRow(oldKek, { id: ID1, gateway: 'khalti', secret: s1 }), accountRow(oldKek, { id: ID2, gateway: 'esewa', secret: s2 }),
      accountRow(newKek, { id: '01930000-0000-7000-8000-0000000000a3', gateway: 'khalti', environment: 'production' }), accountRow(newKek, { id: '01930000-0000-7000-8000-0000000000a4', gateway: 'fonepay', secret: null })];
    const db = makeMerchantDb({ merchant_accounts: rows.map((r) => ({ ...r })) });
    await runTask(db, createRewrapCredentials({ kek: newKek }) as Handler);
    const [a, b, c, d] = db.accounts();
    expect([a!.secret_kek_id, b!.secret_kek_id, c!.secret_kek_id]).toEqual(['kek-new', 'kek-new', 'kek-new']);
    expect(await plain(newKek, a!)).toBe(s1); expect(await plain(newKek, b!)).toBe(s2);
    expect(c!.secret_ciphertext.equals(rows[2]!.secret_ciphertext)).toBe(true); expect(c!.secret_nonce.equals(rows[2]!.secret_nonce)).toBe(true); expect(c!.version).toBe(3);
    expect(d!.secret_ciphertext ?? null).toBeNull(); expect(d!.secret_kek_id ?? null).toBeNull(); expect(d!.version).toBe(3);
    // each row stays bound to its own aad: row A's blob does not open as row B
    expect(() => openSecret(newKek, { ciphertext: a!.secret_ciphertext, nonce: a!.secret_nonce, authTag: a!.secret_auth_tag, kekId: 'kek-new' }, aad(TENANT_A, 'esewa', 'uat', ID2))).toThrow();
  });

  it('is idempotent: a second run issues no UPDATE and changes nothing', { timeout: T }, async () => {
    const oldKek = makeKek('kek-old'); const newKek = rotateKek(oldKek, 'kek-new');
    const db = makeMerchantDb({ merchant_accounts: [accountRow(oldKek, { id: ID1 })] }); const h = createRewrapCredentials({ kek: newKek }) as Handler;
    await runTask(db, h); const after1 = { ...db.accounts()[0]! }; const mark = db.stmts.length;
    await runTask(db, h);
    expect(db.stmts.slice(mark).filter((s) => /^\s*(update|insert|delete)\b/i.test(s.text))).toEqual([]);
    expect(db.accounts()[0]!.secret_ciphertext.equals(after1.secret_ciphertext)).toBe(true); expect(db.accounts()[0]!.version).toBe(after1.version);
  });

  it('per tenant: only the payload tenant\'s rows are rewrapped; another tenant\'s old-key row is not touched', { timeout: T }, async () => {
    const oldKek = makeKek('kek-old'); const newKek = rotateKek(oldKek, 'kek-new');
    const db = makeMerchantDb({ merchant_accounts: [accountRow(oldKek, { id: ID1 }), accountRow(oldKek, { id: ID3, tenant: TENANT_B })] });
    await runTask(db, createRewrapCredentials({ kek: newKek }) as Handler, TENANT_A);
    expect(db.accounts(TENANT_A)[0]!.secret_kek_id).toBe('kek-new'); expect(db.accounts(TENANT_B)[0]!.secret_kek_id).toBe('kek-old');
    await runTask(db, createRewrapCredentials({ kek: newKek }) as Handler, TENANT_B);
    expect(db.accounts(TENANT_B)[0]!.secret_kek_id).toBe('kek-new');
  });

  it('an empty tenant (no accounts) is a clean no-op', { timeout: T }, async () => {
    const db = makeMerchantDb(); await expect(runTask(db, createRewrapCredentials({ kek: makeKek('kek-1') }) as Handler)).resolves.toBeUndefined();
    expect(db.stmts.filter((s) => /^\s*(update|insert|delete)\b/i.test(s.text))).toEqual([]);
  });

  it('a row whose kek id is no longer in the KEK file, or whose ciphertext fails authentication, is left unchanged and nothing leaks (fail closed, no corruption)', { timeout: T }, async () => {
    cap = captureOutput(); const gone = makeKek('kek-gone'); const newKek = makeKek('kek-new'); const sGone = plantSecret(); const sBad = plantSecret(); const sGood = plantSecret();
    const tampered = accountRow(newKek, { id: ID2, gateway: 'esewa', secret: sBad }); tampered.secret_kek_id = 'kek-new'; tampered.secret_ciphertext = Buffer.from(tampered.secret_ciphertext.map((x: number) => x ^ 1));
    const rotated = rotateKek(newKek, 'kek-newer'); const goodOld = accountRow(newKek, { id: ID1, secret: sGood });
    const seeds = [goodOld, accountRow(gone, { id: '01930000-0000-7000-8000-0000000000a5', environment: 'production', secret: sGone }), tampered].map((r) => ({ ...r }));
    const db = makeMerchantDb({ merchant_accounts: seeds });
    await runTask(db, createRewrapCredentials({ kek: rotated }) as Handler).catch(() => undefined);   // may reject or resolve; the invariants below must hold either way
    const [g, bad, t] = db.accounts();
    expect(bad!.secret_kek_id).toBe('kek-gone'); expect(bad!.secret_ciphertext.equals(seeds[1]!.secret_ciphertext)).toBe(true);
    expect(t!.secret_ciphertext.equals(seeds[2]!.secret_ciphertext)).toBe(true);                       // never overwritten with garbage
    if (g!.secret_kek_id === 'kek-newer') expect(await plain(rotated, g!)).toBe(sGood);                // if it was rewrapped, it must still decrypt to the same secret
    else expect(g!.secret_ciphertext.equals(seeds[0]!.secret_ciphertext)).toBe(true);
    for (const s of [sGone, sBad, sGood]) { noLeak(cap.text(), s); noLeak(JSON.stringify(db.logs), s); }
  });

  it('planted-secret scan: neither the plaintext secret nor its encodings is ever sent to the database, logged, or written to console/stdout/stderr', { timeout: T }, async () => {
    cap = captureOutput(); const oldKek = makeKek('kek-old'); const newKek = rotateKek(oldKek, 'kek-new'); const secret = plantSecret();
    const db = makeMerchantDb({ merchant_accounts: [accountRow(oldKek, { id: ID1, secret })] });
    await runTask(db, createRewrapCredentials({ kek: newKek }) as Handler);
    noLeak(db.sentText(), secret); noLeak(db.storedText(), secret); noLeak(JSON.stringify(db.logs), secret); noLeak(cap.text(), secret);
  });

  it('a failed UPDATE propagates (the job retries) and the transaction leaves the row on the old key', { timeout: T }, async () => {
    const oldKek = makeKek('kek-old'); const newKek = rotateKek(oldKek, 'kek-new'); const db = makeMerchantDb({ merchant_accounts: [accountRow(oldKek, { id: ID1 })] });
    await expect(db.run(async (ctx) => {
      const tx = ctx.tx; const q = tx.query.bind(tx);
      tx.query = async (text: string, values?: unknown[]) => { if (/^\s*update\b/i.test(text)) throw Object.assign(new Error('boom'), { code: '57014' }); return q(text, values); };
      await (createRewrapCredentials({ kek: newKek }) as Handler)({ tenant_id: TENANT_A }, { ...ctx, tenantId: TENANT_A });
    }, { rollback: true })).rejects.toThrow();
    expect(db.accounts()[0]!.secret_kek_id).toBe('kek-old');
  });
});

function noLeak(haystack: string, secret: string): void { for (const v of variants(secret)) expect(haystack.includes(v), `secret leaked (${v === secret ? 'plain' : 'encoded'})`).toBe(false); }
