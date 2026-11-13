// PG-T17 (C15) — merchant accounts + settings, operations P20–P23 (02-TRD §5 rows P20–P23, §5.1 access-log table, §6.9; 05-SCHEMA merchant_accounts / settings;
// 01-PRD US-PG-10 = AC-PG-10.1 … 10.5; 07-SECURITY ST-24, REQ-SEC-058/128/136; 08-CR-REGISTER A17 P-22 lazy singleton, A19 D-112 access log).
// Seam (the spec fixes the FILE only; names below are the tester's contract — the writer may dispute via .orchestra/cr):
//   service/merchant.service.ts  export function createMerchantService(deps: { config: PaymentsConfig; kek: Kek; fetch?: typeof fetch })  (fetch defaults to globalThis.fetch)
//     listMerchantAccounts(ctx)                                        -> { data: MerchantAccountDto[] }
//     putMerchantAccount(ctx, { gateway, environment, expectedVersion?, body }) -> MerchantAccountDto
//     testMerchantAccount(ctx, { gateway, environment })               -> { outcome, checked_at }
//     getPaymentSettings(ctx)                                          -> PaymentSettingsDto
//     updatePaymentSettings(ctx, { expectedVersion?, body })           -> PaymentSettingsDto
//   ctx = { tenantId, actor, tx: { query(text, values) }, audit: { access(entry) }, log, now() }; SQL stays in the dialect of helpers/merchantDb.ts.
//   Errors are LimsError: common.validation_failed 400, payments.gateway_not_available 503, common.precondition_required 428, common.version_conflict 409, common.not_found 404.
//   `detail` of the settings.change access row is `{ fields: <changed field names> }`; core/audit/access.ts only accepts string|number|boolean values, so the writer
//   joins the names (comma separated string); both an array and a string are accepted here. Permission (403) is the core pipeline's x-permission check: see merchant.contract.test.ts.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createMerchantService } from '../../service/merchant.service.js';
import { openSecret, secretFingerprint } from '../../service/credentials.js';
import { makeMerchantDb, NOW, TENANT_A, TENANT_B, USER, UUIDV7, type Row } from '../helpers/merchantDb.js';
import { captureOutput, esewaSim, failingSim, hangingSim, khaltiSim, makeKek, plantSecret, prodConfig, uatConfig, variants, type FetchSim } from '../helpers/merchantFixtures.js';

const T = 30_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const CODE = 'LABCODE01';
const SITE = 'https://lab.example.test';
const kek = makeKek('kek-1');

const setup = (o: { fetch?: FetchSim; config?: ReturnType<typeof uatConfig>; rows?: { merchant_accounts?: Row[]; settings?: Row[] } } = {}) => {
  const db = makeMerchantDb(o.rows);
  const svc = createMerchantService({ config: o.config ?? uatConfig(), kek, fetch: (o.fetch ?? esewaSim()) as never }) as unknown as Svc;
  return { db, svc };
};
type Db = ReturnType<typeof setup>['db'];
const put = (db: Db, svc: Svc, gateway: string, environment: string, body: object, o: { expectedVersion?: number; tenantId?: string; rollback?: boolean } = {}) =>
  db.run((ctx) => svc['putMerchantAccount']!(ctx, { gateway, environment, expectedVersion: o.expectedVersion, body }), { tenantId: o.tenantId, rollback: o.rollback });
const list = (db: Db, svc: Svc, tenantId?: string) => db.run((ctx) => svc['listMerchantAccounts']!(ctx), { tenantId });
const test = (db: Db, svc: Svc, gateway: string, environment: string, tenantId?: string) => db.run((ctx) => svc['testMerchantAccount']!(ctx, { gateway, environment }), { tenantId });
const getSettings = (db: Db, svc: Svc, tenantId?: string) => db.run((ctx) => svc['getPaymentSettings']!(ctx), { tenantId });
const putSettings = (db: Db, svc: Svc, body: object, o: { expectedVersion?: number; tenantId?: string } = {}) =>
  db.run((ctx) => svc['updatePaymentSettings']!(ctx, { expectedVersion: o.expectedVersion, body }), { tenantId: o.tenantId });
const esewaBody = (secret: string, extra: object = {}) => ({ is_enabled: true, esewa_product_code: CODE, secret, ...extra });
const khaltiBody = (secret: string, extra: object = {}) => ({ is_enabled: true, khalti_website_url: SITE, secret, ...extra });

const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
const validation400 = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code); };
const fieldsOf = (detail: Record<string, unknown>): string[] => { const f = detail['fields']; return (Array.isArray(f) ? f.map(String) : String(f ?? '').split(/[,\s]+/)).filter(Boolean).sort(); };
const noLeak = (haystack: string, secret: string, where: string) => { for (const v of variants(secret)) expect(haystack.includes(v), `${where} contains the secret (${v === secret ? 'plain' : 'encoded'})`).toBe(false); };
let cap: ReturnType<typeof captureOutput> | undefined;
afterEach(() => { cap?.restore(); cap = undefined; });

// ====================================================================================================== AC-PG-10.1 write-only secret
describe('putMerchantAccount (P21) — AC-PG-10.1 secret stored only as AES-256-GCM ciphertext', () => {
  it('AC-PG-10.1: saves an eSewa account -> DTO shows only is_set / set_at / fingerprint (sha256 first 8 hex), never the secret', { timeout: T }, async () => {
    const { db, svc } = setup(); const secret = plantSecret();
    const out = await put(db, svc, 'esewa', 'uat', esewaBody(secret));
    expect(out).toEqual({ gateway: 'esewa', environment: 'uat', is_enabled: true, esewa_product_code: CODE, api_refunds_enabled: false, version: 1,
      secret: { is_set: true, set_at: expect.stringMatching(ISO), fingerprint: createHash('sha256').update(secret).digest('hex').slice(0, 8) } });
    expect(out.secret.fingerprint).toBe(secretFingerprint(secret));
  });

  it('AC-PG-10.1: the row holds ciphertext under the ACTIVE kek id (12-byte nonce, 16-byte tag), decryptable only with AAD tenant|gateway|environment|account id', { timeout: T }, async () => {
    const { db, svc } = setup(); const secret = plantSecret();
    await put(db, svc, 'esewa', 'uat', esewaBody(secret));
    const [row] = db.accounts();
    expect(row!.id).toMatch(UUIDV7);
    expect(row!.secret_kek_id).toBe('kek-1');
    expect(Buffer.isBuffer(row!.secret_ciphertext) && Buffer.isBuffer(row!.secret_nonce) && Buffer.isBuffer(row!.secret_auth_tag)).toBe(true);
    expect(row!.secret_nonce).toHaveLength(12); expect(row!.secret_auth_tag).toHaveLength(16);
    expect(row!.secret_ciphertext.toString('utf8')).not.toContain(secret);
    expect(row!.secret_fingerprint).toBe(secretFingerprint(secret));
    expect(row!.secret_set_by).toBe(USER); expect(row!.secret_set_at).toBeInstanceOf(Date);
    const stored = { ciphertext: row!.secret_ciphertext, nonce: row!.secret_nonce, authTag: row!.secret_auth_tag, kekId: row!.secret_kek_id };
    const aad = { tenantId: TENANT_A, gateway: 'esewa', environment: 'uat', merchantAccountId: row!.id };
    expect(await openSecret(kek, stored, aad).use((s) => s)).toBe(secret);
    expect(() => openSecret(kek, stored, { ...aad, environment: 'production' })).toThrow();           // bound to its slot
    expect(() => openSecret(kek, stored, { ...aad, tenantId: TENANT_B })).toThrow();                    // bound to its tenant
  });

  it('AC-PG-10.1: planted-secret scan — nothing sent to the database (besides the ciphertext column), no access-log row, no log/console/stdout line, no DTO contains it', { timeout: T }, async () => {
    cap = captureOutput(); const { db, svc } = setup(); const secret = plantSecret();
    const out = await put(db, svc, 'esewa', 'uat', esewaBody(secret));
    const listed = await list(db, svc); const got = await put(db, svc, 'esewa', 'uat', { is_enabled: false }, { expectedVersion: 1 });
    noLeak(JSON.stringify(out), secret, 'PUT response'); noLeak(JSON.stringify(listed), secret, 'list response'); noLeak(JSON.stringify(got), secret, 'second PUT response');
    noLeak(db.sentText(), secret, 'SQL parameters'); noLeak(db.storedText(), secret, 'stored rows (non-secret columns)');
    noLeak(JSON.stringify(db.accessRows()), secret, 'access log'); noLeak(JSON.stringify(db.logs), secret, 'ctx.log'); noLeak(cap.text(), secret, 'console/stdout/stderr');
  });

  it('AC-PG-10.1: list (P20) -> { data: [dto] } with the same write-only shape; no ciphertext, nonce, tag or kek id key exists anywhere', { timeout: T }, async () => {
    const { db, svc } = setup(); await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret())); await put(db, svc, 'khalti', 'uat', khaltiBody(plantSecret()));
    const out = await list(db, svc);
    expect(Object.keys(out)).toEqual(['data']); expect(out.data).toHaveLength(2);
    expect(out.data.map((d: any) => `${d.gateway}/${d.environment}`).sort()).toEqual(['esewa/uat', 'khalti/uat']);
    const text = JSON.stringify(out);
    for (const bad of ['ciphertext', 'nonce', 'auth_tag', 'kek', 'tenant_id', 'created_by', 'secret_set_by']) expect(text, bad).not.toContain(bad);
    for (const d of out.data) expect(Object.keys(d.secret).sort()).toEqual(['fingerprint', 'is_set', 'set_at']);
  });

  it('list: a tenant with no accounts gets an empty data array; tenant B never sees tenant A\'s rows; both tenants may hold the same slot', { timeout: T }, async () => {
    const { db, svc } = setup(); await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()));
    expect(await list(db, svc, TENANT_B)).toEqual({ data: [] });
    await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()), { tenantId: TENANT_B });
    expect(db.accounts(TENANT_A)).toHaveLength(1); expect(db.accounts(TENANT_B)).toHaveLength(1);
    expect(db.accounts(TENANT_A)[0]!.id).not.toBe(db.accounts(TENANT_B)[0]!.id);
  });

  it('an account without a secret reports secret { is_set: false } and no fingerprint (stored disabled)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await put(db, svc, 'khalti', 'uat', { is_enabled: false, khalti_website_url: SITE });
    expect(out.secret).toEqual({ is_set: false });
    expect(db.accounts()[0]!.secret_ciphertext).toBeNull();
  });

  it('omitting `secret` on a later PUT keeps the stored secret untouched (write-only: absent = unchanged); sending it again re-encrypts with a fresh nonce and the new fingerprint', { timeout: T }, async () => {
    const { db, svc } = setup(); const s1 = plantSecret(); const s2 = plantSecret();
    await put(db, svc, 'esewa', 'uat', esewaBody(s1));
    const before = { ...db.accounts()[0]! };
    const v2 = await put(db, svc, 'esewa', 'uat', { is_enabled: false, esewa_product_code: CODE }, { expectedVersion: 1 });
    expect(v2.version).toBe(2); expect(v2.is_enabled).toBe(false); expect(v2.secret.fingerprint).toBe(secretFingerprint(s1));
    expect(db.accounts()[0]!.secret_ciphertext.equals(before.secret_ciphertext)).toBe(true);
    const v3 = await put(db, svc, 'esewa', 'uat', { is_enabled: true, esewa_product_code: CODE, secret: s2 }, { expectedVersion: 2 });
    expect(v3.secret.fingerprint).toBe(secretFingerprint(s2));
    const row = db.accounts()[0]!;
    expect(row.secret_nonce.equals(before.secret_nonce)).toBe(false); expect(row.secret_ciphertext.equals(before.secret_ciphertext)).toBe(false);
    expect(await openSecret(kek, { ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, authTag: row.secret_auth_tag, kekId: row.secret_kek_id }, { tenantId: TENANT_A, gateway: 'esewa', environment: 'uat', merchantAccountId: row.id }).use((s) => s)).toBe(s2);
  });

  it.each([
    ['over 256 characters', 'x'.repeat(257)], ['empty', ''], ['a number', 12345], ['an object', { a: 1 }], ['null', null],
  ])('rejects a secret that is %s with 400 and never echoes it; nothing is written', { timeout: T }, async (_n, bad) => {
    const { db, svc } = setup();
    const e = await rejection(put(db, svc, 'esewa', 'uat', esewaBody(bad as never)));
    validation400(e);
    if (typeof bad === 'string' && bad) expect(JSON.stringify({ m: e.message, d: e.details, errors: e.errors })).not.toContain(bad);
    expect(db.accounts()).toHaveLength(0); expect(db.accessRows()).toHaveLength(0);
  });

  it('accepts a secret of exactly 256 characters', { timeout: T }, async () => {
    const { db, svc } = setup(); const secret = 'k'.repeat(256);
    expect((await put(db, svc, 'esewa', 'uat', esewaBody(secret))).secret.fingerprint).toBe(secretFingerprint(secret));
  });

  it.each([
    ['unknown key', { extra: 1 }], ['mass-assigned kek id', { secret_kek_id: 'kek-evil' }], ['mass-assigned ciphertext', { secret_ciphertext: 'AAAA' }], ['mass-assigned version', { version: 99 }],
    ['mass-assigned last_test_outcome', { last_test_outcome: 'reachable_key_valid' }], ['mass-assigned id', { id: '01930000-0000-7000-8000-0000000000ff' }], ['mass-assigned tenant_id', { tenant_id: TENANT_B }],
  ])('S-5 mass assignment: %s -> 400, nothing written', { timeout: T }, async (_n, extra) => {
    const { db, svc } = setup();
    validation400(await rejection(put(db, svc, 'esewa', 'uat', esewaBody(plantSecret(), extra))));
    expect(db.accounts()).toHaveLength(0);
  });

  it.each([
    ['is_enabled missing', { esewa_product_code: CODE }], ['is_enabled not boolean', { is_enabled: 'yes' }], ['esewa product code over 64', { is_enabled: false, esewa_product_code: 'A'.repeat(65) }],
    ['esewa product code with a space', { is_enabled: false, esewa_product_code: 'BAD CODE' }], ['esewa product code with a quote', { is_enabled: false, esewa_product_code: "X'--" }],
    ['khalti url on an esewa account', { is_enabled: false, khalti_website_url: SITE }], ['api_refunds_enabled on eSewa', { is_enabled: false, api_refunds_enabled: true }],
  ])('eSewa body validation: %s -> 400, nothing written', { timeout: T }, async (_n, body) => {
    const { db, svc } = setup();
    validation400(await rejection(put(db, svc, 'esewa', 'uat', body)));
    expect(db.accounts()).toHaveLength(0);
  });

  it.each([
    ['http (not https) website url', { is_enabled: false, khalti_website_url: 'http://lab.example.test' }], ['website url over 300', { is_enabled: false, khalti_website_url: `https://${'a'.repeat(300)}.test` }],
    ['esewa product code on a khalti account', { is_enabled: false, esewa_product_code: CODE }], ['javascript: url', { is_enabled: false, khalti_website_url: 'javascript:alert(1)' }],
  ])('Khalti body validation: %s -> 400, nothing written', { timeout: T }, async (_n, body) => {
    const { db, svc } = setup();
    validation400(await rejection(put(db, svc, 'khalti', 'uat', body)));
    expect(db.accounts()).toHaveLength(0);
  });

  it('Khalti: api_refunds_enabled is accepted and stored', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await put(db, svc, 'khalti', 'uat', khaltiBody(plantSecret(), { api_refunds_enabled: true }))).api_refunds_enabled).toBe(true);
  });

  it('enabling an incomplete account (no secret yet) is a 400, not a 500 from the CHECK constraint; nothing is written', { timeout: T }, async () => {
    const { db, svc } = setup();
    validation400(await rejection(put(db, svc, 'esewa', 'uat', { is_enabled: true, esewa_product_code: CODE })));
    validation400(await rejection(put(db, svc, 'khalti', 'uat', { is_enabled: true, khalti_website_url: SITE })));
    expect(db.accounts()).toHaveLength(0);
  });

  it.each([['bitcoin', 'uat'], ['esewa', 'staging'], ['ESEWA', 'uat'], ['esewa', 'UAT'], ["esewa'--", 'uat']])('unknown slot %s/%s -> 400', { timeout: T }, async (gateway, environment) => {
    const { db, svc } = setup();
    validation400(await rejection(put(db, svc, gateway!, environment!, { is_enabled: false })));
    expect(db.accounts()).toHaveLength(0);
  });

  it('the write commits or rolls back as one: a rolled-back transaction leaves no account and no access-log row', { timeout: T }, async () => {
    const { db, svc } = setup();
    await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()), { rollback: true });
    expect(db.accounts()).toHaveLength(0); expect(db.accessRows()).toHaveLength(0);
  });

  it('versioning: first PUT of an absent slot needs no If-Match (version 1); an existing slot without If-Match -> 428; stale -> 409; matching -> version + 1', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()))).version).toBe(1);
    lims(await rejection(put(db, svc, 'esewa', 'uat', { is_enabled: false })), 'common.precondition_required', 428);
    lims(await rejection(put(db, svc, 'esewa', 'uat', { is_enabled: false }, { expectedVersion: 7 })), 'common.version_conflict', 409);
    expect(db.accounts()[0]!.version).toBe(1); expect(db.accounts()[0]!.is_enabled).toBe(true);
    expect((await put(db, svc, 'esewa', 'uat', { is_enabled: false }, { expectedVersion: 1 })).version).toBe(2);
  });

  it('two tenants saving the same slot do not touch each other\'s row (RLS / tenant filter)', { timeout: T }, async () => {
    const { db, svc } = setup(); const sa = plantSecret(); const sb = plantSecret();
    await put(db, svc, 'esewa', 'uat', esewaBody(sa)); await put(db, svc, 'esewa', 'uat', esewaBody(sb, { esewa_product_code: 'OTHERCODE' }), { tenantId: TENANT_B });
    expect(db.accounts(TENANT_A)[0]!.esewa_product_code).toBe(CODE); expect(db.accounts(TENANT_B)[0]!.esewa_product_code).toBe('OTHERCODE');
    expect(db.accounts(TENANT_A)[0]!.secret_fingerprint).toBe(secretFingerprint(sa)); expect(db.accounts(TENANT_B)[0]!.secret_fingerprint).toBe(secretFingerprint(sb));
  });
});

// ====================================================================================================== AC-PG-10.2 test connection
describe('testMerchantAccount (P22) — AC-PG-10.2 every outcome is a 200 and is stored', () => {
  it('AC-PG-10.2 Khalti: lookup of a random pidx answering {"detail":"Not found."} -> reachable_key_valid, stored in last_test_outcome / last_test_at', { timeout: T }, async () => {
    const secret = plantSecret(); const sim = khaltiSim(secret); const { db, svc } = setup({ fetch: sim });
    await put(db, svc, 'khalti', 'uat', khaltiBody(secret));
    const out = await test(db, svc, 'khalti', 'uat');
    expect(out).toEqual({ outcome: 'reachable_key_valid', checked_at: expect.stringMatching(ISO) });
    const row = db.accounts()[0]!; expect(row.last_test_outcome).toBe('reachable_key_valid'); expect(row.last_test_at).toBeInstanceOf(Date);
    expect(sim.calls).toHaveLength(1);
    expect(sim.calls[0]!.url.startsWith(uatConfig().khaltiBaseUrl)).toBe(true);                       // the configured (sandbox) host, nothing else
    const dto = (await list(db, svc)).data[0]; expect(dto.last_test).toEqual({ outcome: 'reachable_key_valid', at: expect.stringMatching(ISO) });
  });

  it('AC-PG-10.2 Khalti: a rejected key ({"detail":"Invalid token.","status_code":401}) resolves 200 { outcome: auth_failed } — no error code is thrown — and is stored', { timeout: T }, async () => {
    const stored = plantSecret(); const { db, svc } = setup({ fetch: khaltiSim(plantSecret('other')) });
    await put(db, svc, 'khalti', 'uat', khaltiBody(stored));
    const out = await test(db, svc, 'khalti', 'uat');                                                  // must not reject (no payments.credential_invalid)
    expect(out).toEqual({ outcome: 'auth_failed', checked_at: expect.stringMatching(ISO) });
    expect(db.accounts()[0]!.last_test_outcome).toBe('auth_failed');
    expect(db.accounts()[0]!.is_enabled).toBe(true);                                                   // a failed test does not silently disable the account
  });

  it.each([['status' as const], ['code' as const]])('AC-PG-10.2 eSewa: a documented JSON body with `%s` -> reachable_key_unverifiable (the secret cannot be proven), stored', { timeout: T }, async (shape) => {
    const sim = esewaSim(shape); const { db, svc } = setup({ fetch: sim });
    await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()));
    expect(await test(db, svc, 'esewa', 'uat')).toEqual({ outcome: 'reachable_key_unverifiable', checked_at: expect.stringMatching(ISO) });
    expect(db.accounts()[0]!.last_test_outcome).toBe('reachable_key_unverifiable');
    expect(sim.calls[0]!.url.startsWith(uatConfig().esewaStatusUrl)).toBe(true);
  });

  it('AC-PG-10.2: a transport failure -> 200 { outcome: unreachable }, stored (never a thrown error, never the raw error text)', { timeout: T }, async () => {
    const { db, svc } = setup({ fetch: failingSim(Object.assign(new Error('connect ECONNREFUSED 10.9.8.7:443'), { code: 'ECONNREFUSED' })) });
    await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()));
    const out = await test(db, svc, 'esewa', 'uat');
    expect(out).toEqual({ outcome: 'unreachable', checked_at: expect.stringMatching(ISO) });
    expect(JSON.stringify(out)).not.toContain('10.9.8.7'); expect(db.accounts()[0]!.last_test_outcome).toBe('unreachable');
  });

  it('AC-PG-10.2: the call is time-bounded — a gateway that never answers gives unreachable once LIMS_PAYMENTS_HTTP_TIMEOUT_INREQUEST_MS elapses', { timeout: T }, async () => {
    const sim = hangingSim(); const { db, svc } = setup({ fetch: sim, config: uatConfig({ LIMS_PAYMENTS_HTTP_TIMEOUT_INREQUEST_MS: '60' }) });
    await put(db, svc, 'khalti', 'uat', khaltiBody(plantSecret()));
    expect((await test(db, svc, 'khalti', 'uat')).outcome).toBe('unreachable');
    expect(sim.calls[0]!.signal).toBeDefined(); expect(db.accounts()[0]!.last_test_outcome).toBe('unreachable');
  });

  it('AC-PG-10.2: each test probes a fresh random id (random UUID / pidx), and the secret never travels in the URL or body', { timeout: T }, async () => {
    const secret = plantSecret(); const sim = khaltiSim(secret); const { db, svc } = setup({ fetch: sim });
    await put(db, svc, 'khalti', 'uat', khaltiBody(secret));
    await test(db, svc, 'khalti', 'uat'); await test(db, svc, 'khalti', 'uat');
    expect(sim.calls).toHaveLength(2);
    expect(`${sim.calls[0]!.url}${sim.calls[0]!.body}`).not.toBe(`${sim.calls[1]!.url}${sim.calls[1]!.body}`);
    for (const c of sim.calls) { noLeak(c.url, secret, 'request URL'); noLeak(c.body, secret, 'request body'); }
  });

  it('AC-PG-10.2: the test result is evidenced by the row audit only — no access-log row — and the secret reaches neither logs nor stored text', { timeout: T }, async () => {
    cap = captureOutput(); const secret = plantSecret(); const { db, svc } = setup({ fetch: khaltiSim(plantSecret('other')) });
    await put(db, svc, 'khalti', 'uat', khaltiBody(secret));
    const before = db.accessRows().length; const out = await test(db, svc, 'khalti', 'uat');
    expect(db.accessRows()).toHaveLength(before);
    noLeak(JSON.stringify(out), secret, 'test response'); noLeak(db.sentText(), secret, 'SQL parameters'); noLeak(db.storedText(), secret, 'stored rows'); noLeak(JSON.stringify(db.logs), secret, 'ctx.log'); noLeak(cap.text(), secret, 'console/stdout/stderr');
  });

  it('testing a slot that does not exist for this tenant -> 404 common.not_found (another tenant\'s account is indistinguishable from absent)', { timeout: T }, async () => {
    const { db, svc } = setup(); await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()));
    lims(await rejection(test(db, svc, 'esewa', 'uat', TENANT_B)), 'common.not_found', 404);
    lims(await rejection(test(db, svc, 'khalti', 'uat')), 'common.not_found', 404);
  });
});

// ====================================================================================================== AC-PG-10.3 environment guard
describe('environment guard — AC-PG-10.3 (REQ-SEC-058/136; 08 A13 P-1)', () => {
  it('AC-PG-10.3: production deployment + environment uat -> 400 common.validation_failed, nothing stored, no access-log row, secret not echoed', { timeout: T }, async () => {
    const secret = plantSecret(); const { db, svc } = setup({ config: prodConfig() });
    for (const [g, body] of [['esewa', esewaBody(secret)], ['khalti', khaltiBody(secret)]] as const) {
      const e = await rejection(put(db, svc, g, 'uat', body)); lims(e, 'common.validation_failed', 400);
      noLeak(JSON.stringify({ m: e.message, d: e.details, errors: e.errors }), secret, 'error');
    }
    expect(db.accounts()).toHaveLength(0); expect(db.accessRows()).toHaveLength(0); noLeak(db.sentText(), secret, 'SQL parameters');
  });

  it('AC-PG-10.3: production deployment + eSewa product code EPAYTEST (the published UAT code) -> 400, even on environment production', { timeout: T }, async () => {
    const { db, svc } = setup({ config: prodConfig() });
    lims(await rejection(put(db, svc, 'esewa', 'production', esewaBody(plantSecret(), { esewa_product_code: 'EPAYTEST' }))), 'common.validation_failed', 400);
    expect(db.accounts()).toHaveLength(0);
  });

  it('production deployment accepts environment production with a real product code (and a disabled fonepay slot)', { timeout: T }, async () => {
    const { db, svc } = setup({ config: prodConfig() });
    expect((await put(db, svc, 'esewa', 'production', esewaBody(plantSecret(), { esewa_product_code: 'LABPROD01' }))).environment).toBe('production');
    expect((await put(db, svc, 'khalti', 'production', khaltiBody(plantSecret()))).environment).toBe('production');
    expect((await put(db, svc, 'fonepay', 'production', { is_enabled: false })).gateway).toBe('fonepay');
  });

  it('production deployment: a pre-existing uat row cannot be re-saved (update path is guarded too)', { timeout: T }, async () => {
    const seeded: Row = { id: '01930000-0000-7000-8000-0000000000a1', tenant_id: TENANT_A, gateway: 'khalti', environment: 'uat', is_enabled: false, api_refunds_enabled: false, version: 1, is_active: true,
      khalti_website_url: SITE, created_by: USER, updated_by: USER, created_at: new Date(), updated_at: new Date() };
    const { db, svc } = setup({ config: prodConfig(), rows: { merchant_accounts: [seeded] } });
    lims(await rejection(put(db, svc, 'khalti', 'uat', { is_enabled: false, khalti_website_url: SITE }, { expectedVersion: 1 })), 'common.validation_failed', 400);
    expect(db.accounts()[0]!.version).toBe(1);
  });

  it('non-production deployment refuses environment production (TRD §6.9) but accepts uat with EPAYTEST', { timeout: T }, async () => {
    const { db, svc } = setup({ config: uatConfig() });
    lims(await rejection(put(db, svc, 'esewa', 'production', esewaBody(plantSecret(), { esewa_product_code: 'LABPROD01' }))), 'common.validation_failed', 400);
    lims(await rejection(put(db, svc, 'khalti', 'production', khaltiBody(plantSecret()))), 'common.validation_failed', 400);
    expect(db.accounts()).toHaveLength(0);
    expect((await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret(), { esewa_product_code: 'EPAYTEST' }))).esewa_product_code).toBe('EPAYTEST');
  });
});

// ====================================================================================================== AC-PG-10.4 Fonepay
describe('Fonepay — AC-PG-10.4 stored disabled only; enabling -> 503 payments.gateway_not_available (B8)', () => {
  it('AC-PG-10.4: a disabled Fonepay account can be stored', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect(await put(db, svc, 'fonepay', 'uat', { is_enabled: false })).toMatchObject({ gateway: 'fonepay', environment: 'uat', is_enabled: false, version: 1 });
    expect(db.accounts()).toHaveLength(1);
  });

  it('AC-PG-10.4: enabling Fonepay -> 503 payments.gateway_not_available (not 400, not a raw CHECK-violation 500); the row is unchanged; no access-log row', { timeout: T }, async () => {
    const { db, svc } = setup(); await put(db, svc, 'fonepay', 'uat', { is_enabled: false });
    const before = db.accessRows().length;
    lims(await rejection(put(db, svc, 'fonepay', 'uat', { is_enabled: true }, { expectedVersion: 1 })), 'payments.gateway_not_available', 503);
    expect(db.accounts()[0]!.is_enabled).toBe(false); expect(db.accounts()[0]!.version).toBe(1); expect(db.accessRows()).toHaveLength(before);
  });

  it('AC-PG-10.4: enabling Fonepay on an absent slot -> 503 and nothing is created', { timeout: T }, async () => {
    const { db, svc } = setup();
    lims(await rejection(put(db, svc, 'fonepay', 'uat', { is_enabled: true, secret: plantSecret() })), 'payments.gateway_not_available', 503);
    expect(db.accounts()).toHaveLength(0);
  });
});

// ====================================================================================================== settings.change access log
describe('settings.change access log — field names only (TRD §5.1 / §6.9; 07-SECURITY ST-24; 08 A19 D-112)', () => {
  it('P21 create: one settings.change / payment_merchant_account row for the account id; detail holds only the changed field NAMES — no value, no secret', { timeout: T }, async () => {
    const { db, svc } = setup(); const secret = plantSecret();
    await put(db, svc, 'esewa', 'uat', esewaBody(secret));
    const rows = db.accessRows(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'settings.change', entityType: 'payment_merchant_account', entityId: db.accounts()[0]!.id, outcome: 'allowed' });
    expect(Object.keys(rows[0]!.detail)).toEqual(['fields']);
    expect(fieldsOf(rows[0]!.detail)).toEqual(expect.arrayContaining(['secret', 'is_enabled', 'esewa_product_code']));
    const text = JSON.stringify(rows[0]!.detail); noLeak(text, secret, 'detail'); expect(text).not.toContain(CODE); expect(text).not.toContain(secretFingerprint(secret));
  });

  it('P21 update: only the CHANGED names are logged (is_enabled changed, secret omitted, product code unchanged -> exactly ["is_enabled"]); a secret replacement logs "secret" but never its value', { timeout: T }, async () => {
    const { db, svc } = setup(); await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()));
    await put(db, svc, 'esewa', 'uat', { is_enabled: false, esewa_product_code: CODE }, { expectedVersion: 1 });
    expect(fieldsOf(db.accessRows()[1]!.detail)).toEqual(['is_enabled']);
    const s2 = plantSecret(); await put(db, svc, 'esewa', 'uat', { is_enabled: false, esewa_product_code: CODE, secret: s2 }, { expectedVersion: 2 });
    expect(fieldsOf(db.accessRows()[2]!.detail)).toEqual(['secret']); noLeak(JSON.stringify(db.accessRows()), s2, 'access log');
  });

  it('a rejected save (400 / 503 / 409) writes no access-log row', { timeout: T }, async () => {
    const { db, svc } = setup();
    await rejection(put(db, svc, 'esewa', 'uat', { is_enabled: true })); await rejection(put(db, svc, 'fonepay', 'uat', { is_enabled: true })); await rejection(put(db, svc, 'esewa', 'uat', { is_enabled: false, bogus: 1 }));
    expect(db.accessRows()).toHaveLength(0);
  });

  it('P23: updatePaymentSettings writes settings.change / payment_settings with the changed field names only (never the new values)', { timeout: T }, async () => {
    const { db, svc } = setup();
    await putSettings(db, svc, { refund_two_person_threshold_paisa: 5000000, purchase_order_label: 'Planted Label 91', reconciliation_enabled: true });
    const rows = db.accessRows(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'settings.change', entityType: 'payment_settings', outcome: 'allowed' });
    expect(Object.keys(rows[0]!.detail)).toEqual(['fields']);
    const f = fieldsOf(rows[0]!.detail); expect(f).toEqual(expect.arrayContaining(['refund_two_person_threshold_paisa', 'purchase_order_label'])); expect(f).not.toContain('reconciliation_enabled'); // equals the default: not changed
    const text = JSON.stringify(rows[0]!.detail); expect(text).not.toContain('Planted Label 91'); expect(text).not.toContain('5000000');
  });

  it('P23: a second PUT changing one field logs exactly that name', { timeout: T }, async () => {
    const { db, svc } = setup(); const first = await putSettings(db, svc, { refund_two_person_threshold_paisa: 100, purchase_order_label: 'Lab payment', reconciliation_enabled: true });
    await putSettings(db, svc, { refund_two_person_threshold_paisa: 100, purchase_order_label: 'Lab payment', reconciliation_enabled: false }, { expectedVersion: first.version });
    expect(fieldsOf(db.accessRows()[1]!.detail)).toEqual(['reconciliation_enabled']);
  });

  it('P23: threshold stored as bigint arrives from node-pg as a string — an unchanged value is not logged, a changed one is', { timeout: T }, async () => {
    const seeded = { tenant_id: TENANT_A, refund_two_person_threshold_paisa: '250000', purchase_order_label: 'Lab payment', reconciliation_enabled: true, version: 1, is_active: true, created_at: NOW, updated_at: NOW, created_by: USER, updated_by: USER };
    const { db, svc } = setup({ rows: { settings: [seeded] } });
    await putSettings(db, svc, { refund_two_person_threshold_paisa: 250000, purchase_order_label: 'Lab payment', reconciliation_enabled: false }, { expectedVersion: 1 });
    expect(fieldsOf(db.accessRows()[0]!.detail)).toEqual(['reconciliation_enabled']);
    await putSettings(db, svc, { refund_two_person_threshold_paisa: 300000, purchase_order_label: 'Lab payment', reconciliation_enabled: false }, { expectedVersion: 2 });
    expect(fieldsOf(db.accessRows()[1]!.detail)).toEqual(['refund_two_person_threshold_paisa']);
  });

  it('reads (P20 list, P23 get) write no access-log row and no data-changing SQL', { timeout: T }, async () => {
    const { db, svc } = setup(); await put(db, svc, 'esewa', 'uat', esewaBody(plantSecret()));
    const mark = db.stmts.length; const rowsBefore = db.accessRows().length;
    await list(db, svc); await getSettings(db, svc);
    expect(db.accessRows()).toHaveLength(rowsBefore);
    expect(db.stmts.slice(mark).filter((s) => !/^\s*select\b/i.test(s.text))).toEqual([]);
  });
});

// ====================================================================================================== P23 settings, lazy row (A17 P-22)
describe('payment settings (P23) — lazy singleton row (08 A17 P-22)', () => {
  const DEFAULT_DTO = { refund_two_person_threshold: { amount_paisa: 0, currency: 'NPR' }, purchase_order_label: 'Lab payment', reconciliation_enabled: true, version: 1 };

  it('a read that finds no row returns the TRD defaults (threshold 0, "Lab payment", reconciliation on, version 1) and does not fail', { timeout: T }, async () => {
    const { db, svc } = setup(); expect(db.settings()).toHaveLength(0);
    expect(await getSettings(db, svc)).toEqual(DEFAULT_DTO);
  });

  it('P-22: the first PUT creates the row lazily with INSERT … ON CONFLICT (tenant_id) DO NOTHING (no seed row exists before) and returns the saved values', { timeout: T }, async () => {
    const { db, svc } = setup(); expect(db.settings()).toHaveLength(0);
    const out = await putSettings(db, svc, { refund_two_person_threshold_paisa: 250000, purchase_order_label: 'Nepal Lab, Lalitpur (A&B)', reconciliation_enabled: false });
    expect(out).toEqual({ refund_two_person_threshold: { amount_paisa: 250000, currency: 'NPR' }, purchase_order_label: 'Nepal Lab, Lalitpur (A&B)', reconciliation_enabled: false, version: expect.any(Number) });
    expect(db.settings()).toHaveLength(1); expect(db.settings()[0]).toMatchObject({ tenant_id: TENANT_A, refund_two_person_threshold_paisa: 250000, reconciliation_enabled: false });
    expect(db.stmts.some((s) => /insert\s+into\s+payments\.settings[\s\S]*on\s+conflict[\s\S]*do\s+nothing/i.test(s.text))).toBe(true);
    expect(await getSettings(db, svc)).toEqual(out);
  });

  it('P-22: the first PUT may carry If-Match of the default version (1) or none; later PUTs: none -> 428, stale -> 409, matching -> version + 1', { timeout: T }, async () => {
    const body = { refund_two_person_threshold_paisa: 1, purchase_order_label: 'Lab payment', reconciliation_enabled: true };
    const a = setup(); const first = await putSettings(a.db, a.svc, body, { expectedVersion: 1 });
    const b = setup(); await putSettings(b.db, b.svc, body);
    lims(await rejection(putSettings(a.db, a.svc, { ...body, refund_two_person_threshold_paisa: 2 })), 'common.precondition_required', 428);
    lims(await rejection(putSettings(a.db, a.svc, { ...body, refund_two_person_threshold_paisa: 2 }, { expectedVersion: first.version + 5 })), 'common.version_conflict', 409);
    expect((await putSettings(a.db, a.svc, { ...body, refund_two_person_threshold_paisa: 2 }, { expectedVersion: first.version })).version).toBe(first.version + 1);
    expect(a.db.settings()[0]!.refund_two_person_threshold_paisa).toBe(2);
  });

  it('two first-time writers of the same tenant do not collide on the primary key (the second sees the row and needs If-Match -> 428, never a 23505 / 500)', { timeout: T }, async () => {
    const { db, svc } = setup(); const body = { refund_two_person_threshold_paisa: 1, purchase_order_label: 'Lab payment', reconciliation_enabled: true };
    await putSettings(db, svc, body);
    const e = await rejection(putSettings(db, svc, body)); expect(isLimsError(e)).toBe(true); expect([409, 428]).toContain(e.statusCode);
    expect(db.settings()).toHaveLength(1);
  });

  it('settings are per tenant: tenant B still reads defaults after tenant A saved', { timeout: T }, async () => {
    const { db, svc } = setup(); await putSettings(db, svc, { refund_two_person_threshold_paisa: 999, purchase_order_label: 'Tenant A Lab', reconciliation_enabled: false });
    expect(await getSettings(db, svc, TENANT_B)).toEqual(DEFAULT_DTO);
  });

  it.each([
    ['negative threshold', { refund_two_person_threshold_paisa: -1 }], ['fractional threshold', { refund_two_person_threshold_paisa: 1.5 }], ['string threshold', { refund_two_person_threshold_paisa: '100' }],
    ['unsafe-integer threshold', { refund_two_person_threshold_paisa: 2 ** 60 }], ['empty label', { purchase_order_label: '' }], ['51-char label', { purchase_order_label: 'L'.repeat(51) }],
    ['label with markup', { purchase_order_label: '<script>alert(1)</script>' }], ['label with a dollar sign', { purchase_order_label: 'Lab $$$' }], ['label with newline', { purchase_order_label: 'Lab\nPayment' }],
    ['non-boolean reconciliation_enabled', { reconciliation_enabled: 'false' }], ['unknown field', { surprise: 1 }], ['mass-assigned version', { version: 9 }], ['mass-assigned tenant_id', { tenant_id: TENANT_B }],
  ])('settings validation: %s -> 400, nothing written, no access-log row', { timeout: T }, async (_n, bad) => {
    const { db, svc } = setup();
    validation400(await rejection(putSettings(db, svc, { refund_two_person_threshold_paisa: 0, purchase_order_label: 'Lab payment', reconciliation_enabled: true, ...bad })));
    expect(db.settings()).toHaveLength(0); expect(db.accessRows()).toHaveLength(0);
  });

  it('accepts the boundary values: threshold 0, a 50-character label', { timeout: T }, async () => {
    const { db, svc } = setup(); const label = 'L'.repeat(50);
    expect((await putSettings(db, svc, { refund_two_person_threshold_paisa: 0, purchase_order_label: label, reconciliation_enabled: true })).purchase_order_label).toBe(label);
  });
});
