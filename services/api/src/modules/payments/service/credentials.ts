// PG-T03 — KEK load, AES-256-GCM encrypt/decrypt, fingerprint, SecretHandle (TRD §6.9, §2).
// Only file that sees clear gateway secrets. No logging here: errors are generic and carry no key/secret material.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';

export interface Kek { readonly activeId: string; readonly keys: ReadonlyMap<string, Buffer> }
export interface SecretAad { readonly tenantId: string; readonly gateway: string; readonly environment: string; readonly merchantAccountId: string }
export interface StoredSecret { ciphertext: Buffer; nonce: Buffer; authTag: Buffer; kekId: string; fingerprint?: string }

const KEK_ID = /^[A-Za-z0-9_-]{1,32}$/; // matches secret_kek_id CHECK (05-SCHEMA)
const NONCE_LEN = 12;
const TAG_LEN = 16;

const key32 = (b64: unknown): Buffer => {
  if (typeof b64 !== 'string') throw new Error('KEK file invalid');
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32 || k.toString('base64') !== b64) throw new Error('KEK file invalid'); // canonical base64, 32 bytes
  return k;
};

/** Load KEK file `{ keys: { id: base64(32) }, active: id }`. Fails closed; never echoes key material. */
export function loadKek(path: string): Kek {
  let doc: { keys?: unknown; active?: unknown };
  try { doc = JSON.parse(readFileSync(path, 'utf8')) as typeof doc; } catch { throw new Error('KEK file unreadable'); }
  const { keys, active } = doc ?? {};
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys) || typeof active !== 'string') throw new Error('KEK file invalid');
  const map = new Map<string, Buffer>();
  for (const [id, v] of Object.entries(keys)) {
    if (!KEK_ID.test(id)) throw new Error('KEK file invalid');
    map.set(id, key32(v));
  }
  if (!map.has(active)) throw new Error('KEK file invalid');
  return { activeId: active, keys: map };
}

export const secretFingerprint = (plaintext: string): string => createHash('sha256').update(plaintext).digest('hex').slice(0, 8);

// AAD = tenant_id|gateway|environment|merchant_account_id; '|' or empty in a field would make the split ambiguous.
const aadBytes = (a: SecretAad): Buffer => {
  const f = [a.tenantId, a.gateway, a.environment, a.merchantAccountId];
  if (f.some((x) => typeof x !== 'string' || x === '' || x.includes('|'))) throw new Error('credential AAD invalid');
  return Buffer.from(f.join('|'), 'utf8');
};

export function encryptSecret(kek: Kek, plaintext: string, aad: SecretAad): Required<StoredSecret> {
  if (typeof plaintext !== 'string' || plaintext === '') throw new Error('secret empty');
  const key = kek.keys.get(kek.activeId);
  if (!key) throw new Error('KEK unavailable');
  const nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  c.setAAD(aadBytes(aad));
  const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { ciphertext, nonce, authTag: c.getAuthTag(), kekId: kek.activeId, fingerprint: secretFingerprint(plaintext) };
}

/** Opaque holder passed to adapters; the clear secret is reachable only via use(fn). */
export class SecretHandle {
  readonly #secret: string;
  constructor(secret: string) { this.#secret = secret; }
  async use<T>(fn: (secret: string) => T | Promise<T>): Promise<T> { return fn(this.#secret); }
  toJSON(): string { return '[SecretHandle]'; }
  toString(): string { return '[SecretHandle]'; }
  [inspect.custom](): string { return '[SecretHandle]'; }
}

export function openSecret(kek: Kek, stored: StoredSecret, aad: SecretAad): SecretHandle {
  const key = kek.keys.get(stored.kekId);
  const fail = (): never => { throw new Error('credential decrypt failed'); };
  if (!key || stored.nonce.length !== NONCE_LEN || stored.authTag.length !== TAG_LEN) return fail();
  try {
    const d = createDecipheriv('aes-256-gcm', key, stored.nonce, { authTagLength: TAG_LEN });
    d.setAAD(aadBytes(aad));
    d.setAuthTag(stored.authTag);
    return new SecretHandle(Buffer.concat([d.update(stored.ciphertext), d.final()]).toString('utf8'));
  } catch { return fail(); }
}
