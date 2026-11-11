// PG-T03 — credentials.ts (TRD §6.9, §2 rules; 07-SECURITY REQ-SEC-058/128, AB ciphertext-swap row; AC-PG-10.1).
// Assumed seams (tester; writer may dispute via notes): service/credentials.ts exports
//   loadKek(path) -> Kek                         (KEK file JSON { keys: { id: base64(32) }, active: id }; fails closed, never echoes key material)
//   encryptSecret(kek, plaintext, aad) -> { ciphertext, nonce, authTag: Buffer; kekId: string; fingerprint: string }
//   openSecret(kek, stored, aad) -> SecretHandle (throws on wrong AAD / unknown kek id / tampering)
//   SecretHandle.use(fn) -> Promise of fn's result (the only way to read the clear secret)
//   secretFingerprint(plaintext) -> first 8 hex of sha256
// aad = { tenantId, gateway, environment, merchantAccountId }, bound as `tenant_id|gateway|environment|merchant_account_id`.
// All data synthetic: the secret below is a planted marker, the KEKs are random bytes generated per run.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../../../../../../packages/shared-ts/src/logger/index.js';
import { encryptSecret, loadKek, openSecret, secretFingerprint } from '../../../service/credentials.js';

const PLANT = 'PLANTED-esewa-secret-8gG3zQ91xYkLm'; // synthetic marker; must never reach logs/errors/serialisations
const dir = mkdtempSync(join(tmpdir(), 'lims-pg-t03-'));
const b64 = (): string => randomBytes(32).toString('base64');
const K1 = b64(), K2 = b64();
const kekFile = (doc: unknown, name = `kek-${randomBytes(4).toString('hex')}.json`): string => {
  const p = join(dir, name); writeFileSync(p, typeof doc === 'string' ? doc : JSON.stringify(doc)); return p;
};
const KEK_PATH = kekFile({ keys: { k1: K1, k2: K2 }, active: 'k1' });
const AAD = { tenantId: '0194a1b2-0000-7000-8000-000000000001', gateway: 'esewa', environment: 'uat', merchantAccountId: '0194a1b2-0000-7000-8000-0000000000aa' } as const;
const fails = async (p: () => unknown): Promise<Error> => { try { await p(); } catch (e) { return e as Error; } throw new Error('expected failure, got success'); };
const open = (kek: ReturnType<typeof loadKek>, s: ReturnType<typeof encryptSecret>, aad: Record<string, string> = AAD) => openSecret(kek, s, aad as typeof AAD);

describe('loadKek — fails closed', () => {
  it('loads a valid file', () => { expect(() => loadKek(KEK_PATH)).not.toThrow(); });
  it.each([
    ['missing file', () => join(dir, 'nope.json')],
    ['not JSON', () => kekFile('{{{ not json')],
    ['no keys object', () => kekFile({ active: 'k1' })],
    ['active id not in keys', () => kekFile({ keys: { k1: K1 }, active: 'zz' })],
    ['active key not base64', () => kekFile({ keys: { k1: '!!!not-base64!!!' }, active: 'k1' })],
    ['active key 31 bytes', () => kekFile({ keys: { k1: randomBytes(31).toString('base64') }, active: 'k1' })],
    ['active key 33 bytes', () => kekFile({ keys: { k1: randomBytes(33).toString('base64') }, active: 'k1' })],
  ])('rejects: %s, error carries no key material', (_n, mk) => {
    const p = mk();
    let msg = '';
    try { loadKek(p); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe('');
    for (const k of [K1, K2]) expect(msg).not.toContain(k);
  });
});

describe('encryptSecret / openSecret — AES-256-GCM with AAD (AC-PG-10.1)', () => {
  const kek = loadKek(KEK_PATH);

  it('round-trips through SecretHandle.use', async () => {
    const s = encryptSecret(kek, PLANT, AAD);
    expect(await open(kek, s).use((v) => v)).toBe(PLANT);
  });
  it('use() returns async results and propagates rejections unchanged', async () => {
    const h = open(kek, encryptSecret(kek, PLANT, AAD));
    expect(await h.use(async (v) => v.length)).toBe(PLANT.length);
    const e = await fails(() => h.use(async () => { throw new Error('adapter boom'); }));
    expect(e.message).toBe('adapter boom');
  });
  it('stores ciphertext (not plaintext), 96-bit nonce, 16-byte tag, active kek id', () => {
    const s = encryptSecret(kek, PLANT, AAD);
    expect(s.nonce).toHaveLength(12);
    expect(s.authTag).toHaveLength(16);
    expect(s.ciphertext).toHaveLength(Buffer.byteLength(PLANT));
    expect(s.ciphertext.includes(Buffer.from(PLANT))).toBe(false);
    expect(s.kekId).toBe('k1');
  });
  it('fresh random nonce every time (200 encryptions, no repeat; ciphertexts differ)', () => {
    const rows = Array.from({ length: 200 }, () => encryptSecret(kek, PLANT, AAD));
    expect(new Set(rows.map((r) => r.nonce.toString('hex'))).size).toBe(200);
    expect(new Set(rows.map((r) => r.ciphertext.toString('hex'))).size).toBe(200);
  });
  it('fingerprint = first 8 hex of sha256(secret), returned by encrypt and by secretFingerprint', () => {
    const want = createHash('sha256').update(PLANT).digest('hex').slice(0, 8);
    expect(secretFingerprint(PLANT)).toBe(want);
    expect(encryptSecret(kek, PLANT, AAD).fingerprint).toBe(want);
    expect(want).toMatch(/^[0-9a-f]{8}$/);
  });

  it.each([
    ['tenantId', { tenantId: '0194a1b2-0000-7000-8000-000000000002' }],
    ['gateway', { gateway: 'khalti' }],
    ['environment', { environment: 'production' }],
    ['merchantAccountId', { merchantAccountId: '0194a1b2-0000-7000-8000-0000000000bb' }],
  ])('wrong AAD (%s) fails closed — no handle, no secret in error', async (_f, delta) => {
    const s = encryptSecret(kek, PLANT, AAD);
    const e = await fails(() => open(kek, s, { ...AAD, ...delta }));
    expect(e.message).not.toContain(PLANT);
  });
  it('ciphertext swapped from another merchant account row is refused (07-SECURITY: AAD binds row)', async () => {
    const other = { ...AAD, merchantAccountId: '0194a1b2-0000-7000-8000-0000000000cc' };
    const rowB = encryptSecret(kek, 'another-synthetic-secret', other);
    await fails(() => open(kek, rowB, AAD)); // presented as row A
    expect(await open(kek, rowB, other).use((v) => v)).toBe('another-synthetic-secret'); // still opens as itself
  });
  it('AAD delimiter ambiguity: a different field split cannot open the row', async () => {
    const s = encryptSecret(kek, PLANT, { ...AAD, gateway: 'esewa', environment: 'uat' });
    await fails(() => open(kek, s, { ...AAD, gateway: 'esewa|uat', environment: '' }));
  });
  it('wrong KEK fails closed (same id, different bytes)', async () => {
    const s = encryptSecret(kek, PLANT, AAD);
    const other = loadKek(kekFile({ keys: { k1: b64() }, active: 'k1' }));
    const e = await fails(() => open(other, s));
    expect(e.message).not.toContain(PLANT);
  });
  it('unknown secret_kek_id fails closed', async () => {
    const s = encryptSecret(kek, PLANT, AAD);
    await fails(() => open(kek, { ...s, kekId: 'gone' }));
  });
  it.each(['ciphertext', 'nonce', 'authTag'] as const)('tampered %s fails closed', async (field) => {
    const s = encryptSecret(kek, PLANT, AAD);
    const t = Buffer.from(s[field]); t[0] = (t[0] ?? 0) ^ 0x01;
    await fails(() => open(kek, { ...s, [field]: t }));
  });
  it('rotation: row under old kek id still opens while the old key stays in the file; new writes use the active id', async () => {
    const old = loadKek(kekFile({ keys: { k1: K1, k2: K2 }, active: 'k1' }));
    const row = encryptSecret(old, PLANT, AAD);
    const rotated = loadKek(kekFile({ keys: { k1: K1, k2: K2 }, active: 'k2' }));
    expect(await open(rotated, row).use((v) => v)).toBe(PLANT);
    expect(encryptSecret(rotated, PLANT, AAD).kekId).toBe('k2');
  });
  it('rejects an empty secret', () => { expect(() => encryptSecret(kek, '', AAD)).toThrow(); });
});

describe('SecretHandle never serialises the secret', () => {
  const kek = loadKek(KEK_PATH);
  const h = open(kek, encryptSecret(kek, PLANT, AAD));
  it.each([
    ['JSON.stringify', () => JSON.stringify(h)],
    ['String()', () => String(h)],
    ['template literal', () => `${h as unknown as string}`],
    ['util.inspect (depth 10, showHidden)', () => inspect(h, { depth: 10, showHidden: true })],
    ['own property dump', () => JSON.stringify(Object.getOwnPropertyNames(h).map((k) => String((h as unknown as Record<string, unknown>)[k])))],
    ['structured logger field', () => JSON.stringify({ secret: h })],
  ])('%s has no plaintext', (_n, f) => { expect(f()).not.toContain(PLANT); });
});

describe('planted-secret log scan (AC-PG-10.1: no log, metric or audit row contains the secret)', () => {
  it('nothing from encrypt/open/use/failure paths — incl. errors handed to the real logger — contains the plant or any KEK', async () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'api', env: 'test', version: '0', level: 'debug', destination: { write: (l: string) => { lines.push(l); } } });
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const out: string[] = [];
    const swallow = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as never);
    const errw = vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as never);
    try {
      const kek = loadKek(KEK_PATH);
      const s = encryptSecret(kek, PLANT, AAD);
      const h = open(kek, s);
      log.info('opened', { handle: h, fingerprint: s.fingerprint, row: s });
      await h.use(async (v) => { if (v !== PLANT) throw new Error('mismatch'); });
      const bad = [
        await fails(() => open(kek, s, { ...AAD, gateway: 'khalti' })),
        await fails(() => open(loadKek(kekFile({ keys: { k1: b64() }, active: 'k1' })), s)),
        await fails(() => open(kek, { ...s, kekId: 'gone' })),
        await fails(() => loadKek(kekFile({ keys: { k1: K1 }, active: 'zz' }))),
        await fails(() => h.use(() => { throw new Error('adapter boom'); })),
      ];
      for (const e of bad) log.error('credential failure', { err: e });
    } finally { [...spies, swallow, errw].forEach((x) => x.mockRestore()); }
    const everything = [...lines, ...out, ...spies.flatMap((s) => s.mock.calls.map((c) => inspect(c, { depth: 10 })))].join('\n');
    expect(lines.length).toBeGreaterThan(0); // the logger really ran
    expect(everything).not.toContain(PLANT);
    expect(everything).not.toContain(Buffer.from(PLANT).toString('base64'));
    expect(everything).not.toContain(Buffer.from(PLANT).toString('hex'));
    for (const k of [K1, K2]) expect(everything).not.toContain(k);
  });
  it('credentials.ts source has no console. or logger import (only place secrets are clear — TRD §2)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'service', 'credentials.ts'), 'utf8');
    expect(src).not.toMatch(/\bconsole\./);
    expect(src).not.toMatch(/from\s+['"][^'"]*logger[^'"]*['"]/);
  });
});
